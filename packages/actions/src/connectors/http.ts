import { ConnectorError, type Connector } from "../types.ts";

/**
 * Sends the action input as JSON to the owner's own endpoint.
 * Config: { url: "https://api.example.com/bookings", method?: "POST", headers?: { "x-api-key": "env:MY_KEY" } }
 * Header values written as "env:NAME" are read from environment variables, so secrets never sit in config.
 * The endpoint should reply 2xx with optional JSON { message?, checkout_url?, data? }.
 */
export const http: Connector = {
  id: "http",
  async execute(a) {
    if (!a.config.url) throw new ConnectorError("HTTP connector needs config.url.");
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "AgenticWeb/0.1" };
    for (const [k, v] of Object.entries((a.config.headers as Record<string, string>) ?? {})) {
      headers[k] = v.startsWith("env:") ? (a.env[v.slice(4)] ?? "") : v;
      if (!headers[k]) throw new ConnectorError(`Missing environment variable ${v.slice(4)} for header ${k}.`);
    }
    const res = await a.fetch(String(a.config.url), {
      method: String(a.config.method ?? "POST"),
      headers,
      body: JSON.stringify({ operation: a.operation, input: a.input }),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string; checkout_url?: string; data?: Record<string, unknown> };
    if (!res.ok) return { status: res.status === 409 || res.status === 422 ? "rejected" : "failed", message: body.message ?? `The site's system returned HTTP ${res.status}.` };
    return body.checkout_url
      ? { status: "checkout_link", message: body.message ?? "Checkout link ready.", checkout_url: body.checkout_url, data: body.data }
      : { status: "done", message: body.message ?? "Done.", data: body.data };
  },
};
