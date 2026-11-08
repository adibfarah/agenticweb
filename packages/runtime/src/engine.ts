import type { ActionDef } from "@agenticweb-dev/core";

export type ActionStatus = "done" | "pending_confirmation" | "pending_owner" | "checkout_link" | "rejected" | "failed" | "expired";

export type ActionResult = {
  id?: string;
  status: ActionStatus;
  /** True when nothing else will happen for this request. */
  final: boolean;
  message: string;
  checkout_url?: string;
  expires_at?: string;
  data?: Record<string, unknown>;
  errors?: string[];
};

export type CallContext = {
  /** Who is calling: API key id, verified agent name, or "anonymous". */
  agent: string;
  ip: string;
  idempotencyKey?: string;
  /** Public base URL of the runtime, used to build confirmation links. */
  baseUrl: string;
  /** Payment credential an agent presented (header x-agent-payment-token), for payment protocol adapters. */
  paymentCredential?: string;
  /** True when the agent was identified by an API key the owner issued (not just its user agent). */
  agentFromKey?: boolean;
  /** How the agent was identified: a Web Bot Auth signature or an owner-issued API key. Unset means unverified. */
  agentVerifiedBy?: "web-bot-auth" | "api-key";
};

/** Runs actions. Implemented in Phase 3 by @agenticweb-dev/actions. */
export interface ActionEngine {
  actions(): ActionDef[];
  call(name: string, input: unknown, ctx: CallContext): Promise<ActionResult>;
  status(id: string): Promise<ActionResult | undefined>;
  /** Handles a confirmation link click from a guest or owner. */
  confirm(token: string, decision: "confirm" | "reject"): Promise<{ ok: boolean; message: string; result?: ActionResult }>;
  /** Describes what a confirmation link is about, for the confirmation page. */
  describe(token: string): Promise<{ title: string; details: Array<[string, string]>; who: "guest" | "owner" } | undefined>;
}
