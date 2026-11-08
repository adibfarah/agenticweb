import type { TrafficEvent } from "./app.ts";

/** Minimal shape of an action audit record (see @agenticweb-dev/actions ActionRecord). */
export type ActionAudit = { action: string; agent: string; createdAt: string; result: { status: string } };

export type ActivitySummary = {
  from: string;
  to: string;
  requests: number;
  byAgent: Array<[string, number]>;
  byKind: Array<[string, number]>;
  topQuestions: Array<[string, number]>;
  unanswered: Array<[string, number]>;
  topSearches: Array<[string, number]>;
  topPages: Array<[string, number]>;
  actions: Array<{ action: string; started: number; done: number; pending: number; declined: number; expired: number; failed: number; completionRate: number }>;
  errors: number;
  p50ms: number;
};

const top = (m: Map<string, number>, n = 10, display?: Map<string, string>): Array<[string, number]> =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]): [string, number] => [display?.get(k) ?? k, v]);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Turns raw traffic events and action records into the numbers an owner cares about. */
export function summarizeActivity(events: TrafficEvent[], actions: ActionAudit[], opts: { since?: string } = {}): ActivitySummary {
  const ev = opts.since ? events.filter((e) => e.ts >= opts.since!) : events;
  const acts = opts.since ? actions.filter((a) => a.createdAt >= opts.since!) : actions;
  const byAgent = new Map<string, number>();
  const byKind = new Map<string, number>();
  const questions = new Map<string, number>();
  const unanswered = new Map<string, number>();
  const searches = new Map<string, number>();
  const pages = new Map<string, number>();
  const shown = new Map<string, string>();
  let errors = 0;
  for (const e of ev) {
    bump(byAgent, e.agent);
    bump(byKind, e.kind);
    if (e.status >= 500) errors++;
    const q = e.detail?.trim().toLowerCase();
    // Count questions case-insensitively, but show them as first asked.
    if (q && !shown.has(q)) shown.set(q, e.detail!.trim());
    // Questions come in through /ask and through the MCP ask tool.
    if ((e.kind === "ask" || (e.kind === "mcp" && e.ok !== undefined)) && q) {
      bump(questions, q);
      if (e.ok === false) bump(unanswered, q);
    }
    if (e.kind === "search" && q) bump(searches, q);
    if (e.kind === "file" && e.status === 200) bump(pages, e.path);
  }
  const perAction = new Map<string, ActivitySummary["actions"][number]>();
  for (const a of acts) {
    const s = perAction.get(a.action) ?? { action: a.action, started: 0, done: 0, pending: 0, declined: 0, expired: 0, failed: 0, completionRate: 0 };
    s.started++;
    const st = a.result.status;
    if (st === "done" || st === "checkout_link") s.done++;
    else if (st.startsWith("pending")) s.pending++;
    else if (st === "rejected") s.declined++;
    else if (st === "expired") s.expired++;
    else if (st === "failed") s.failed++;
    perAction.set(a.action, s);
  }
  for (const s of perAction.values()) s.completionRate = s.started ? Math.round((s.done / s.started) * 100) : 0;
  const ms = ev.map((e) => e.ms).sort((a, b) => a - b);
  const times = [...ev.map((e) => e.ts), ...acts.map((a) => a.createdAt)].sort();
  return {
    from: times[0] ?? "",
    to: times.at(-1) ?? "",
    requests: ev.length,
    byAgent: top(byAgent),
    byKind: top(byKind),
    topQuestions: top(questions, 10, shown),
    unanswered: top(unanswered, 10, shown),
    topSearches: top(searches, 10, shown),
    topPages: top(pages),
    actions: [...perAction.values()].sort((a, b) => b.started - a.started),
    errors,
    p50ms: ms.length ? ms[Math.floor(ms.length / 2)]! : 0,
  };
}
