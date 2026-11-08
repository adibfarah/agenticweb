import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { crawl } from "@agenticweb-dev/ingest";
import { understand } from "@agenticweb-dev/understand";
import { emitAgentBranch, webMcpTools } from "@agenticweb-dev/emitters";
import { publicView, type SiteGraph } from "@agenticweb-dev/core";
import { createEdge, type ActionEngine } from "../src/index.ts";

type Tool = { name: string; description: string; inputSchema: { properties: Record<string, unknown> }; annotations?: Record<string, boolean>; execute: (input: unknown) => Promise<unknown> };

let sites: DemoSites;
let graph: SiteGraph;
const calls: Array<{ name: string; input: unknown; key?: string }> = [];
beforeAll(async () => {
  sites = await startDemoSites();
  graph = await understand(await crawl(sites.restaurant), { siteUrl: sites.restaurant });
});
afterAll(() => sites.close());

/** Runs webmcp.js the way a browser would: a page on the site, document.modelContext, fetch to the edge. */
async function loadInBrowser(api: "document" | "navigator") {
  const engine: ActionEngine = {
    actions: () => graph.actions.filter((a) => a.name === "request_booking").map((a) => ({ ...a, enabled: true })),
    call: async (name, input, ctx) => {
      calls.push({ name, input, key: ctx.idempotencyKey });
      return { id: "act_1", status: "pending_confirmation", final: false, message: "Check your email to confirm." };
    },
    status: async (id) => (id === "act_1" ? { id, status: "done", final: true, message: "Confirmed" } : undefined),
    confirm: async () => ({ ok: true, message: "" }),
    describe: async () => undefined,
  };
  const edge = createEdge({ graph, engine }, { origin: sites.restaurant });
  const script = await (await edge.fetch(new Request("https://bella.test/.agent/webmcp.js"))).text();

  const tools: Tool[] = [];
  const modelContext = { registerTool: (t: Tool, opts?: { signal?: AbortSignal }) => (tools.push(t), opts?.signal?.addEventListener("abort", () => tools.splice(0))) };
  const win: Record<string, unknown> = {};
  const fakeFetch = (input: string | URL, init?: RequestInit) => edge.fetch(new Request(String(input), init));
  const doc = { currentScript: { src: "https://bella.test/.agent/webmcp.js" }, ...(api === "document" ? { modelContext } : {}) };
  const nav = api === "navigator" ? { modelContext } : {};
  new Function("document", "navigator", "window", "location", "fetch", script)(doc, nav, win, new URL("https://bella.test/menu.html"), fakeFetch);
  return { tools, win: win as { agenticwebWebMcp: { tools: string[]; unregister: () => void } }, script };
}

describe("WebMCP", () => {
  it("is served with a JavaScript content type and listed in the manifest", async () => {
    const edge = createEdge({ graph }, { origin: sites.restaurant });
    const res = await edge.fetch(new Request("https://bella.test/.agent/webmcp.js"));
    expect(res.headers.get("content-type")).toContain("javascript");
    const manifest = (await (await edge.fetch(new Request("https://bella.test/.well-known/agent-site.json"))).json()) as { interfaces: { webmcp: { href: string } } };
    expect(manifest.interfaces.webmcp.href).toBe("/.agent/webmcp.js");
  });

  it("registers the same tools as the MCP server, with honest hints", async () => {
    const { tools, win } = await loadInBrowser("document");
    expect(tools.map((t) => t.name)).toEqual(["site_info", "get_page", "list_entities", "search", "ask", "request_booking", "get_action_status"]);
    expect(win.agenticwebWebMcp.tools).toHaveLength(7);
    const booking = tools.find((t) => t.name === "request_booking")!;
    expect(booking.annotations).toEqual({ consequentialHint: true });
    expect(tools.find((t) => t.name === "ask")!.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(Object.keys(booking.inputSchema.properties)).toContain("party_size");
  });

  it("tools call the agent branch and return its answers", async () => {
    const { tools } = await loadInBrowser("document");
    const run = (name: string, input: unknown) => tools.find((t) => t.name === name)!.execute(input);
    expect(((await run("ask", { query: "Are dogs allowed?" })) as { found: boolean }).found).toBe(true);
    expect(String(await run("get_page", { slug: "menu" }))).toContain("Tagliatelle");
    const items = (await run("list_entities", { type: "MenuItem", limit: 2 })) as { items: unknown[]; total: number };
    expect(items.items).toHaveLength(2);
    expect(items.total).toBeGreaterThan(2);
    await expect(run("get_page", { slug: "nope" })).rejects.toThrow(/No page/);

    const r = (await run("request_booking", { party_size: 2 })) as { status: string };
    expect(r.status).toBe("pending_confirmation");
    expect(calls.at(-1)?.key).toMatch(/.{8,}/); // every attempt carries an idempotency key
    expect(((await run("get_action_status", { id: "act_1" })) as { final: boolean }).final).toBe(true);
  });

  it("works with the older navigator.modelContext and can be removed", async () => {
    const { tools, win } = await loadInBrowser("navigator");
    expect(tools.length).toBe(7);
    win.agenticwebWebMcp.unregister();
    expect(tools.length).toBe(0);
  });

  it("does nothing in browsers without WebMCP", async () => {
    const { script } = await loadInBrowser("document");
    const win: Record<string, unknown> = {};
    new Function("document", "navigator", "window", script)({}, {}, win);
    expect(win.agenticwebWebMcp).toBeUndefined();
  });

  it("offers only file-based tools on a static deploy", () => {
    const files = emitAgentBranch(graph);
    expect(files.get("webmcp.js")).not.toContain('"name":"ask"');
    const names = webMcpTools(publicView(graph), { runtime: false, entityFiles: { MenuItem: "data/menu-items.json" } }).map((t) => t.name);
    expect(names).toEqual(["site_info", "get_page", "list_entities"]);
  });

  it("can't be broken out of a script tag", async () => {
    const tricky = { ...graph, pages: graph.pages.map((p, i) => (i === 0 ? { ...p, slug: "</script><b>x" } : p)) };
    expect(emitAgentBranch(tricky).get("webmcp.js")).not.toContain("</script>");
  });
});
