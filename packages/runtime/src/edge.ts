import { publicView } from "@agenticweb-dev/core";
import { discoverySnippets } from "@agenticweb-dev/emitters";
import { SIGNED_URL_HEADER, createApp, identifyAgent, type RuntimeOptions } from "./app.ts";

/**
 * Edge mode: AgenticWeb runs in front of the human site on the same domain (a Cloudflare Worker route,
 * a Node reverse proxy). Nothing is installed on the site's own server.
 *
 * - `/.agent/*` serves the whole agent branch (manifest, pages, data, /ask, /mcp, actions).
 * - `/llms.txt` and `/.well-known/agent-site.json` are also served at the root, where agents look first.
 * - A page requested with `Accept: text/markdown` gets its Markdown version from the Site Graph. This is
 *   standard content negotiation on the Accept header, not user-agent sniffing, so people and agents who ask
 *   for the same format get the same thing.
 * - Every other request goes to the human site unchanged, except that HTML pages get discovery `<link>` tags
 *   and a `Link` header pointing to the agent branch, and `robots.txt` gets two comment lines.
 */
export type EdgeSettings = {
  /**
   * Where the human site really lives, e.g. https://origin.mysite.com. Leave it out on a Cloudflare route,
   * where fetch(request) already reaches the origin.
   */
  origin?: string;
  /** Replaces the default origin fetch (tests, custom platforms). */
  fetchOrigin?: (req: Request) => Promise<Response>;
  /** Public address of the site, e.g. https://mysite.com. Defaults to the request's origin. */
  publicUrl?: string;
  /** Path the agent branch is served under. Default "/.agent". */
  prefix?: string;
  /** Agent-branch files also served at the root of the domain. */
  rootPaths?: string[];
  /** Answer `Accept: text/markdown` with the page's Markdown version. Default true. */
  markdown?: boolean;
  /** Add discovery `<link>` tags to HTML pages. Default true. */
  injectLinks?: boolean;
  /** Add agent-branch lines to robots.txt. Default true. */
  robots?: boolean;
  /** Load the WebMCP script on HTML pages, so browser agents get the site's tools. Default true. */
  webmcp?: boolean;
};

export const DEFAULT_ROOT_PATHS = ["/llms.txt", "/llms-full.txt", "/.well-known/agent-site.json", "/.well-known/agent-card.json", "/.well-known/ucp", "/.well-known/agent-site-key.json", "/.well-known/agent-site-proof.json"];
export const EDGE_LOOP_HEADER = "x-agenticweb-edge";

export type FetchHandler = { fetch: (req: Request, env?: unknown, ctx?: unknown) => Promise<Response> };

