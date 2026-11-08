import type { ActionDef, Entity, ProjectConfig, SiteGraph } from "@agenticweb-dev/core";
import { Engine } from "./engine.ts";
import { MemoryStore, type ActionStore, type ActionRecord } from "./store.ts";
import { MultiNotifier, OutboxNotifier, ResendNotifier, WebhookNotifier, type Notice, type Notifier } from "./notify.ts";
import { builtinConnectors } from "./connectors/index.ts";
import type { Connector, Env } from "./types.ts";
import type { PaymentAdapter } from "./payments.ts";

/** Pulls data and action definitions from every configured source (run at build time). */
export async function syncSources(
  config: ProjectConfig,
  deps: { env: Env; fetch?: typeof fetch; connectors?: Record<string, Connector>; log?: (m: string) => void },
): Promise<{ entities: Entity[]; actions: ActionDef[] }> {
  const connectors = { ...builtinConnectors, ...deps.connectors };
  const entities: Entity[] = [];
  const actions: ActionDef[] = [];
  for (const src of config.sources) {
    const c = connectors[src.type];
    if (!c) throw new Error(`Unknown source type "${src.type}". Available: ${Object.keys(connectors).join(", ")}`);
    if (!c.sync) continue;
    deps.log?.(`Reading ${src.type}…`);
    const r = await c.sync(src.config, { env: deps.env, fetch: deps.fetch ?? fetch, siteUrl: config.site });
    deps.log?.(`  ${src.type}: ${r.entities.length} items, ${r.actions.length} actions`);
    entities.push(...r.entities);
    actions.push(...r.actions);
  }
  return { entities, actions };
}

/** Builds the notifier described by the config. `outbox` collects messages for local testing. */
export function createNotifier(config: ProjectConfig, env: Env, opts: { outboxSink?: (n: Notice) => void; fetch?: typeof fetch } = {}): Notifier {
  const list: Notifier[] = [];
  const n = config.notifications;
  if (n.email === "resend") {
    const key = env[n.apiKeyEnv];
    if (!key) throw new Error(`Email is set to Resend but ${n.apiKeyEnv} isn't set.`);
    if (!n.from) throw new Error('Set notifications.from (a sender address verified with Resend), e.g. "Bella Cucina <bookings@bellacucina.example>".');
    list.push(new ResendNotifier(key, n.from, opts.fetch));
  } else if (n.email === "outbox") {
    list.push(new OutboxNotifier(opts.outboxSink));
  }
  if (n.webhookUrl) list.push(new WebhookNotifier(n.webhookUrl, opts.fetch));
  return list.length === 1 ? list[0]! : new MultiNotifier(list);
}

/** Parses "key1:agent-a,key2:agent-b" into a lookup table. */
export function parseApiKeys(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [k, name] = pair.split(":").map((s) => s.trim());
    if (k) out[k] = name || "agent";
  }
  return out;
}

export function createEngine(opts: {
  graph: SiteGraph;
  config: ProjectConfig;
  env: Env;
  store?: ActionStore;
  notifier?: Notifier;
  connectors?: Record<string, Connector>;
  fetch?: typeof fetch;
  onEvent?: (rec: ActionRecord, event: string) => void;
  payments?: Record<string, PaymentAdapter>;
}): Engine {
  return new Engine({
    graph: opts.graph,
    connectors: { ...builtinConnectors, ...opts.connectors },
    store: opts.store ?? new MemoryStore(),
    notifier: opts.notifier ?? createNotifier(opts.config, opts.env, { fetch: opts.fetch }),
    env: opts.env,
    fetch: opts.fetch,
    ownerContact: opts.config.notifications.ownerEmail ?? opts.graph.site.contact.email,
    holdMinutes: opts.config.runtime.holdMinutes,
    onEvent: opts.onEvent,
    payments: opts.payments,
  });
}
