import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { crawl } from "@agenticweb-dev/ingest";
import { understand } from "@agenticweb-dev/understand";
import type { SiteGraph } from "@agenticweb-dev/core";
import { Asker, RateLimiter, SearchIndex, createApp, identifyAgent, type ActionEngine, type TrafficEvent } from "../src/index.ts";
import { serveNode } from "../src/node.ts";

let sites: DemoSites;
let graph: SiteGraph;
beforeAll(async () => {
  sites = await startDemoSites();
  graph = await understand(await crawl(sites.restaurant), { siteUrl: sites.restaurant });
});
afterAll(() => sites.close());

const req = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.fetch(new Request(`http://agents.test${path}`, init));

describe("search and ask", () => {
  it("finds menu items", () => {
    const hits = SearchIndex.fromGraph(graph).search("vegan pasta", { limit: 3 });
    expect(hits[0]?.title).toBe("Spaghetti aglio e olio");
  });

  it("answers from the site without a model, with sources", async () => {
    const asker = new Asker(graph);
    const r = await asker.ask("Are dogs allowed?");
    expect(r.answer).toMatch(/patio/i);
    expect(r.sources[0]).toContain("/faq.html");
    expect(r.found).toBe(true);
  });

  it("says when it doesn't know", async () => {
    const r = await new Asker(graph).ask("quantum chromodynamics lecture");
    expect(r.found).toBe(false);
  });

  it("uses the model when given, and cites what it used", async () => {
    const asker = new Asker(graph, {
      llm: { extract: async () => ({ found: true, answer: "Sundays 12:00 to 21:00.", used: [1] }) as never },
    });
    const r = await asker.ask("When do you open on Sunday?");
    expect(r.answer).toBe("Sundays 12:00 to 21:00.");
    expect(r.sources).toHaveLength(1);
  });
});

