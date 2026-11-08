import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { Project, cmdActions, cmdBuild, cmdInit } from "../src/index.ts";
import { cmdConnect } from "../src/connect.ts";
import { deployRuntime, requiredEnv } from "../src/deploy-runtime.ts";

let sites: DemoSites;
let dir: string;
const out = { log: (_m: string) => {} };

beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-shop-"));
  const project = new Project(dir);
  await cmdInit(project, sites.shop, {}, out);
  await cmdConnect(project, ["shopify", `store=${sites.shop}`], out);
  await cmdBuild(project, { llm: false }, out);
  await cmdActions(project, "enable", "create_checkout_link", out);
  await cmdBuild(project, { llm: false }, out);
}, 60_000);
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

describe("connectors in the CLI", () => {
  it("pulls Shopify products and actions into the build", async () => {
    const g = await new Project(dir).requireGraph();
    expect(g.entities.filter((e) => e.type === "Product" && e.source.via === "connector")).toHaveLength(4);
    expect(g.actions.find((a) => a.name === "create_checkout_link")?.enabled).toBe(true);
    expect(g.actions.find((a) => a.name === "add_to_cart")?.enabled).toBe(false); // form draft stays off
  });

  it("refuses secrets in config", async () => {
    await expect(cmdConnect(new Project(dir), ["stripe", "secret_key=sk_live_x"], out)).rejects.toThrow(/environment variable/);
  });

  it("lists the env vars a deploy needs", async () => {
    const p = new Project(dir);
    const names = requiredEnv(await p.requireGraph(), await p.config()).map(([k]) => k);
    expect(names).toContain("PUBLIC_URL");
    expect(names).not.toContain("CALCOM_API_KEY");
  });
});

describe("runtime bundles", () => {
  it("builds a Node server that runs on its own", async () => {
    await deployRuntime(new Project(dir), "docker", "", out);
    const server = path.join(dir, "agent-server", "server.mjs");
    expect(existsSync(path.join(dir, "agent-server", "Dockerfile"))).toBe(true);
    // The bundled libraries' licenses travel with the runtime.
    const notices = await readFile(path.join(dir, "agent-server", "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("## hono ");
    expect(notices).toContain("MIT License");
    const graphFile = await readFile(path.join(dir, "agent-server", "site-graph.json"), "utf8");
    expect(graphFile).not.toContain('"token"');

    const port = 18000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", LOG_TRAFFIC: "0", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        let err = "";
        child.stdout.on("data", (d: Buffer) => d.toString().includes("running on") && resolve());
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("exit", (code) => reject(new Error(`server exited ${code}: ${err}`)));
      });
      const base = `http://127.0.0.1:${port}`;
      const manifest = (await (await fetch(`${base}/.well-known/agent-site.json`)).json()) as { actions: Array<{ name: string }> };
      expect(manifest.actions.map((a) => a.name)).toEqual(["create_checkout_link"]);
      const r = await fetch(`${base}/api/create_checkout_link`, { method: "POST", body: JSON.stringify({ items: [{ sku: "50014", quantity: 1 }] }) });
      const body = (await r.json()) as { checkout_url: string };
      expect(body.checkout_url, JSON.stringify(body)).toBe(`${sites.shop}/cart/50014:1`);
    } finally {
      child.kill();
    }
  }, 60_000);

  it("builds a Cloudflare Worker bundle", async () => {
    await deployRuntime(new Project(dir), "cloudflare-worker", "", out);
    const worker = path.join(dir, "agent-worker", "worker.js");
    expect(await readFile(path.join(dir, "agent-worker", "wrangler.toml"), "utf8")).toContain('main = "worker.js"');
    // Workers run standard Request/Response code, so the bundle also runs in Node for a smoke test.
    const mod = (await import(pathToFileURL(worker).href)) as { default: { fetch: (r: Request, env: Record<string, unknown>) => Promise<Response> } };
    const res = await mod.default.fetch(new Request("https://agents.shop.test/ask?q=hoodie"), {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toMatch(/Hoodie/);
  }, 60_000);

  it("builds an edge Worker that sits in front of the site", async () => {
    await deployRuntime(new Project(dir), "edge", "", out);
    const toml = await readFile(path.join(dir, "agent-edge", "wrangler.toml"), "utf8");
    expect(existsSync(path.join(dir, "agent-edge", "THIRD_PARTY_NOTICES.md"))).toBe(true);
    expect(toml).toContain("routes = [{ pattern = \"127.0.0.1/*\"");
    const worker = path.join(dir, "agent-edge", "worker.js");
    const mod = (await import(pathToFileURL(worker).href)) as { default: { fetch: (r: Request, env: Record<string, unknown>) => Promise<Response> } };
    const env = { ORIGIN_URL: sites.shop };
    const llms = await mod.default.fetch(new Request("https://shop.test/llms.txt"), env);
    expect(await llms.text()).toContain("/.agent/");
    const html = await mod.default.fetch(new Request(`https://shop.test/`), env);
    expect(await html.text()).toContain('href="/.agent/.well-known/agent-site.json"');
    const checkout = await mod.default.fetch(
      new Request("https://shop.test/.agent/api/create_checkout_link", { method: "POST", body: JSON.stringify({ items: [{ sku: "50014", quantity: 1 }] }) }),
      env,
    );
    expect(((await checkout.json()) as { checkout_url: string }).checkout_url).toBe(`${sites.shop}/cart/50014:1`);
    // UCP discovery lives at the root of the store's own domain.
    const ucp = (await (await mod.default.fetch(new Request("https://shop.test/.well-known/ucp"), env)).json()) as { ucp: { services: Record<string, Array<{ endpoint: string }>> } };
    expect(ucp.ucp.services["dev.ucp.shopping"]![0]!.endpoint).toBe("https://shop.test/.agent/ucp/v1");
  }, 60_000);
});
