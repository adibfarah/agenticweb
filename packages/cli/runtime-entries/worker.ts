// Entry point of the deployable Cloudflare Worker (agent-worker/worker.js).
// The site's data comes from site-data.js, written next to it at deploy time.
import { ProjectConfig, SiteGraph } from "@agenticweb-dev/core";
import { createApp, createClaudeAsker } from "@agenticweb-dev/runtime";
import { KvStore, MemoryStore, createEngine, parseApiKeys, type KvLike } from "@agenticweb-dev/actions";
import { config as configJson, graph as graphJson } from "./site-data.js";

type WorkerEnv = Record<string, string | undefined> & { AGENTICWEB_KV?: KvLike };

const graph = SiteGraph.parse(graphJson);
const config = ProjectConfig.parse(configJson);
let app: ReturnType<typeof createApp> | undefined;

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: unknown): Promise<Response> {
    if (!app) {
      const { AGENTICWEB_KV, ...vars } = env;
      const store = AGENTICWEB_KV ? new KvStore(AGENTICWEB_KV) : new MemoryStore();
      const engine = graph.actions.some((a) => a.enabled) ? createEngine({ graph, config, env: vars, store }) : undefined;
      const llm = config.llm.enabled && vars.ANTHROPIC_API_KEY ? await createClaudeAsker({ apiKey: vars.ANTHROPIC_API_KEY }) : undefined;
      app = createApp({
        graph,
        engine,
        llm,
        askModel: config.llm.askModel,
        baseUrl: vars.PUBLIC_URL || config.deploy.baseUrl,
        rateLimit: config.runtime.requestsPerMinute,
        apiKeys: parseApiKeys(vars[config.runtime.apiKeysEnv]),
        // Checkout sessions live in KV when it's bound, so they survive across Worker instances.
        commerce: { ...config.commerce, store: AGENTICWEB_KV },
        agents: config.agents,
      });
    }
    return app.fetch(request, env, ctx as never);
  },
};