describe("http app", () => {
  it("serves agent-branch files with the right types", async () => {
    const app = createApp({ graph });
    const m = await req(app, "/.well-known/agent-site.json");
    expect(m.headers.get("content-type")).toContain("application/json");
    const manifest = (await m.json()) as { interfaces: { mcp: { href: string } } };
    expect(manifest.interfaces.mcp.href).toBe("/mcp");
    const md = await req(app, "/pages/menu.md");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("Cacio e pepe");
    expect((await req(app, "/")).status).toBe(200);
    expect((await req(app, "/nope")).status).toBe(404);
  });

  it("answers /ask and /api/search", async () => {
    const app = createApp({ graph });
    const a = await req(app, "/ask", { method: "POST", body: JSON.stringify({ query: "Is there parking?" }), headers: { "content-type": "application/json" } });
    expect(((await a.json()) as { answer: string }).answer).toMatch(/street parking/i);
    const s = (await (await req(app, "/api/search?q=tiramisu")).json()) as { results: Array<{ title: string }> };
    expect(s.results[0]?.title).toBe("Tiramisù");
    expect((await req(app, "/ask", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("returns 404 for actions when none are enabled", async () => {
    const r = await req(createApp({ graph }), "/api/request_booking", { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });

  it("routes actions to the engine", async () => {
    const engine: ActionEngine = {
      actions: () => graph.actions.filter((a) => a.name === "request_booking").map((a) => ({ ...a, enabled: true })),
      call: async (name, input) => ({ id: "act_1", status: "pending_confirmation", final: false, message: `ok ${name} ${JSON.stringify(input)}` }),
      status: async (id) => (id === "act_1" ? { id, status: "done", final: true, message: "Confirmed" } : undefined),
      confirm: async () => ({ ok: true, message: "Thanks" }),
      describe: async (t) => (t === "tok" ? { title: "Confirm your booking", details: [["Guests", "2"]], who: "guest" } : undefined),
    };
    const app = createApp({ graph, engine });
    const r = await req(app, "/api/request_booking", { method: "POST", body: JSON.stringify({ party_size: 2 }) });
    expect(r.status).toBe(202);
    expect(((await (await req(app, "/api/actions/act_1")).json()) as { status: string }).status).toBe("done");
    const manifest = (await (await req(app, "/.well-known/agent-site.json")).json()) as { actions: Array<{ name: string }> };
    expect(manifest.actions.map((a) => a.name)).toEqual(["request_booking"]);
    expect(await (await req(app, "/confirm/tok")).text()).toContain("Confirm your booking");
    expect((await req(app, "/confirm/bad")).status).toBe(404);
  });

  it("rate limits writes but not file reads", async () => {
    const app = createApp({ graph, rateLimit: 2 });
    const ask = () => req(app, "/ask?q=menu");
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(429);
    expect((await req(app, "/llms.txt")).status).toBe(200);
  });

  it("records traffic with the agent name", async () => {
    const events: TrafficEvent[] = [];
    const app = createApp({ graph, onTraffic: (e) => events.push(e) });
    await req(app, "/ask?q=hours", { headers: { "user-agent": "Claude-User/1.0" } });
    expect(events[0]).toMatchObject({ agent: "Claude", kind: "ask", detail: "hours", status: 200 });
  });

  it("identifies agents", () => {
    expect(identifyAgent("Mozilla/5.0 (compatible; GPTBot/1.1)")).toBe("OpenAI");
    expect(identifyAgent("", "acme-agent")).toBe("acme-agent");
    expect(identifyAgent("")).toBe("anonymous");
  });

  it("refills the rate limit over time", () => {
    const l = new RateLimiter(60);
    for (let i = 0; i < 60; i++) l.take("x", 0);
    expect(l.take("x", 0)).toBe(false);
    expect(l.take("x", 1_000)).toBe(true);
  });
});

describe("activity summary", () => {
  it("counts agents, questions and action outcomes", async () => {
    const { summarizeActivity } = await import("../src/index.ts");
    const ev = (o: Partial<TrafficEvent>): TrafficEvent => ({ ts: "2026-11-07T10:00:00Z", method: "GET", path: "/ask", status: 200, ms: 5, agent: "Claude", userAgent: "", kind: "ask", ...o });
    const s = summarizeActivity(
      [ev({ detail: "Parking?", ok: true }), ev({ detail: "parking?", ok: true }), ev({ agent: "OpenAI", detail: "Valet?", ok: false }), ev({ kind: "file", path: "/llms.txt", agent: "OpenAI" })],
      [
        { action: "request_booking", agent: "Claude", createdAt: "2026-11-07T10:00:00Z", result: { status: "done" } },
        { action: "request_booking", agent: "Claude", createdAt: "2026-11-07T10:05:00Z", result: { status: "expired" } },
      ],
    );
    expect(s.byAgent).toEqual([["Claude", 2], ["OpenAI", 2]]);
    expect(s.topQuestions[0]).toEqual(["Parking?", 2]);
    expect(s.unanswered).toEqual([["Valet?", 1]]);
    expect(s.topPages).toEqual([["/llms.txt", 1]]);
    expect(s.actions[0]).toMatchObject({ action: "request_booking", started: 2, done: 1, expired: 1, completionRate: 50 });
  });
});

describe("mcp over http", () => {
  it("lists tools and answers questions", async () => {
    const server = await serveNode({ graph, port: 0 });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["site_info", "search", "ask", "get_page", "list_entities", "get_entity"]));

      const items = await client.callTool({ name: "list_entities", arguments: { type: "MenuItem", limit: 2 } });
      const parsed = JSON.parse((items.content as Array<{ text: string }>)[0]!.text) as { total: number; items: unknown[] };
      expect(parsed.total).toBe(12);
      expect(parsed.items).toHaveLength(2);

      const page = await client.callTool({ name: "get_page", arguments: { slug: "faq" } });
      expect((page.content as Array<{ text: string }>)[0]!.text).toContain("cancellation");

      const bad = await client.callTool({ name: "get_page", arguments: { slug: "missing" } });
      expect(bad.isError).toBe(true);

      const res = await client.listResources();
      expect(res.resources.some((r) => r.uri === "agent-site://pages/menu")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
