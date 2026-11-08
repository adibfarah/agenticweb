import type { SiteGraph } from "@agenticweb-dev/core";

/**
 * A2A-style agent card (/.well-known/agent-card.json) so other agents can discover this site as an agent.
 * Field names follow the A2A AgentCard shape; check the current A2A spec version before relying on it.
 */
export function buildAgentCard(g: SiteGraph, baseUrl: string): Record<string, unknown> {
  return {
    name: g.site.name,
    description: g.site.description || `Agent interface for ${g.site.url}`,
    url: baseUrl ? `${baseUrl.replace(/\/$/, "")}/mcp` : "/mcp",
    provider: { organization: g.site.name, url: g.site.url },
    version: g.generatedAt.slice(0, 10),
    documentationUrl: baseUrl ? `${baseUrl.replace(/\/$/, "")}/llms.txt` : "/llms.txt",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/markdown"],
    skills: [
      { id: "ask", name: "Answer questions", description: `Answers questions about ${g.site.name} with sources.`, tags: ["qa", "search"] },
      ...g.actions.map((a) => ({ id: a.name, name: a.name.replace(/_/g, " "), description: a.description, tags: [a.kind, `confirmation:${a.confirmation}`] })),
    ],
  };
}
