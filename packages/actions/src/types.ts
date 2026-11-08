import type { ActionDef, Entity } from "@agenticweb-dev/core";

/** Environment variables / platform secrets. Connectors read secrets only from here. */
export type Env = Record<string, string | undefined>;

export type ConnectorResult = {
  status: "done" | "checkout_link" | "failed" | "rejected";
  message: string;
  checkout_url?: string;
  data?: Record<string, unknown>;
};

export type ExecuteArgs = {
  operation: string;
  input: Record<string, unknown>;
  /** The action's backend.config from the Site Graph (no secrets). */
  config: Record<string, unknown>;
  env: Env;
  fetch: typeof fetch;
};

/** A connector links actions to a real backend (Shopify, Cal.com, Stripe, your API, …). */
export interface Connector {
  id: string;
  /** Pull data and action definitions at build time. */
  sync?(config: Record<string, unknown>, deps: { env: Env; fetch: typeof fetch; siteUrl: string }): Promise<{ entities: Entity[]; actions: ActionDef[] }>;
  /** Optional pre-check before asking anyone to confirm (e.g. is the slot still free?). */
  check?(args: ExecuteArgs): Promise<{ ok: boolean; message?: string }>;
  execute(args: ExecuteArgs): Promise<ConnectorResult>;
}

export const nowIso = () => new Date().toISOString();

/** Reads a secret by env var name and explains clearly when it is missing. */
export function secret(env: Env, name: unknown, what: string): string {
  const key = typeof name === "string" ? name : "";
  const v = key ? env[key] : undefined;
  if (!v) throw new ConnectorError(`${what} is not configured: set the ${key || "API key"} environment variable.`);
  return v;
}

export class ConnectorError extends Error {}

export function provenance(url: string | undefined, via: "connector" = "connector") {
  return { url, via, seen: nowIso() } as const;
}
