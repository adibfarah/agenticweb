import type { ActionRecord, ActionStore } from "./store.ts";

/** The subset of a Cloudflare KV namespace (or any similar key-value store) the action store needs. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list?(opts: { prefix: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
}

const DAY = 86_400;

/**
 * Action store on a key-value store such as Cloudflare Workers KV.
 * KV is eventually consistent, which is fine for confirmations (seconds to minutes apart).
 * Records are kept for 90 days as the audit trail.
 */
export class KvStore implements ActionStore {
  private kv: KvLike;
  constructor(kv: KvLike) {
    this.kv = kv;
  }

  async get(id: string) {
    const v = await this.kv.get(`rec:${id}`);
    return v ? (JSON.parse(v) as ActionRecord) : undefined;
  }

  async put(rec: ActionRecord) {
    const ttl = 90 * DAY;
    const first = !(await this.kv.get(`rec:${rec.id}`));
    await this.kv.put(`rec:${rec.id}`, JSON.stringify(rec), { expirationTtl: ttl });
    if (rec.confirmToken) await this.kv.put(`tok:${rec.confirmToken}`, rec.id, { expirationTtl: 2 * DAY });
    if (rec.idempotencyKey) await this.kv.put(`idem:${rec.action}:${rec.idempotencyKey}`, rec.id, { expirationTtl: 2 * DAY });
    if (first) {
      const bucket = `cnt:${rec.action}:${rec.agent}:${rec.createdAt.slice(0, 13)}`;
      const n = Number((await this.kv.get(bucket)) ?? 0);
      await this.kv.put(bucket, String(n + 1), { expirationTtl: 2 * 3600 });
    }
  }

  async byToken(token: string) {
    const id = await this.kv.get(`tok:${token}`);
    return id ? this.get(id) : undefined;
  }

  async byIdempotency(action: string, key: string) {
    const id = await this.kv.get(`idem:${action}:${key}`);
    return id ? this.get(id) : undefined;
  }

  /** Approximate: counts this hour and the previous one. */
  async countSince(action: string, agent: string, sinceIso: string) {
    const hours = [sinceIso.slice(0, 13), new Date().toISOString().slice(0, 13)];
    let n = 0;
    for (const h of new Set(hours)) n += Number((await this.kv.get(`cnt:${action}:${agent}:${h}`)) ?? 0);
    return n;
  }

  async list(limit = 100) {
    if (!this.kv.list) return [];
    const { keys } = await this.kv.list({ prefix: "rec:", limit });
    const recs = await Promise.all(keys.map((k) => this.kv.get(k.name)));
    return recs.filter((r): r is string => Boolean(r)).map((r) => JSON.parse(r) as ActionRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