export function createEdge(runtime: RuntimeOptions, settings: EdgeSettings = {}): FetchHandler {
  const prefix = normalisePrefix(settings.prefix ?? "/.agent");
  const rootPaths = new Set(settings.rootPaths ?? DEFAULT_ROOT_PATHS);
  const graph = publicView(runtime.graph);
  const pagesByPath = new Map(graph.pages.map((p) => [pagePath(p.url), p]));
  const apps = new Map<string, ReturnType<typeof createApp>>();

  // One runtime per public origin, so confirmation links and OpenAPI servers carry the right address.
  const appFor = (origin: string) => {
    let app = apps.get(origin);
    if (!app) {
      app = createApp({ ...runtime, baseUrl: `${(settings.publicUrl ?? origin).replace(/\/$/, "")}${prefix}`, pathPrefix: prefix });
      apps.set(origin, app);
    }
    return app;
  };

  const toOrigin = (req: Request): Promise<Response> => {
    if (settings.fetchOrigin) return settings.fetchOrigin(req);
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set(EDGE_LOOP_HEADER, "1");
    // We may rewrite the body, so ask for it uncompressed rather than decode it twice.
    headers.set("accept-encoding", "identity");
    let target = url.toString();
    if (settings.origin) {
      const origin = new URL(settings.origin);
      target = new URL(url.pathname + url.search, origin).toString();
      headers.delete("host");
      headers.set("x-forwarded-host", url.host);
      headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    return fetch(target, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual", ...(hasBody ? { duplex: "half" } : {}) } as RequestInit);
  };

  return {
    async fetch(req, env, ctx) {
      // A request that already passed through an AgenticWeb edge means the origin points back at us.
      if (req.headers.get(EDGE_LOOP_HEADER)) return new Response("AgenticWeb edge: the origin points back to this proxy. Check the origin setting.", { status: 508 });
      const url = new URL(req.url);
      const app = appFor(url.origin);
      const path = url.pathname;

      // The agent branch, under the prefix.
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        const inner = new URL(req.url);
        inner.pathname = path.slice(prefix.length) || "/";
        const headers = new Headers(req.headers);
        headers.set(SIGNED_URL_HEADER, req.url);
        return app.fetch(new Request(inner, new Request(req, { headers })), env as never, ctx as never);
      }
      if (rootPaths.has(path)) {
        const headers = new Headers(req.headers);
        headers.set(SIGNED_URL_HEADER, req.url);
        return app.fetch(new Request(req, { headers }), env as never, ctx as never);
      }

      const isRead = req.method === "GET" || req.method === "HEAD";
      if (isRead && path === "/robots.txt" && settings.robots !== false) return robots(await toOrigin(req), discoverySnippets(runtime.graph, settings.publicUrl ?? url.origin).robots);

      const page = pagesByPath.get(normalisePath(path));
      if (isRead && page && settings.markdown !== false && prefersMarkdown(req.headers.get("accept"))) {
        const res = await app.fetch(new Request(new URL(`/pages/${page.slug}.md`, url), { headers: req.headers }), env as never, ctx as never);
        if (res.ok) {
          const body = await res.text();
          const headers = new Headers({
            "content-type": "text/markdown; charset=utf-8",
            vary: "Accept",
            "content-location": `${prefix}/pages/${page.slug}.md`,
            "cache-control": "public, max-age=300",
            "x-markdown-tokens": String(Math.ceil(body.length / 4)),
            "x-agent-branch-updated": graph.generatedAt,
            link: `<${prefix}/.well-known/agent-site.json>; rel="alternate"; type="application/json"`,
          });
          runtime.onTraffic?.({ ts: new Date().toISOString(), method: req.method, path, status: 200, ms: 0, agent: identifyAgent(req.headers.get("user-agent") ?? ""), userAgent: req.headers.get("user-agent") ?? "", kind: "file", detail: `markdown:${page.slug}` });
          return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
        }
      }

      const res = await toOrigin(req);
      return decorate(res, req, {
        manifest: `${prefix}/.well-known/agent-site.json`,
        twin: page ? `${prefix}/pages/${page.slug}.md` : undefined,
        llms: "/llms.txt",
        webmcp: settings.webmcp !== false ? `${prefix}/webmcp.js` : undefined,
        inject: settings.injectLinks !== false,
        origin: settings.origin,
        publicOrigin: url.origin,
      });
    },
  };
}

/**
 * True when the Accept header asks for Markdown at least as strongly as HTML.
 * A Markdown request beats a wildcard of the same weight, so `text/markdown, *\/*` gets Markdown,
 * while browsers (`text/html, ..., *\/*;q=0.8`) and plain `*\/*` clients get HTML.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const items = accept.split(",").map((part, i) => {
    const [type = "", ...params] = part.split(";").map((s) => s.trim());
    const qParam = params.find((p) => p.toLowerCase().startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
  });
  const md = items.find((x) => x.type === "text/markdown" || x.type === "text/x-markdown");
  if (!md || md.q <= 0) return false;
  const html = items.find((x) => x.type === "text/html" || x.type === "application/xhtml+xml");
  if (html) return md.q > html.q || (md.q === html.q && md.i < html.i);
  const wildcard = items.find((x) => x.type === "text/*") ?? items.find((x) => x.type === "*/*");
  return !wildcard || md.q >= wildcard.q;
}

type DecorateOpts = { manifest: string; twin?: string; llms: string; webmcp?: string; inject: boolean; origin?: string; publicOrigin: string };

