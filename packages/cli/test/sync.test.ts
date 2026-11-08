import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { restaurant } from "@agenticweb-dev/examples/restaurant";
import { Project, cmdBuild, cmdInit } from "../src/index.ts";
import { cmdServe } from "../src/serve.ts";
import { cmdCi, cmdSync, diffGraphs, loadActivity } from "../src/sync.ts";

let sites: DemoSites;
let dir: string;
const logs: string[] = [];
const out = { log: (m: string) => logs.push(m) };

beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-sync-"));
  await cmdInit(new Project(dir), sites.restaurant, {}, out);
  await cmdBuild(new Project(dir), { llm: false }, out);
});
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

describe("sync", () => {
  it("reports what changed on the live site", async () => {
    const pizza = restaurant.menu.find((m) => m.name === "Margherita")!;
    pizza.price = 17;
    restaurant.menu.push({ section: "Dolci", name: "Panna cotta", price: 8, description: "Vanilla cream, berries.", diet: ["vegetarian"], allergens: ["dairy"] });
    const { diff, graph } = await cmdSync(new Project(dir), { llm: false }, out);
    expect(diff.entities.changed).toContainEqual({ name: "Margherita", fields: ["offers"] });
    expect(diff.entities.added).toContain("Panna cotta");
    expect(diff.pages.changed).toContain("menu");
    expect(graph.entities.find((e) => e.name === "Margherita")?.data.offers).toMatchObject({ price: "17" });
    expect(logs.join("\n")).toContain("Changed items: Margherita (offers)");
    expect(existsSync(path.join(dir, ".agenticweb", "changes.jsonl"))).toBe(true);
  });

  it("diffs a first build as all new", () => {
    const d = diffGraphs(undefined, { ...JSON.parse("{}"), generatedAt: "t", pages: [], entities: [], actions: [{ name: "a" }] });
    expect(d.actions.added).toEqual(["a"]);
  });
});

describe("live refresh and activity", () => {
  it("refreshes through the webhook and records traffic", async () => {
    const server = await cmdServe(new Project(dir), { port: 0, noLlm: true, hookSecret: "s3cret" }, out);
    try {
      const wrong = await fetch(`${server.url}/hooks/refresh`, { method: "POST", headers: { "x-agenticweb-secret": "nope" } });
      expect(wrong.status).toBe(401);

      restaurant.menu.find((m) => m.name === "Tiramisù")!.price = 11;
      const ok = await fetch(`${server.url}/hooks/refresh`, { method: "POST", headers: { "x-agenticweb-secret": "s3cret" } });
      expect(ok.status).toBe(202);
      await server.refresh(); // wait for the in-flight refresh

      const res = await fetch(`${server.url}/ask?q=tiramisu price`, { headers: { "user-agent": "Claude-User" } });
      expect(res.headers.get("x-agent-branch-updated")).toBeTruthy();
      expect(((await res.json()) as { answer: string }).answer).toContain("11");
      await fetch(`${server.url}/ask?q=do you sell spaceships`, { headers: { "user-agent": "GPTBot" } });
      await fetch(`${server.url}/llms.txt`);
    } finally {
      await server.close();
    }
    await new Promise((r) => setTimeout(r, 100)); // let the traffic log flush
    const s = await loadActivity(new Project(dir));
    expect(s.byAgent.map(([a]) => a)).toEqual(expect.arrayContaining(["Claude", "OpenAI"]));
    expect(s.unanswered.map(([q]) => q)).toContain("do you sell spaceships");
    expect(s.topQuestions.length).toBeGreaterThanOrEqual(2);
  });

  it("writes a scheduled GitHub Actions workflow", async () => {
    await cmdCi(new Project(dir), { every: "6", target: "cloudflare" }, out);
    const wf = await readFile(path.join(dir, ".github", "workflows", "agenticweb-sync.yml"), "utf8");
    expect(wf).toContain('cron: "17 */6 * * *"');
    expect(wf).toContain("wrangler pages deploy agent-branch");
  });
});
