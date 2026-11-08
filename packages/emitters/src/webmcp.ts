import { fieldsToJsonSchema, type SiteGraph } from "@agenticweb-dev/core";

/**
 * WebMCP: tools a web page offers to the AI agent in the visitor's browser.
 * Spec: https://webmachinelearning.github.io/webmcp/ (W3C Community Group draft, 2 November 2026).
 *
 * The generated `webmcp.js` registers the same tools as the agent branch's MCP server with
 * `document.modelContext.registerTool()` (falling back to `navigator.modelContext`, used by early browser
 * builds). Each tool calls the agent branch over HTTP, so every rule stays on the server: input validation,
 * idempotency, limits and confirmation. The script does nothing in browsers without WebMCP.
 */

type Call =
  | { kind: "manifest" }
  | { kind: "search" }
  | { kind: "ask" }
  | { kind: "page"; slugs: string[] }
  | { kind: "entities"; files: Record<string, string> }
  | { kind: "action"; name: string }
  | { kind: "status" };

export type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean };
  call: Call;
};

export type WebMcpOptions = {
  /** True when /ask, /api/search and actions are served (not a static-only deploy). */
  runtime: boolean;
  /** Entity files by schema.org type, relative to the agent-branch root, e.g. { Product: "data/products.json" }. */
  entityFiles: Record<string, string>;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const readContent = { readOnlyHint: true, untrustedContentHint: true };

/** The tools a page on this site offers to browser agents. `g` must already be the public view. */
export function webMcpTools(g: SiteGraph, opts: WebMcpOptions): WebMcpTool[] {
  const types = Object.keys(opts.entityFiles);
  const slugs = g.pages.map((p) => p.slug);
  const tools: WebMcpTool[] = [
    {
      name: "site_info",
      title: "About this site",
      description: `What ${g.site.name} is, its contact details and what agents can do here.`,
      inputSchema: obj({}),
      annotations: readContent,
      call: { kind: "manifest" },
    },
    {
      name: "get_page",
      title: "Read a page",
      description: "One page of this site as clean Markdown.",
      inputSchema: obj({ slug: { type: "string", enum: slugs, description: "Which page" } }, ["slug"]),
      annotations: readContent,
      call: { kind: "page", slugs },
    },
  ];
  if (types.length)
    tools.push({
      name: "list_entities",
      title: "List items",
      description: `Structured items from this site (schema.org JSON-LD): ${types.join(", ")}.`,
      inputSchema: obj({ type: { type: "string", enum: types }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["type"]),
      annotations: readContent,
      call: { kind: "entities", files: opts.entityFiles },
    });
  if (!opts.runtime) return tools;

  tools.push(
    {
      name: "search",
      title: "Search this site",
      description: "Search the site's pages and data (products, menu items, services, FAQs, policies).",
      inputSchema: obj({ query: { type: "string" }, type: { type: "string", description: "Optional schema.org type, e.g. Product" }, limit: { type: "integer", minimum: 1, maximum: 25 } }, ["query"]),
      annotations: readContent,
      call: { kind: "search" },
    },
    {
      name: "ask",
      title: "Ask a question",
      description: "Ask about this site in plain language. Returns a short answer with sources, or says it doesn't know.",
      inputSchema: obj({ query: { type: "string" } }, ["query"]),
      annotations: readContent,
      call: { kind: "ask" },
    },
  );
  for (const a of g.actions) {
    tools.push({
      name: a.name,
      title: a.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      description: `${a.description} [${a.kind}; confirmation: ${a.confirmation}]${a.note ? ` ${a.note}` : ""}`,
      inputSchema: fieldsToJsonSchema(a.input),
      annotations: a.kind === "read" ? { readOnlyHint: true } : { consequentialHint: true },
      call: { kind: "action", name: a.name },
    });
  }
  if (g.actions.length)
    tools.push({
      name: "get_action_status",
      title: "Check an action",
      description: "Check an action you started, e.g. whether the guest confirmed a booking.",
      inputSchema: obj({ id: { type: "string" } }, ["id"]),
      annotations: { readOnlyHint: true },
      call: { kind: "status" },
    });
  return tools;
}

/** The browser script. Load it on every page: `<script src="{base}/webmcp.js" defer></script>`. */
export function buildWebMcpScript(g: SiteGraph, opts: WebMcpOptions): string {
  const tools = webMcpTools(g, opts);
  // Escape "<" so the JSON can never close a <script> element if someone inlines the file.
  const json = JSON.stringify(tools).replace(/</g, "\\u003c");
  return `// WebMCP tools for ${g.site.name.replace(/[\r\n]/g, " ")}, generated by AgenticWeb on ${g.generatedAt}.
// Lets the AI agent in a visitor's browser use this site's tools. Spec: https://webmachinelearning.github.io/webmcp/
(function () {
  "use strict";
  var mc = (typeof document !== "undefined" && document.modelContext) || (typeof navigator !== "undefined" && navigator.modelContext);
  if (!mc || typeof mc.registerTool !== "function") return;
  var script = document.currentScript;
  // This file sits at the root of the agent branch, so its own address tells us where everything else is.
  var base = new URL("./", script && script.src ? script.src : location.href);
  var TOOLS = ${json};

  function url(path, query) {
    var u = new URL(path, base);
    if (query) Object.keys(query).forEach(function (k) { if (query[k] !== undefined && query[k] !== null && query[k] !== "") u.searchParams.set(k, String(query[k])); });
    return u.toString();
  }
  function read(res) {
    var type = res.headers.get("content-type") || "";
    return type.indexOf("json") >= 0 ? res.json() : res.text();
  }
  function get(path, query) {
    return fetch(url(path, query), { headers: { accept: "application/json, text/markdown;q=0.9, */*;q=0.1" } }).then(function (res) {
      if (!res.ok) return read(res).then(function (body) { throw new Error((body && body.error) || "Request failed (" + res.status + ")"); });
      return read(res);
    });
  }
  function post(path, body, headers) {
    return fetch(url(path), { method: "POST", headers: Object.assign({ "content-type": "application/json", accept: "application/json" }, headers || {}), body: JSON.stringify(body) }).then(function (res) {
      return read(res).then(function (out) {
        if (res.status >= 500 || res.status === 404 || res.status === 429) throw new Error((out && out.error) || "Request failed (" + res.status + ")");
        return out; // 400 and 409 carry errors the agent can fix.
      });
    });
  }
  function key() {
    return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function run(t, input) {
    var c = t.call;
    input = input || {};
    switch (c.kind) {
      case "manifest": return get(".well-known/agent-site.json");
      case "page":
        if (c.slugs.indexOf(input.slug) < 0) return Promise.reject(new Error("No page \\"" + input.slug + "\\". Pages: " + c.slugs.join(", ")));
        return get("pages/" + encodeURIComponent(input.slug) + ".md");
      case "entities": {
        var file = c.files[input.type];
        if (!file) return Promise.reject(new Error("No items of type \\"" + input.type + "\\". Types: " + Object.keys(c.files).join(", ")));
        var offset = Number(input.offset || 0), limit = Number(input.limit || 50);
        return get(file).then(function (d) { return { type: input.type, total: d.count, offset: offset, items: (d.items || []).slice(offset, offset + limit) }; });
      }
      case "search": return get("api/search", { q: input.query, type: input.type, limit: input.limit });
      case "ask": return post("ask", { query: input.query });
      case "action": return post("api/" + c.name, input, { "idempotency-key": key() });
      case "status": return get("api/actions/" + encodeURIComponent(input.id));
    }
    return Promise.reject(new Error("Unknown tool"));
  }

  var controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  var registered = [];
  TOOLS.forEach(function (t) {
    var tool = { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, execute: function (input) { return run(t, input); } };
    try {
      var r = mc.registerTool(tool, controller ? { signal: controller.signal } : undefined);
      if (r && typeof r.then === "function") r.then(undefined, function () {});
      registered.push(r);
    } catch (e) {
      // A page script may have registered a tool with the same name; keep the rest.
    }
  });
  window.agenticwebWebMcp = {
    tools: TOOLS.map(function (t) { return t.name; }),
    unregister: function () {
      if (controller) controller.abort();
      registered.forEach(function (r) { if (r && typeof r.unregister === "function") r.unregister(); });
    },
  };
})();
`;
}
