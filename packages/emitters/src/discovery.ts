import { publicView, type SiteGraph } from "@agenticweb-dev/core";

/** Snippets the owner adds to the human site so agents find the agent branch. */
export function discoverySnippets(g: SiteGraph, baseUrl: string): { head: string; robots: string; jsonLd: string } {
  const base = baseUrl.replace(/\/$/, "");
  const head = [
    `<link rel="alternate" type="application/json" href="${base}/.well-known/agent-site.json" title="Agent branch">`,
    `<link rel="alternate" type="text/markdown" href="${base}/llms.txt" title="llms.txt">`,
    // WebMCP tools for agents in the visitor's browser. Harmless in browsers without WebMCP.
    `<script src="${base}/webmcp.js" defer></script>`,
  ].join("\n");
  const robots = `# Agent branch for AI agents: ${base}/.well-known/agent-site.json\n# llms.txt: ${base}/llms.txt\n`;
  const pub = publicView(g);
  const business = pub.entities.find((e) => e.id.endsWith("#business"));
  const jsonLd = business ? `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", ...business.data })}</script>` : "";
  return { head, robots, jsonLd };
}

/** Per-page JSON-LD the owner can paste into the human site (improves SEO and agent parsing). */
export function jsonLdForPage(g: SiteGraph, pageUrl: string): string {
  const pub = publicView(g);
  const page = pub.pages.find((p) => p.url === pageUrl);
  if (!page) return "";
  const items = page.entityIds.map((id) => pub.entities.find((e) => e.id === id)).filter(Boolean);
  if (!items.length) return "";
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": items.map((e) => e!.data) })}</script>`;
}
