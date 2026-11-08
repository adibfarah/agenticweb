import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { Project, cmdActions, cmdBuild, cmdDeploy, cmdInit, cmdVisibility } from "../src/index.ts";
import { cmdReview, cmdServe } from "../src/serve.ts";

let sites: DemoSites;
let dir: string;
const logs: string[] = [];
const out = { log: (m: string) => logs.push(m) };

beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-"));
});
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

describe("cli flow", () => {
  it("init → build → enable action → rebuild → deploy", async () => {
    const project = new Project(dir);
    await cmdInit(project, sites.restaurant, {}, out);
    expect(existsSync(path.join(dir, "agenticweb.config.json"))).toBe(true);
    expect(logs.join("\n")).toContain("ownership check skipped");

    const g = await cmdBuild(project, { llm: false }, out);
    expect(g.site.name).toBe("Bella Cucina");
    expect(existsSync(path.join(dir, "agent-branch", "llms.txt"))).toBe(true);

    await cmdActions(project, "enable", "request_booking", out);
    const cfg = JSON.parse(await readFile(path.join(dir, "agenticweb.config.json"), "utf8"));
    expect(cfg.actions).toEqual([{ name: "request_booking", enabled: true }]);

    await cmdVisibility(project, true, "privacy", out);
    const g2 = await cmdBuild(project, { llm: false }, out);
    expect(g2.actions.find((a) => a.name === "request_booking")?.enabled).toBe(true);
    expect(g2.pages.find((p) => p.slug === "privacy")?.hidden).toBe(true);
    expect(existsSync(path.join(dir, "agent-branch", "pages", "privacy.md"))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(dir, "agent-branch", ".well-known", "agent-site.json"), "utf8"));
    expect(manifest.actions.map((a: { name: string }) => a.name)).toEqual(["request_booking"]);

    await cmdDeploy(project, { target: "cloudflare" }, out);
    expect(existsSync(path.join(dir, "agent-branch", "_headers"))).toBe(true);
  });

  it("serves the built branch and the review page", async () => {
    const project = new Project(dir);
    const server = await cmdServe(project, { port: 0, noLlm: true }, out);
    const ask = (await (await fetch(`${server.url}/ask?q=parking`)).json()) as { answer: string };
    expect(ask.answer).toMatch(/parking/i);
    await server.close();

    const review = await cmdReview(project, { port: 0 }, out);
    expect((await fetch(review.url)).status).toBe(200);
    expect((await fetch(review.url.replace(/\?token=.*/, "api/graph"))).status).toBe(403);
    review.close();
  });

  it("applies only the fields an owner wrote, and adds custom actions", async () => {
    const { applyActionOverrides } = await import("../src/commands.ts");
    const { ProjectConfig } = await import("@agenticweb-dev/core");
    const g = await new Project(dir).requireGraph();
    const original = g.actions.find((a) => a.name === "request_booking")!;
    const config = ProjectConfig.parse({
      site: sites.restaurant,
      actions: [
        { name: "request_booking", enabled: true },
        { name: "request_quote", description: "Ask for a catering quote.", kind: "write", backend: { type: "http", operation: "quote", config: { url: "https://example.com/q" } }, input: [{ name: "email", type: "email" }] },
      ],
    });
    const merged = applyActionOverrides(g.actions, config);
    const booking = merged.find((a) => a.name === "request_booking")!;
    expect(booking.input).toEqual(original.input);
    expect(booking.confirmation).toBe("guest");
    expect(merged.find((a) => a.name === "request_quote")).toMatchObject({ confirmation: "owner", enabled: false, source: { via: "owner" } });
  });

  it("refuses to build an unverified public site", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "agenticweb-"));
    const project = new Project(d);
    await project.saveConfig({ site: "https://example.com/" });
    await project.saveState({ verifyToken: "x" });
    await expect(cmdBuild(project, { llm: false }, out)).rejects.toThrow(/verify/);
    await rm(d, { recursive: true, force: true });
  });
});
