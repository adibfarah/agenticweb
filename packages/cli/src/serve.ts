import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createReviewApp } from "@agenticweb-dev/review";
import { askerFor, type ActionEngine, type AskLlm, type TrafficEvent } from "@agenticweb-dev/runtime";
import { serveNode } from "@agenticweb-dev/runtime/node";
import { apiKeyEnvFor } from "@agenticweb-dev/understand";
import { parseApiKeys } from "@agenticweb-dev/actions";
import type { ProjectConfig, SiteGraph } from "@agenticweb-dev/core";
import { Project } from "./project.ts";
import { persistActionOverride } from "./commands.ts";

/** Hooks later phases plug into: the action engine (Phase 3) and traffic logging (Phase 4). */
export const serveHooks: {
  engine?: (project: Project, graph: SiteGraph, config: ProjectConfig, baseUrl: string) => Promise<ActionEngine | undefined>;
  traffic?: (project: Project) => (e: TrafficEvent) => void;
} = {};

/** Default traffic log for local serving: one JSON line per request in .agenticweb/traffic.jsonl. */
serveHooks.traffic = (project) => {
  let queue = Promise.resolve();
  return (e) => {
    queue = queue.then(() => mkdir(project.dataDir, { recursive: true }).then(() => appendFile(path.join(project.dataDir, "traffic.jsonl"), JSON.stringify(e) + "\n"))).catch(() => {});
  };
};

export type ServeOptions = {
  port?: number;
  noLlm?: boolean;
  syncEveryMinutes?: number;
  hookSecret?: string;
  /** Edge mode: proxy this human site (true = config.edge.origin or config.site) and serve the agent branch beside it. */
  edge?: string | true;
};

export async function cmdServe(project: Project, opts: ServeOptions, out = { log: (m: string) => console.log(m) }) {
  let graph = await project.requireGraph();
  const config = await project.config();
  const port = opts.port ?? 8787;
  const publicUrl = `http://127.0.0.1:${port}`;
  const edge = opts.edge ? { ...config.edge, origin: opts.edge === true ? (config.edge.origin ?? config.site) : opts.edge, publicUrl } : undefined;
  // In edge mode the agent branch lives under the prefix on the proxied address.
  const baseUrl = edge ? `${publicUrl}${config.edge.prefix}` : (config.deploy.baseUrl ?? publicUrl);
  let llm: (AskLlm & { label: string }) | undefined;
  if (!opts.noLlm) llm = await askerFor(config.llm, process.env);
  const hookSecret = opts.hookSecret ?? process.env.AGENTICWEB_HOOK_SECRET;
  const onTraffic = serveHooks.traffic?.(project);
  const engine = await serveHooks.engine?.(project, graph, config, baseUrl);

  let refreshing: Promise<void> | undefined;
  const refresh = async () => {
    // One refresh at a time; webhooks often arrive in bursts.
    refreshing ??= (async () => {
      const { cmdSync } = await import("./sync.ts");
      const r = await cmdSync(project, { llm: opts.noLlm ? false : undefined, quiet: true }, out);
      graph = r.graph;
      server.update({ ...runtimeOpts(), graph, engine: await serveHooks.engine?.(project, graph, await project.config(), baseUrl) });
    })().finally(() => (refreshing = undefined));
    return refreshing;
  };
  const runtimeOpts = () => ({
    graph,
    llm,
    askModel: config.llm.askModel,
    engine,
    baseUrl,
    rateLimit: config.runtime.requestsPerMinute,
    commerce: config.commerce,
    agents: config.agents,
    apiKeys: parseApiKeys(process.env[config.runtime.apiKeysEnv]),
    onTraffic,
    ...(hookSecret ? { hookSecret, onRefresh: refresh } : {}),
  });
  const server = await serveNode({ ...runtimeOpts(), port, edge });
  if (opts.syncEveryMinutes) {
    const timer = setInterval(() => void refresh().catch((err: unknown) => out.log(`Sync failed: ${(err as Error).message}`)), opts.syncEveryMinutes * 60_000);
    timer.unref();
  }

  const agentUrl = edge ? `${server.url}${config.edge.prefix}` : server.url;
  if (edge) {
    out.log(`Edge mode: ${server.url} serves ${edge.origin} with the agent branch added`);
    out.log(`  Try:       curl -H "Accept: text/markdown" ${server.url}/`);
    out.log(`  llms.txt:  ${server.url}/llms.txt`);
  } else out.log(`Agent branch for ${graph.site.name} running at ${server.url}`);
  out.log(`  Manifest:  ${server.url}/.well-known/agent-site.json`);
  out.log(`  Ask:       ${agentUrl}/ask?q=your+question`);
  out.log(`  MCP:       ${agentUrl}/mcp`);
  out.log(`  Actions:   ${engine ? engine.actions().map((a) => a.name).join(", ") || "none enabled" : "none enabled"}`);
  out.log(`  /ask uses: ${llm ? llm.label : `built-in search (set ${apiKeyEnvFor(config.llm)} for written answers)`}`);
  if (opts.syncEveryMinutes) out.log(`  Sync:      every ${opts.syncEveryMinutes} minutes`);
  if (hookSecret) out.log(`  Webhook:   POST ${agentUrl}/hooks/refresh (header x-agenticweb-secret)`);
  out.log("Press Ctrl+C to stop.");
  return { ...server, refresh };
}

export async function cmdReview(project: Project, opts: { port?: number }, out = { log: (m: string) => console.log(m) }) {
  await project.requireGraph();
  const token = randomBytes(16).toString("hex");
  const app = createReviewApp(
    {
      load: () => project.requireGraph(),
      save: (g) => project.saveGraph(g),
      onActionChange: (name, change) => persistActionOverride(project, name, change),
      activity: async (days) => (await import("./sync.ts")).loadActivity(project, days),
      suggestions: async () => {
        const { loadSuggestions, suggestionSnippet } = await import("./suggest.ts");
        return (await loadSuggestions(project)).map((s) => ({ ...s, snippet: suggestionSnippet(s) }));
      },
      updateSuggestion: async (id, change) => {
        const { updateSuggestion, suggestionSnippet } = await import("./suggest.ts");
        const s = await updateSuggestion(project, id, change);
        return { ...s, snippet: suggestionSnippet(s) };
      },
      refreshSuggestions: async () => {
        const { refreshSuggestions } = await import("./suggest.ts");
        return { added: (await refreshSuggestions(project)).added.length };
      },
      changes: async () => {
        const file = path.join(project.dataDir, "changes.jsonl");
        const { existsSync } = await import("node:fs");
        const { readFile } = await import("node:fs/promises");
        if (!existsSync(file)) return [];
        return (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-20).reverse().map((l) => JSON.parse(l) as unknown);
      },
    },
    token,
  );
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: "127.0.0.1" }, (info) => {
      const url = `http://127.0.0.1:${info.port}/?token=${token}`;
      out.log(`Review your agent branch at:\n\n  ${url}\n\nChanges are saved as you make them. Run \`agenticweb build\` afterwards to publish them. Press Ctrl+C to stop.`);
      resolve({ url, close: () => server.close() });
    });
  });
}
