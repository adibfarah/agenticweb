/** In-memory token bucket per client. Good for one instance; use your platform's limiter when scaling out. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  private perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, updated: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.updated) / 60_000) * this.perMinute);
    b.updated = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(now);
    return ok;
  }

  private prune(now: number) {
    for (const [k, b] of this.buckets) if (now - b.updated > 120_000) this.buckets.delete(k);
  }
}
