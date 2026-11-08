// Entry point of the edge Worker (agent-edge/worker.js): runs on a route in front of the human site.
// The site's data comes from site-data.js, written next to it at deploy time.
import { ProjectConfig, SiteGraph } from "@agenticweb-dev/core";
import { createClaudeAsker, createEdge, type FetchHandler } from "@agenticweb-dev/runtime";
import { KvStore, MemoryStore, createEngine, parseApiKeys, type KvLike } from "@agenticweb-dev/actions";
import { config as configJson, graph as graphJson } from "./site-data.js";

type WorkerEnv = Record<string, string | undefined> & { AGENTICWEB_KV?: KvLike };

const graph = SiteGraph.parse(graphJson);
const config = ProjectConfig.parse(configJson);
let edge: FetchHandler | undefined;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: unknown): Promise<Response> {
    if (!edge) {
      const { AGENTICWEB_KV, ...vars } = env;
      const store = AGENTICWEB_KV ? new KvStore(AGENTICWEB_KV) : new MemoryStore();
      const engine = graph.actions.some((a) => a.enabled) ? createEngine({ graph, config, env: vars, store }) : undefined;
      const llm = config.llm.enabled && vars.ANTHROPIC_API_KEY ? await createClaudeAsker({ apiKey: vars.ANTHROPIC_API_KEY }) : undefined;
      edge = createEdge(
        {
          graph,
          engine,
          llm,
          askModel: config.llm.askModel,
          rateLimit: config.runtime.requestsPerMinute,
          apiKeys: parseApiKeys(vars[config.runtime.apiKeysEnv]),
          commerce: { ...config.commerce, store: AGENTICWEB_KV },
          agents: config.agents,
        },
        {
          ...config.edge,
          // On a route, fetch(request) reaches the origin; ORIGIN_URL is for a site hosted elsewhere.
          origin: vars.ORIGIN_URL || config.edge.origin,
          publicUrl: vars.PUBLIC_URL || undefined,
        },
      );
    }
    return edge.fetch(request, env, ctx);
  },
};
