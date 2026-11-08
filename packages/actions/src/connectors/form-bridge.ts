import { ConnectorError, type Connector } from "../types.ts";

/**
 * Fallback: submits the site's own HTML form from the server, as a browser would.
 * Off by default, because forms change without notice and have no machine-readable result.
 * Config (written by discovery): { action: <form URL>, method: "POST" | "GET", fieldMap?: { agentField: "html_field_name" } }
 */
const ERROR_HINT = /\b(error|invalid|required|sorry|failed|not available|fully booked|try again)\b/i;

export const formBridge: Connector = {
  id: "form-bridge",
  async execute(a) {
    if (a.operation !== "submit" || !a.config.action) throw new ConnectorError("Form bridge needs the form's action URL.");
    const map = (a.config.fieldMap as Record<string, string> | undefined) ?? {};
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(a.input)) params.set(map[k] ?? k, String(v));
    const method = String(a.config.method ?? "POST").toUpperCase();
    const target = new URL(String(a.config.action));
    if (method === "GET") params.forEach((v, k) => target.searchParams.set(k, v));
    const res = await a.fetch(target, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "AgenticWeb/0.1 (form bridge)", ...(a.config.page ? { referer: String(a.config.page) } : {}) },
      body: method === "GET" ? undefined : params,
      redirect: "follow",
    });
    const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!res.ok) return { status: res.status === 409 || res.status === 422 ? "rejected" : "failed", message: text || `The site's form returned HTTP ${res.status}.` };
    if (ERROR_HINT.test(text) && !/thank/i.test(text)) return { status: "failed", message: `The site's form may not have accepted this: "${text}"` };
    return { status: "done", message: text ? `The site replied: "${text}"` : "Submitted." };
  },
};
