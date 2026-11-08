import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { publicView, type SiteGraph } from "@agenticweb-dev/core";
import { emitAgentBranch } from "@agenticweb-dev/emitters";
import { Asker, type AskLlm } from "./ask.ts";
import { SearchIndex } from "./search.ts";
import { handleMcp } from "./mcp.ts";
import type { ActionEngine, CallContext } from "./engine.ts";
import { RateLimiter } from "./ratelimit.ts";
import { checkoutActionOf, mountCommerce, paymentActionOf, type CommerceOptions } from "./commerce.ts";
import { BotAuthVerifier, type BotAuthResult } from "./botauth.ts";
import { policyEngine, ruleFor, whoMay, type AgentRules } from "./policy.ts";

/** Internal header edge mode sets to the URL the agent really signed (the agent branch sees a rewritten path). */
export const SIGNED_URL_HEADER = "x-agenticweb-signed-url";

/** One request, as recorded for agent-traffic analytics (Phase 4). */
export type TrafficEvent = {
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  agent: string;
  /** How the agent was identified, when it was: "web-bot-auth" or "api-key". */
  verifiedBy?: "web-bot-auth" | "api-key";
  userAgent: string;
  kind: "file" | "ask" | "search" | "mcp" | "action" | "confirm" | "other";
  detail?: string;
  /** For /ask: whether the site had an answer. */
  ok?: boolean;
};

export type RuntimeOptions = {
  graph: SiteGraph;
  engine?: ActionEngine;
  llm?: AskLlm;
  askModel?: string;
  /** Public URL of this runtime, used in confirmation links. Defaults to the request origin. */
  baseUrl?: string;
  /** Requests per minute per client (default 60). */
  rateLimit?: number;
  /** API keys that identify agents: key → agent name. Optional; reads are always open. */
  apiKeys?: Record<string, string>;
  onTraffic?: (e: TrafficEvent) => void;
  /** Called by POST /hooks/refresh (e.g. from a Shopify product webhook) to rebuild with fresh data. */
  onRefresh?: () => Promise<void>;
  /** Shared secret required by /hooks/refresh (header x-agenticweb-secret or ?secret=). */
  hookSecret?: string;
  /** Path the agent branch is served under on a shared domain (edge mode), e.g. "/.agent". */
  pathPrefix?: string;
  /** Agent checkout protocols (UCP, ACP). On when the site has a checkout or payment action; false turns them off. */
  commerce?: CommerceOptions | false;
  /** Agent identity and per-agent permissions. */
  agents?: {
    /** Check Web Bot Auth signatures (default on). Pass a verifier to share its key cache or for tests. */
    webBotAuth?: boolean | BotAuthVerifier;
    rules?: AgentRules;
  };
};

const TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

const AGENT_PATTERNS: Array<[RegExp, string]> = [
  [/claude|anthropic/i, "Claude"],
  [/chatgpt|openai|gptbot|oai-searchbot/i, "OpenAI"],
  [/perplexity/i, "Perplexity"],
  [/google-extended|gemini|googlebot/i, "Google"],
  [/bingbot|copilot/i, "Microsoft"],
  [/applebot/i, "Apple"],
  [/mcp|modelcontextprotocol/i, "MCP client"],
];

export function identifyAgent(userAgent: string, apiKeyAgent?: string): string {
  if (apiKeyAgent) return apiKeyAgent;
  for (const [re, name] of AGENT_PATTERNS) if (re.test(userAgent)) return name;
  return userAgent ? "other" : "anonymous";
}

