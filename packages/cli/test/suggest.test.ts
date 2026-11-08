import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { createApp, type TrafficEvent } from "@agenticweb-dev/runtime";
import type { Llm } from "@agenticweb-dev/understand";
import { Project, cmdBuild, cmdInit } from "../src/index.ts";
import { loadSuggestions, markLive, refreshSuggestions, suggestionSnippet, updateSuggestion } from "../src/suggest.ts";

let sites: DemoSites;
let dir: string;
const out = { log: (_m: string) => {} };

const ask = (q: string, ok: boolean): TrafficEvent => ({ ts: new Date().toISOString(), method: "GET", path: "/ask", status: 200, ms: 3, agent: "Claude", userAgent: "Claude-User", kind: "ask", detail: q, ok });

beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-suggest-"));
  const project = new Project(dir);
  await cmdInit(project, sites.restaurant, {}, out);
  await cmdBuild(project, { llm: false }, out);
  await mkdir(project.dataDir, { recursive: true });
  const events = [ask("Do you have parking?", false), ask("do you have parking?", false), ask("Is there parking nearby?", false), ask("What time do you close on Sunday?", true), ask("Do you take walk-ins?", false)];
  await appendFile(path.join(project.dataDir, "traffic.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}, 60_000);
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

describe("unanswered questions become suggestions", () => {
  it("records unanswered questions asked through MCP too", async () => {
    const g = await new Project(dir).requireGraph();
    const events: TrafficEvent[] = [];
    const app = createApp({ graph: g, onTraffic: (e) => events.push(e) });
    await app.fetch(
      new Request("https://a.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { query: "Do you have a helipad?" } } }),
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: "mcp", detail: "Do you have a helipad?", ok: false });
  });

  it("drafts template suggestions without Claude, one per question", async () => {
    const project = new Project(dir);
    const { added } = await refreshSuggestions(project, { llm: false });
    expect(added.map((s) => s.question)).toEqual(["Do you have parking?", "Is there parking nearby?", "Do you take walk-ins?"]);
    expect(added[0]!.asked).toBe(2);
    expect(added[0]!.draft).toMatch(/\[\[fill in:/);
    // Running again doesn't duplicate.
    expect((await refreshSuggestions(project, { llm: false })).added).toHaveLength(0);
  });

  it("drafts with Claude from the site's own content, merging duplicates", async () => {
    const project = new Project(dir);
    await rm(path.join(project.dataDir, "suggestions.json"), { force: true });
    let seen = "";
    const llm: Llm = {
      async extract(args) {
        seen = args.content;
        return args.schema.parse({
          suggestions: [
            { question: "Is there parking?", covers: ["Do you have parking?", "Is there parking nearby?"], draft: "Street parking is free after 6pm. [[fill in: nearest garage]]", pageSlug: "nope", missingFacts: ["nearest garage"] },
            { question: "Do you take walk-ins?", covers: [], draft: "Yes, when tables are free.", pageSlug: "book", missingFacts: [] },
          ],
        });
      },
    };
    const { added } = await refreshSuggestions(project, { llm });
    expect(seen).toContain("Do you take walk-ins?");
    expect(seen).toContain("<content source=");
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ question: "Is there parking?", asked: 3, draftedBy: "claude", covers: ["Do you have parking?", "Is there parking nearby?"] });
    expect(added[0]!.page).toBeDefined();
  });

  it("won't approve a draft with blanks; approved answers come with HTML for the site", async () => {
    const project = new Project(dir);
    const [parking] = await loadSuggestions(project);
    await expect(updateSuggestion(project, parking!.id, { status: "approved" })).rejects.toThrow(/fill in/);
    const s = await updateSuggestion(project, parking!.id, { question: "Where can I park a bicycle?", draft: "Bike racks are by the patio entrance.", status: "approved" });
    expect(s.status).toBe("approved");
    const html = suggestionSnippet(s);
    expect(html).toContain("<h3>Where can I park a bicycle?</h3>");
    expect(html).toContain('"@type":"FAQPage"');

    // Once the answer is on the human site, the build picks it up and the suggestion is live.
    const g = await project.requireGraph();
    const onSite = { ...g, pages: [...g.pages, { ...g.pages[0]!, slug: "faq", markdown: "## Where can I park a bicycle?\nBike racks are by the patio entrance." }] };
    expect(markLive(await loadSuggestions(project), onSite).find((x) => x.id === s.id)!.status).toBe("live");
    expect(markLive(await loadSuggestions(project), g).find((x) => x.id === s.id)!.status).toBe("approved");
  });
});
