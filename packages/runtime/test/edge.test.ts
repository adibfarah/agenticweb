import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { crawl } from "@agenticweb-dev/ingest";
import { understand } from "@agenticweb-dev/understand";
import type { SiteGraph } from "@agenticweb-dev/core";
import { createEdge, injectIntoHead, prefersMarkdown, type FetchHandler, type TrafficEvent } from "../src/index.ts";
import { serveNode } from "../src/node.ts";

let sites: DemoSites;
let graph: SiteGraph;
let edge: FetchHandler;
const traffic: TrafficEvent[] = [];
beforeAll(async () => {
  sites = await startDemoSites();
  graph = await understand(await crawl(sites.restaurant), { siteUrl: sites.restaurant });
  edge = createEdge({ graph, onTraffic: (e) => traffic.push(e) }, { origin: sites.restaurant });
});
afterAll(() => sites.close());

const get = (path: string, headers: Record<string, string> = {}) => edge.fetch(new Request(`https://bella.test${path}`, { headers }));
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

describe("content negotiation", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown", false],
    ["text/markdown, text/html", true],
    ["text/markdown, */*", true],
    ["text/markdown;q=0.1, */*", false],
    ["text/markdown;q=0", false],
    [BROWSER, false],
    ["*/*", false],
    ["", false],
  ])("%s → markdown: %s", (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });
});

describe("edge mode", () => {
  it("passes human pages through with discovery tags and headers", async () => {
    const res = await get("/menu.html", { accept: BROWSER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("link")).toContain("/.agent/.well-known/agent-site.json");
    expect(res.headers.get("vary")).toMatch(/accept/i);
    expect(res.headers.get("content-encoding")).toBeNull();
    const html = await res.text();
    expect(html).toMatch(/<link rel="alternate" type="text\/markdown" href="\/\.agent\/pages\/[^"]+\.md"><script src="\/\.agent\/webmcp\.js" defer><\/script><\/head>/i);
    // The page itself is unchanged apart from the tags.
    expect(html).toContain("Tagliatelle");
  });

  it("serves the same page as Markdown when asked", async () => {
    const res = await get("/menu.html", { accept: "text/markdown", "user-agent": "Claude-User/1.0" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(Number(res.headers.get("x-markdown-tokens"))).toBeGreaterThan(10);
    const md = await res.text();
    expect(md).toMatch(/^---\ntitle:/);
    expect(md).toContain("Tagliatelle");
    expect(md).not.toContain("<nav");
    expect(traffic.some((t) => t.detail?.startsWith("markdown:") && t.agent === "Claude")).toBe(true);
  });

  it("serves llms.txt and the manifest at the root, with links under the prefix", async () => {
    const llms = await (await get("/llms.txt")).text();
    expect(llms).toContain("](/.agent/pages/");
    const manifest = (await (await get("/.well-known/agent-site.json")).json()) as { content: { pages: string }; interfaces: { mcp: { href: string } } };
    expect(manifest.content.pages).toBe("/.agent/pages/");
    expect(manifest.interfaces.mcp.href).toBe("/.agent/mcp");
  });

  it("serves the whole agent branch under /.agent", async () => {
    const page = await get("/.agent/llms.txt");
    expect(page.status).toBe(200);
    const ask = (await (await get("/.agent/ask?q=Are+dogs+allowed")).json()) as { found: boolean };
    expect(ask.found).toBe(true);
    const mcp = await edge.fetch(
      new Request("https://bella.test/.agent/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("site_info");
  });

  it("adds agent-branch lines to robots.txt", async () => {
    const text = await (await get("/robots.txt")).text();
    expect(text).toMatch(/User-agent/i);
    expect(text).toContain("https://bella.test/.well-known/agent-site.json");
  });

  it("leaves non-HTML and missing pages alone", async () => {
    const missing = await get("/no-such-page", { accept: "text/markdown" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("link")).toBeNull();
  });

  it("keeps hidden pages out of Markdown", async () => {
    const hidden = { ...graph, pages: graph.pages.map((p) => (p.url.endsWith("/menu.html") ? { ...p, hidden: true } : p)) };
    const e = createEdge({ graph: hidden }, { origin: sites.restaurant });
    const res = await e.fetch(new Request("https://bella.test/menu.html", { headers: { accept: "text/markdown" } }));
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("refuses to proxy to itself", async () => {
    const res = await edge.fetch(new Request("https://bella.test/", { headers: { "x-agenticweb-edge": "1" } }));
    expect(res.status).toBe(508);
  });

  it("runs as a Node reverse proxy", async () => {
    const server = await serveNode({ graph, port: 0, edge: { origin: sites.restaurant } });
    try {
      const md = await fetch(`${server.url}/menu.html`, { headers: { accept: "text/markdown" } });
      expect(md.headers.get("content-type")).toContain("text/markdown");
      const html = await (await fetch(`${server.url}/menu.html`)).text();
      expect(html).toContain('href="/.agent/.well-known/agent-site.json"');
    } finally {
      await server.close();
    }
  });
});

describe("injectIntoHead", () => {
  const run = async (chunks: string[], tag = "<x>") => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(injectIntoHead(body, tag)).text();
  };

  it("finds </head> split across chunks", async () => {
    expect(await run(["<html><head><title>a</title></he", "ad><body>é</body></html>"])).toBe("<html><head><title>a</title><x></head><body>é</body></html>");
  });
  it("falls back to <body> when there is no head", async () => {
    expect(await run(["<p>hi</p><body class=a>ok"])).toBe("<p>hi</p><x><body class=a>ok");
  });
  it("leaves a page without either alone", async () => {
    expect(await run(["just text"])).toBe("just text");
  });
  it("keeps multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("<head>ü</head>");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    expect(await new Response(injectIntoHead(body, "<x>")).text()).toBe("<head>ü<x></head>");
  });
});
