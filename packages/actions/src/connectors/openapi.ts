import type { ActionDef, ActionField } from "@agenticweb-dev/core";
import { ConnectorError, provenance, type Connector } from "../types.ts";

/**
 * Bring your own API: turn selected OpenAPI operations into actions.
 * Config: { spec: "https://api.example.com/openapi.json", operations: ["createReservation", ...], baseUrl?: string,
 *           auth?: { header: "authorization", env: "MY_API_TOKEN", prefix?: "Bearer " },
 *           confirmation?: { createReservation: "guest" } }
 * Supports JSON request bodies with flat properties plus path/query parameters.
 */
type OpenApiDoc = { servers?: Array<{ url: string }>; paths: Record<string, Record<string, OpenApiOp>> };
type OpenApiOp = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: JsonSchema }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
};
type JsonSchema = { type?: string; format?: string; enum?: string[]; description?: string; properties?: Record<string, JsonSchema>; required?: string[]; minimum?: number; maximum?: number };

function fieldFrom(name: string, s: JsonSchema = {}, required = false): ActionField {
  const base = { name: name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([^a-z])/i, "f_$1").toLowerCase(), description: s.description ?? "", required };
  if (s.enum) return { ...base, type: "enum", enum: s.enum.map(String) };
  if (s.type === "integer") return { ...base, type: "integer", ...(s.minimum !== undefined ? { min: s.minimum } : {}), ...(s.maximum !== undefined ? { max: s.maximum } : {}) };
  if (s.type === "number") return { ...base, type: "number" };
  if (s.type === "boolean") return { ...base, type: "boolean" };
  if (s.format === "email") return { ...base, type: "email" };
  if (s.format === "date") return { ...base, type: "date" };
  if (s.format === "date-time") return { ...base, type: "datetime" };
  return { ...base, type: "string" };
}

async function loadSpec(config: Record<string, unknown>, f: typeof fetch): Promise<OpenApiDoc> {
  if (typeof config.spec === "object" && config.spec) return config.spec as OpenApiDoc;
  if (typeof config.spec !== "string") throw new ConnectorError("OpenAPI connector needs config.spec (a URL or the spec object).");
  const res = await f(config.spec);
  if (!res.ok) throw new ConnectorError(`Couldn't load the OpenAPI spec (HTTP ${res.status}).`);
  return (await res.json()) as OpenApiDoc;
}

function findOp(doc: OpenApiDoc, id: string): { path: string; method: string; op: OpenApiOp } | undefined {
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) if (op.operationId === id) return { path, method: method.toUpperCase(), op };
  }
  return undefined;
}

export const openapi: Connector = {
  id: "openapi",

  async sync(config, { fetch: f, siteUrl }) {
    const doc = await loadSpec(config, f);
    const baseUrl = String(config.baseUrl ?? doc.servers?.[0]?.url ?? siteUrl).replace(/\/$/, "");
    const wanted = (config.operations as string[] | undefined) ?? [];
    const actions: ActionDef[] = [];
    for (const id of wanted) {
      const hit = findOp(doc, id);
      if (!hit) throw new ConnectorError(`Operation "${id}" isn't in the OpenAPI spec.`);
      const body = hit.op.requestBody?.content?.["application/json"]?.schema;
      const fields: ActionField[] = [
        ...(hit.op.parameters ?? []).filter((p) => p.in === "path" || p.in === "query").map((p) => fieldFrom(p.name, { ...p.schema, description: p.description }, p.required || p.in === "path")),
        ...Object.entries(body?.properties ?? {}).map(([k, s]) => fieldFrom(k, s, body?.required?.includes(k))),
      ];
      const kind = hit.method === "GET" ? "read" : "write";
      const confirmation = ((config.confirmation as Record<string, string> | undefined)?.[id] ?? (kind === "read" ? "none" : "owner")) as ActionDef["confirmation"];
      const name = id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
      actions.push({
        name,
        description: hit.op.summary ?? hit.op.description ?? id,
        kind,
        input: fields,
        backend: {
          type: "openapi",
          operation: id,
          config: {
            baseUrl,
            path: hit.path,
            method: hit.method,
            params: (hit.op.parameters ?? []).filter((p) => p.in === "path" || p.in === "query").map((p) => ({ name: p.name, in: p.in })),
            ...(config.auth ? { auth: config.auth } : {}),
          },
        },
        confirmation,
        ...(kind === "write" ? { idempotency: "required" as const } : {}),
        limits: { perAgentPerHour: kind === "read" ? 120 : 20 },
        enabled: false,
        source: provenance(typeof config.spec === "string" ? config.spec : baseUrl),
      });
    }
    return { entities: [], actions };
  },

  async execute(a) {
    const c = a.config as { baseUrl: string; path: string; method: string; params: Array<{ name: string; in: string }>; auth?: { header: string; env: string; prefix?: string } };
    let path = c.path;
    const url = new URL(c.baseUrl);
    const body: Record<string, unknown> = {};
    const paramNames = new Map(c.params.map((p) => [p.name.toLowerCase().replace(/[^a-z0-9_]/g, "_"), p]));
    for (const [k, v] of Object.entries(a.input)) {
      const p = paramNames.get(k);
      if (p?.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
      else if (p?.in === "query") url.searchParams.set(p.name, String(v));
      else body[k] = v;
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (c.auth) {
      const token = a.env[c.auth.env];
      if (!token) throw new ConnectorError(`Set the ${c.auth.env} environment variable for this API.`);
      headers[c.auth.header] = `${c.auth.prefix ?? ""}${token}`;
    }
    const res = await a.fetch(url, { method: c.method, headers, body: c.method === "GET" ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { status: res.status === 409 || res.status === 422 ? "rejected" : "failed", message: String(json.message ?? json.error ?? `The API returned HTTP ${res.status}.`) };
    return { status: "done", message: String(json.message ?? "Done."), data: json };
  },
};
