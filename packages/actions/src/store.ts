import type { ActionResult } from "@agenticweb-dev/runtime";

/** One action request and everything that happened to it. This is the audit trail. */
export type ActionRecord = {
  id: string;
  action: string;
  input: Record<string, unknown>;
  agent: string;
  /** How the agent was identified ("web-bot-auth", "api-key"); missing means unverified. */
  agentVerifiedBy?: "web-bot-auth" | "api-key";
  ip: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  confirmToken?: string;
  confirmBy?: "guest" | "owner";
  /** Where the confirmation link was sent (masked in public output). */
  contact?: string;
  result: ActionResult;
  history: Array<{ at: string; event: string; detail?: string }>;
};

export interface ActionStore {
  get(id: string): Promise<ActionRecord | undefined>;
  put(rec: ActionRecord): Promise<void>;
  byToken(token: string): Promise<ActionRecord | undefined>;
  byIdempotency(action: string, key: string): Promise<ActionRecord | undefined>;
  /** Count of requests for an action by an agent since a time (for per-agent limits). */
  countSince(action: string, agent: string, sinceIso: string): Promise<number>;
  list(limit?: number): Promise<ActionRecord[]>;
}

export class MemoryStore implements ActionStore {
  protected records = new Map<string, ActionRecord>();

  async get(id: string) {
    return this.records.get(id);
  }
  async put(rec: ActionRecord) {
    this.records.set(rec.id, structuredClone(rec));
  }
  async byToken(token: string) {
    for (const r of this.records.values()) if (r.confirmToken === token) return r;
    return undefined;
  }
  async byIdempotency(action: string, key: string) {
    for (const r of this.records.values()) if (r.action === action && r.idempotencyKey === key) return r;
    return undefined;
  }
  async countSince(action: string, agent: string, sinceIso: string) {
    let n = 0;
    for (const r of this.records.values()) if (r.action === action && r.agent === agent && r.createdAt >= sinceIso) n++;
    return n;
  }
  async list(limit = 100) {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}