/** Creates the agent-branch server. Platform-neutral: use createApp(...).fetch anywhere. */
export function createApp(opts: RuntimeOptions): Hono {
  const graph = publicView(opts.graph);
  const rules = opts.agents?.rules;
  const engine = opts.engine ? policyEngine(opts.engine, rules) : undefined;
  const verifier = opts.agents?.webBotAuth === false ? undefined : opts.agents?.webBotAuth instanceof BotAuthVerifier ? opts.agents.webBotAuth : new BotAuthVerifier();
  const commerceOpts = opts.commerce === false ? { ucp: false, acp: false } : (opts.commerce ?? {});
  const commerce = {
    ucp: commerceOpts.ucp !== false && Boolean(checkoutActionOf(opts.engine) || paymentActionOf(opts.engine)),
    acp: commerceOpts.acp !== false && Boolean(paymentActionOf(opts.engine)),
  };
  const files = emitAgentBranch(
    { ...opts.graph, actions: opts.engine ? opts.engine.actions() : [] },
    {
      runtime: true,
      baseUrl: opts.baseUrl,
      pathPrefix: opts.pathPrefix,
      commerce,
      access: {
        webBotAuth: Boolean(verifier),
        apiKeys: Boolean(opts.apiKeys && Object.keys(opts.apiKeys).length),
        actions: Object.fromEntries((opts.engine?.actions() ?? []).map((a) => [a.name, whoMay(rules, a)])),
      },
    },
  );
  const manifest = JSON.parse(files.get(".well-known/agent-site.json")!) as unknown;
  const index = SearchIndex.fromGraph(graph);
  const asker = new Asker(graph, { index, llm: opts.llm, model: opts.askModel });
  const limiter = new RateLimiter(opts.rateLimit ?? 60);
  const ruleLimiters = new Map<number, RateLimiter>();
  const app = new Hono();

  const clientOf = (c: Context) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const key = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const keyAgent = key ? opts.apiKeys?.[key] : undefined;
    const bot = c.get("botAuth" as never) as BotAuthResult;
    // An owner-issued API key wins, then a valid Web Bot Auth signature; a user agent string is only a label.
    const verifiedBy = keyAgent ? ("api-key" as const) : bot?.ok ? ("web-bot-auth" as const) : undefined;
    const agent = keyAgent ?? (bot?.ok ? bot.agent : identifyAgent(c.req.header("user-agent") ?? ""));
    return { ip, agent, keyAgent, verifiedBy, bot };
  };
  const ctxOf = (c: Context): CallContext => {
    const cl = clientOf(c);
    return {
      agent: cl.agent,
      ip: cl.ip,
      idempotencyKey: c.req.header("idempotency-key"),
      baseUrl: opts.baseUrl ?? new URL(c.req.url).origin,
      paymentCredential: c.req.header("x-agent-payment-token"),
      agentFromKey: Boolean(cl.keyAgent),
      agentVerifiedBy: cl.verifiedBy,
    };
  };

  // Who is calling: check a Web Bot Auth signature when there is one.
  app.use("*", async (c, next) => {
    if (verifier && c.req.header("signature-input")) {
      // In edge mode the agent signed the public URL, not the rewritten one this app sees.
      const signed = opts.pathPrefix ? c.req.header(SIGNED_URL_HEADER) : undefined;
      const result = await verifier.verify(c.req.raw, signed ? new URL(signed) : undefined);
      c.set("botAuth" as never, result as never);
    }
    await next();
    const cl = clientOf(c);
    c.header("x-agent-identity", cl.verifiedBy ? `${cl.agent}; verified=${cl.verifiedBy}` : cl.bot && !cl.bot.ok ? `unverified; reason="${cl.bot.reason.replace(/"/g, "'")}"` : "unverified");
  });

  app.use("*", cors({ origin: "*", allowHeaders: ["content-type", "authorization", "x-api-key", "idempotency-key", "x-agent-payment-token", "mcp-protocol-version", "mcp-session-id", "ucp-agent", "request-id", "signature", "signature-input", "content-digest", "api-version", "timestamp"], exposeHeaders: ["mcp-session-id"] }));

  // Analytics + rate limiting.
  app.use("*", async (c, next) => {
    const started = Date.now();
    const cl = clientOf(c);
    const path = new URL(c.req.url).pathname;
    const isStatic = c.req.method === "GET" && !path.startsWith("/api/") && path !== "/ask" && !path.startsWith("/confirm/");
    const perMinute = ruleFor(rules, { agent: cl.agent, verifiedBy: cl.verifiedBy })?.rule.requestsPerMinute;
    let lim = limiter;
    if (perMinute) {
      lim = ruleLimiters.get(perMinute) ?? new RateLimiter(perMinute);
      ruleLimiters.set(perMinute, lim);
    }
    // Verified agents are counted per agent; everyone else per IP.
    if (!isStatic && !lim.take(cl.verifiedBy ? `agent:${cl.agent}` : cl.ip)) {
      c.header("retry-after", "60");
      return c.json({ error: "Rate limit reached. Try again in a minute." }, 429);
    }
    await next();
    opts.onTraffic?.({
      ts: new Date().toISOString(),
      method: c.req.method,
      path,
      status: c.res.status,
      ms: Date.now() - started,
      agent: cl.agent,
      ...(cl.verifiedBy ? { verifiedBy: cl.verifiedBy } : {}),
      userAgent: c.req.header("user-agent") ?? "",
      kind: path === "/ask" ? "ask" : path === "/api/search" ? "search" : path === "/mcp" ? "mcp" : path.startsWith("/confirm/") ? "confirm" : path.startsWith("/api/") ? "action" : isStatic ? "file" : "other",
      detail: c.get("detail" as never) as string | undefined,
      ok: c.get("ok" as never) as boolean | undefined,
    });
  });

  // Every response says how fresh the data is.
  app.use("*", async (c, next) => {
    await next();
    c.header("x-agent-branch-updated", graph.generatedAt);
  });

  app.get("/healthz", (c) => c.json({ ok: true, generated_at: graph.generatedAt }));

  app.post("/hooks/refresh", async (c) => {
    if (!opts.onRefresh || !opts.hookSecret) return c.json({ error: "Refresh hooks are not enabled." }, 404);
    const given = c.req.header("x-agenticweb-secret") ?? c.req.query("secret");
    if (!given || !timingSafeEqual(given, opts.hookSecret)) return c.json({ error: "Wrong secret." }, 401);
    // Refresh in the background; the caller (a webhook) only needs a quick acknowledgement.
    const run = opts.onRefresh().catch((err: unknown) => console.error("Refresh failed:", err));
    try {
      // On Cloudflare Workers, keep the refresh alive after the response; Node has no execution context.
      c.executionCtx.waitUntil(run);
    } catch {
      // Node: the process keeps running anyway.
    }
    return c.json({ ok: true, message: "Refresh started." }, 202);
  });

  app.post("/ask", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; max_results?: number };
    if (!body.query?.trim()) return c.json({ error: 'Send JSON like {"query": "What time do you open on Sunday?"}' }, 400);
    c.set("detail" as never, body.query.slice(0, 200) as never);
    const r = await asker.ask(body.query, Math.min(20, body.max_results ?? 5));
    c.set("ok" as never, r.found as never);
    return c.json(r);
  });
  app.get("/ask", async (c) => {
    const q = c.req.query("q") ?? c.req.query("query");
    if (!q) return c.json({ error: "Add ?q=your question, or POST JSON {\"query\": ...}" }, 400);
    c.set("detail" as never, q.slice(0, 200) as never);
    const r = await asker.ask(q);
    c.set("ok" as never, r.found as never);
    return c.json(r);
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q) return c.json({ error: "Add ?q=search terms" }, 400);
    c.set("detail" as never, q.slice(0, 200) as never);
    const limit = Math.min(50, Number(c.req.query("limit") ?? 10));
    return c.json({ query: q, results: index.search(q, { limit, type: c.req.query("type") }).map(({ text: _t, ...h }) => h) });
  });

  app.all("/mcp", async (c) => {
    if (c.req.method === "GET") return c.json({ error: "This MCP server is stateless. POST JSON-RPC requests to /mcp." }, 405);
    const ctx = ctxOf(c);
    return handleMcp(c.req.raw, {
      graph,
      manifest,
      index,
      asker,
      engine: engine?.forCaller(ctx),
      ctx,
      onAsk: (q, found) => {
        c.set("detail" as never, q as never);
        c.set("ok" as never, found as never);
      },
    });
  });

  // Actions.
  app.get("/api/actions/:id", async (c) => {
    const r = await engine?.status(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "No action with that id." }, 404);
  });
  app.post("/api/:action", async (c) => {
    const name = c.req.param("action");
    if (!engine || !engine.actions().some((a) => a.name === name)) return c.json({ error: `No action "${name}". See /.well-known/agent-site.json` }, 404);
    const input = await c.req.json().catch(() => undefined);
    if (input === undefined) return c.json({ error: "Send the action input as a JSON body." }, 400);
    c.set("detail" as never, name as never);
    const r = await engine.call(name, input, ctxOf(c));
    const status = r.errors ? 400 : r.status === "failed" ? 502 : r.status === "rejected" ? 409 : r.final ? 200 : 202;
    return c.json(r, status);
  });

  // Confirmation pages for guests and owners (links sent by email/SMS).
  app.get("/confirm/:token", async (c) => {
    const info = await engine?.describe(c.req.param("token"));
    if (!info) return c.html(page("Link expired", "<p>This confirmation link is no longer valid.</p>"), 404);
    const rows = info.details.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
    const verb = info.who === "owner" ? "Approve" : "Confirm";
    return c.html(
      page(
        info.title,
        `<p>An AI agent made this request${info.who === "guest" ? " on your behalf" : ""}. Please check the details.</p><table>${rows}</table>
         <form method="post"><button name="decision" value="confirm">${verb}</button> <button name="decision" value="reject" class="secondary">Decline</button></form>`,
      ),
    );
  });
  app.post("/confirm/:token", async (c) => {
    if (!engine) return c.html(page("Not available", "<p>Actions are not enabled.</p>"), 404);
    const form = await c.req.parseBody();
    const decision = form.decision === "reject" ? "reject" : "confirm";
    const r = await engine.confirm(c.req.param("token"), decision);
    return c.html(page(r.ok ? (decision === "confirm" ? "Confirmed" : "Declined") : "Something went wrong", `<p>${esc(r.message)}</p>`), r.ok ? 200 : 400);
  });

  // Agent checkout protocols (UCP, ACP).
  mountCommerce(app, { graph, engine, ctxOf, baseUrl: opts.baseUrl }, commerceOpts);

  // Static agent-branch files.
  app.get("*", (c) => {
    let path = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
    if (path === "" || path.endsWith("/")) path += "index.html";
    const body = files.get(path);
    if (body === undefined) return c.json({ error: "Not found. Start at /.well-known/agent-site.json or /llms.txt" }, 404);
    const ext = path.split(".").pop() ?? "";
    return c.body(body, 200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "public, max-age=300" });
  });

  return app;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}table{border-collapse:collapse;margin:1rem 0;width:100%}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd}th{width:40%;color:#555;font-weight:500}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1a56db;color:#fff;cursor:pointer}button.secondary{background:#e5e7eb;color:#111}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