/** Adds discovery headers and tags to a response from the human site. */
function decorate(res: Response, req: Request, o: DecorateOpts): Response {
  const headers = new Headers(res.headers);
  // The body may be rewritten and was requested uncompressed; never pass on stale length or encoding.
  headers.delete("content-length");
  headers.delete("content-encoding");
  // Redirects from a separate origin should keep visitors on the public address.
  const location = headers.get("location");
  if (location && o.origin && location.startsWith(new URL(o.origin).origin)) headers.set("location", o.publicOrigin + location.slice(new URL(o.origin).origin.length));

  const type = headers.get("content-type") ?? "";
  const isHtml = /^text\/html/i.test(type);
  if (!isHtml || res.status !== 200) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });

  const links = [`<${o.manifest}>; rel="alternate"; type="application/json"; title="Agent branch"`];
  if (o.twin) links.push(`<${o.twin}>; rel="alternate"; type="text/markdown"`);
  headers.append("link", links.join(", "));
  if (o.twin) headers.append("vary", "Accept");

  const charsetOk = !/charset=/i.test(type) || /charset="?utf-?8/i.test(type);
  const noTransform = /no-transform/i.test(headers.get("cache-control") ?? "");
  if (!o.inject || !charsetOk || noTransform || !res.body || req.method === "HEAD") return new Response(res.body, { status: res.status, statusText: res.statusText, headers });

  const tags = [`<link rel="alternate" type="application/json" href="${o.manifest}" title="Agent branch">`];
  tags.push(o.twin ? `<link rel="alternate" type="text/markdown" href="${o.twin}">` : `<link rel="alternate" type="text/markdown" href="${o.llms}" title="llms.txt">`);
  if (o.webmcp) tags.push(`<script src="${o.webmcp}" defer></script>`);
  return new Response(injectIntoHead(res.body, tags.join("")), { status: res.status, statusText: res.statusText, headers });
}

const HEAD_END = /<\/head\s*>|<body[\s>]/i;
const SCAN_LIMIT = 512 * 1024;

/** Streams an HTML body, inserting `html` just before `</head>` (or `<body>` when there is no head). */
export function injectIntoHead(body: ReadableStream<Uint8Array>, html: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let done = false;
  let carry = "";
  let scanned = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        const text = decoder.decode(chunk, { stream: true });
        if (done) {
          if (text) ctl.enqueue(encoder.encode(text));
          return;
        }
        const all = carry + text;
        const m = HEAD_END.exec(all);
        if (m) {
          done = true;
          carry = "";
          ctl.enqueue(encoder.encode(all.slice(0, m.index) + html + all.slice(m.index)));
          return;
        }
        scanned += text.length;
        if (scanned > SCAN_LIMIT) {
          // No head in the first 512 KB: leave the page alone.
          done = true;
          carry = "";
          ctl.enqueue(encoder.encode(all));
          return;
        }
        // Keep the tail in case the tag is split across chunks.
        const keep = 16;
        ctl.enqueue(encoder.encode(all.slice(0, Math.max(0, all.length - keep))));
        carry = all.slice(Math.max(0, all.length - keep));
      },
      flush(ctl) {
        const rest = carry + decoder.decode();
        if (rest) ctl.enqueue(encoder.encode(rest));
      },
    }),
  );
}

async function robots(res: Response, lines: string): Promise<Response> {
  const own = res.ok && /^text\/plain/i.test(res.headers.get("content-type") ?? "text/plain") ? await res.text() : "User-agent: *\nDisallow:\n";
  const body = `${own.replace(/\s*$/, "\n")}\n${lines}`;
  return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}

function normalisePrefix(p: string): string {
  const clean = `/${p.replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/.agent" : clean;
}

function pagePath(url: string): string {
  try {
    return normalisePath(new URL(url).pathname);
  } catch {
    return normalisePath(url);
  }
}

function normalisePath(p: string): string {
  let path = p;
  try {
    path = decodeURIComponent(p);
  } catch {
    // Keep the raw path.
  }
  path = path.replace(/\/index\.html?$/i, "/");
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}
