import { serve } from "@hono/node-server";
import { createApp, type RuntimeOptions } from "./app.ts";
import { createEdge, type EdgeSettings, type FetchHandler } from "./edge.ts";

export type NodeServeOptions = RuntimeOptions & {
  port?: number;
  hostname?: string;
  /** Run in edge mode: proxy the human site and serve the agent branch on the same address. */
  edge?: EdgeSettings;
};

export type NodeServer = {
  url: string;
  close: () => Promise<void>;
  /** Swaps in new data (graph, engine) without restarting the server. */
  update: (opts: RuntimeOptions & { edge?: EdgeSettings }) => void;
};

const handlerFor = (opts: RuntimeOptions & { edge?: EdgeSettings }): FetchHandler =>
  opts.edge ? createEdge(opts, opts.edge) : { fetch: async (req) => createAppCached(opts).fetch(req) };

// createApp is cheap to call once; keep one per options object.
const cache = new WeakMap<object, ReturnType<typeof createApp>>();
function createAppCached(opts: RuntimeOptions) {
  let app = cache.get(opts);
  if (!app) cache.set(opts, (app = createApp(opts)));
  return app;
}

/** Starts the runtime (or the edge proxy) on Node. */
export async function serveNode(opts: NodeServeOptions): Promise<NodeServer> {
  let handler = handlerFor(opts);
  const hostname = opts.hostname ?? "127.0.0.1";
  return new Promise((resolve) => {
    const server = serve({ fetch: (req) => handler.fetch(req), port: opts.port ?? 8787, hostname }, (info) => {
      resolve({
        url: `http://${hostname}:${info.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        update: (next) => {
          handler = handlerFor({ ...next, edge: next.edge ?? opts.edge });
        },
      });
    });
  });
}
