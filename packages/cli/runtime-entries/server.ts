// Entry point of the deployable Node server (agent-server/server.mjs).
// It reads the site's data from site-graph.json and config.json next to it.
// With EDGE_ORIGIN set (or edge.origin in config.json), it runs in edge mode: in front of the human site.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectConfig, SiteGraph } from "@agenticweb-dev/core";
import { askerFor } from "@agenticweb-dev/runtime";
import { serveNode } from "@agenticweb-dev/runtime/node";
import { createEngine, parseApiKeys } from "@agenticweb-dev/actions";
import { FileStore } from "@agenticweb-dev/actions/file-store";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const graph = SiteGraph.parse(JSON.parse(readFileSync(path.join(here, "site-graph.json"), "utf8")));
const config = ProjectConfig.parse(JSON.parse(readFileSync(path.join(here, "config.json"), "utf8")));
const engine = graph.actions.some((a) => a.enabled)
  ? createEngine({ graph, config, env, store: new FileStore(path.join(env.DATA_DIR ?? here, "actions.json")) })
  : undefined;
const llm = await askerFor(config.llm, env);
const edgeOrigin = env.EDGE_ORIGIN || (env.EDGE_MODE === "1" ? config.edge.origin : undefined);
const server = await serveNode({
  graph,
  engine,
  llm,
  askModel: config.llm.askModel,
  baseUrl: edgeOrigin ? undefined : (env.PUBLIC_URL ?? config.deploy.baseUrl),
  rateLimit: config.runtime.requestsPerMinute,
  apiKeys: parseApiKeys(env[config.runtime.apiKeysEnv]),
  commerce: config.commerce,
  agents: config.agents,
  port: Number(env.PORT ?? 8787),
  hostname: env.HOST ?? "0.0.0.0",
  onTraffic: env.LOG_TRAFFIC === "0" ? undefined : (e) => console.log(JSON.stringify({ traffic: e })),
  edge: edgeOrigin ? { ...config.edge, origin: edgeOrigin, publicUrl: env.PUBLIC_URL || undefined } : undefined,
});
if (edgeOrigin) console.log(`Edge mode: proxying ${edgeOrigin}; agent branch under ${config.edge.prefix}`);
console.log(`Agent branch for ${graph.site.name} running on ${server.url}`);
