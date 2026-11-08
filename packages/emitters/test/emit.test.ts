import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { crawl } from "@agenticweb-dev/ingest";
import { understand } from "@agenticweb-dev/understand";
import type { SiteGraph } from "@agenticweb-dev/core";
import { discoverySnippets, emitAgentBranch } from "../src/index.ts";

let sites: DemoSites;
let graph: SiteGraph;
beforeAll(async () => {
  sites = await startDemoSites();
  graph = await understand(await crawl(sites.restaurant), { siteUrl: sites.restaurant });
});
afterAll(() => sites.close());

describe("emitAgentBranch", () => {
  it("writes the required files", () => {
    const files = emitAgentBranch(graph);
    for (const f of [".well-known/agent-site.json", "llms.txt", "llms-full.txt", "pages/menu.md", "pages/index.md", "site-graph.json", "data/faq-pages.json"]) {
      expect(files.has(f), f).toBe(true);
    }
  });

  it("leaves out disabled actions and hidden pages", () => {
    const g = structuredClone(graph);
    g.pages.find((p) => p.slug === "privacy")!.hidden = true;
    const files = emitAgentBranch(g);
    expect(files.has("pages/privacy.md")).toBe(false);
    expect(files.has("openapi.json")).toBe(false);
    const manifest = JSON.parse(files.get(".well-known/agent-site.json")!);
    expect(manifest.actions).toEqual([]);
    expect(manifest.spec).toBe("agent-site/0.1");
  });

  it("includes enabled actions in the manifest, llms.txt and OpenAPI", () => {
    const g = structuredClone(graph);
    const booking = g.actions.find((a) => a.name === "request_booking")!;
    booking.enabled = true;
    const files = emitAgentBranch(g, { runtime: true, baseUrl: "https://agents.bella.example" });
    const manifest = JSON.parse(files.get(".well-known/agent-site.json")!);
    expect(manifest.actions[0]).toMatchObject({ name: "request_booking", confirmation: "guest" });
    expect(manifest.interfaces.mcp.href).toBe("/mcp");
    const openapi = JSON.parse(files.get("openapi.json")!);
    const op = openapi.paths["/api/request_booking"].post;
    expect(op["x-agent-confirmation"]).toBe("guest");
    expect(op.requestBody.content["application/json"].schema.required).toContain("party_size");
    expect(files.get("llms.txt")).toContain("request_booking");
    expect(files.has(".well-known/agent-card.json")).toBe(true);
  });

  it("writes pages with front matter that links back to the source", () => {
    const md = emitAgentBranch(graph).get("pages/menu.md")!;
    expect(md.startsWith("---\ntitle: \"Menu\"")).toBe(true);
    expect(md).toContain(`source: ${sites.restaurant}/menu.html`);
    expect(md).toContain("Tagliatelle al ragù");
  });

  it("puts key facts in llms.txt", () => {
    const txt = emitAgentBranch(graph).get("llms.txt")!;
    expect(txt.startsWith("# Bella Cucina")).toBe(true);
    expect(txt).toContain("Phone: +1-503-555-0100");
    expect(txt).toContain("Friday 17:00–23:00");
    expect(txt).toContain("[Menu](/pages/menu.md)");
  });

  it("does not leak the verification token", () => {
    const g = structuredClone(graph);
    g.ownership = { verified: true, method: "dns-txt", token: "secret-token", verifiedAt: "2026-11-07T00:00:00Z" };
    for (const content of emitAgentBranch(g).values()) expect(content).not.toContain("secret-token");
  });

  it("pages large entity lists", () => {
    const g = structuredClone(graph);
    const base = g.entities[0]!;
    g.entities = Array.from({ length: 7 }, (_, i) => ({ ...base, id: `x#${i}`, type: "Product", name: `P${i}` }));
    const files = emitAgentBranch(g, { pageSize: 3 });
    expect(JSON.parse(files.get("data/products.json")!).next).toBe("/data/products-2.json");
    expect(JSON.parse(files.get("data/products-3.json")!).items).toHaveLength(1);
  });

  it("makes discovery snippets", () => {
    const s = discoverySnippets(graph, "https://agents.bella.example/");
    expect(s.head).toContain('href="https://agents.bella.example/.well-known/agent-site.json"');
    expect(s.jsonLd).toContain("openingHoursSpecification");
  });
});
