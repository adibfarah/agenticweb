import { ProjectConfig, type SiteGraph } from "@agenticweb-dev/core";
import { crawl } from "@agenticweb-dev/ingest";
import { understand, type Llm } from "@agenticweb-dev/understand";
import { createApp } from "@agenticweb-dev/runtime";
import { OutboxNotifier, calcom, createEngine, shopify } from "@agenticweb-dev/actions";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { lookupTasks, matches, type LookupTask } from "./tasks.ts";

/** Rough token estimate (~4 characters per token for English text and HTML). */
export const tokens = (chars: number) => Math.ceil(chars / 4);

export type ArmResult = { success: boolean; requests: number; tokens: number; note?: string };
export type TaskResult = { id: string; site: string; question: string; human: ArmResult; agent: ArmResult };

const visibleText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/**
 * Arm A: an idealised agent on the human site. It reads raw HTML pages breadth-first from the home page and
 * stops the moment the answer is visible. A real agent does worse (it has to recognise the answer and pick links),
 * so this is a best case for the human site.
 */
export async function humanArm(origin: string, task: LookupTask, maxPages = 30): Promise<ArmResult> {
  const queue = [`${origin}/`];
  const seen = new Set(queue);
  let requests = 0;
  let chars = 0;
  while (queue.length && requests < maxPages) {
    const url = queue.shift()!;
    const res = await fetch(url);
    requests++;
    const html = await res.text();
    chars += html.length;
    if (matches(visibleText(html), task.expect)) return { success: true, requests, tokens: tokens(chars) };
    for (const m of html.matchAll(/href="([^"#]+)"/g)) {
      try {
        const u = new URL(m[1]!, url);
        if (u.origin === origin && !seen.has(u.href) && !/\.(css|js|png|jpg|pdf)$/.test(u.pathname) && !u.pathname.startsWith("/cart")) {
          seen.add(u.href);
          queue.push(u.href);
        }
      } catch {
        // ignore bad links
      }
    }
  }
  return { success: false, requests, tokens: tokens(chars), note: "answer not found in visible HTML" };
}

/** Arm B: the agent branch. One /ask request; success when the answer contains the expected facts. */
export async function agentArm(app: ReturnType<typeof createApp>, task: LookupTask): Promise<ArmResult> {
  const res = await app.fetch(new Request(`https://agents.test/ask?q=${encodeURIComponent(task.question)}`));
  const body = await res.text();
  const answer = (JSON.parse(body) as { answer: string }).answer;
  return { success: matches(answer, task.expect), requests: 1, tokens: tokens(body.length) };
}

export type BenchReport = {
  mode: "heuristic" | "claude";
  lookups: TaskResult[];
  actions: Array<{ id: string; human: ArmResult; agent: ArmResult }>;
  totals: { human: { success: number; requests: number; tokens: number }; agent: { success: number; requests: number; tokens: number }; tasks: number };
};

async function graphFor(origin: string, llm?: Llm): Promise<SiteGraph> {
  return understand(await crawl(origin), { siteUrl: origin, llm });
}

/** Runs every task against both arms on the demo sites. */
export async function runBenchmark(opts: { llm?: Llm; sites?: DemoSites } = {}): Promise<BenchReport> {
  const sites = opts.sites ?? (await startDemoSites());
  try {
    const origins = { restaurant: sites.restaurant, shop: sites.shop, docs: sites.docs };
    const graphs = {
      restaurant: await graphFor(origins.restaurant, opts.llm),
      shop: await graphFor(origins.shop, opts.llm),
      docs: await graphFor(origins.docs, opts.llm),
    };
    const apps = { restaurant: createApp({ graph: graphs.restaurant }), shop: createApp({ graph: graphs.shop }), docs: createApp({ graph: graphs.docs }) };

    const lookups: TaskResult[] = [];
    for (const t of lookupTasks) {
      lookups.push({ id: t.id, site: t.site, question: t.question, human: await humanArm(origins[t.site], t), agent: await agentArm(apps[t.site], t) });
    }

    // Action tasks.
    const actions: BenchReport["actions"] = [];
    {
      // Booking: the human site needs the booking page read, the form understood, and the form submitted.
      const book = await (await fetch(`${origins.restaurant}/book.html`)).text();
      const home = await (await fetch(`${origins.restaurant}/`)).text();
      const human: ArmResult = { success: true, requests: 3, tokens: tokens(home.length + book.length + 200), note: "form submitted blind; no machine-readable result or confirmation" };
      const cfg = ProjectConfig.parse({ site: origins.restaurant });
      const { actions: defs } = await calcom.sync!({ baseUrl: `${origins.restaurant}/calcom`, eventTypeId: 1, timeZone: "America/Los_Angeles" }, { env: {}, fetch, siteUrl: origins.restaurant });
      const g = { ...graphs.restaurant, actions: defs.map((a) => ({ ...a, enabled: true })) };
      const engine = createEngine({ graph: g, config: cfg, env: { CALCOM_API_KEY: "bench" }, notifier: new OutboxNotifier() });
      const app = createApp({ graph: g, engine });
      const r1 = await app.fetch(new Request("https://agents.test/api/check_availability", { method: "POST", body: JSON.stringify({ date: "2026-12-04" }) }));
      const t1 = await r1.text();
      const r2 = await app.fetch(new Request("https://agents.test/api/request_booking", { method: "POST", headers: { "idempotency-key": "bench-1" }, body: JSON.stringify({ date: "2026-12-04", time: "19:00", party_size: 2, name: "Bench", email: "bench@example.com" }) }));
      const t2 = await r2.text();
      actions.push({ id: "book-table", human, agent: { success: r2.status === 202, requests: 2, tokens: tokens(t1.length + t2.length), note: "guest confirms by email; status is machine-readable" } });
    }
    {
      // Checkout: on the human site, stock is loaded by JavaScript and the cart needs browser automation.
      const list = await (await fetch(`${origins.shop}/collections/all`)).text();
      const page = await (await fetch(`${origins.shop}/products/classic-hoodie`)).text();
      const human: ArmResult = { success: false, requests: 2, tokens: tokens(list.length + page.length), note: "variant stock is rendered by JavaScript; adding to cart needs a browser session" };
      const { actions: defs } = await shopify.sync!({ store: origins.shop }, { env: {}, fetch, siteUrl: origins.shop });
      const g = { ...graphs.shop, actions: defs.map((a) => ({ ...a, enabled: true })) };
      const engine = createEngine({ graph: g, config: ProjectConfig.parse({ site: origins.shop }), env: {}, notifier: new OutboxNotifier() });
      const app = createApp({ graph: g, engine });
      const r = await app.fetch(new Request("https://agents.test/api/create_checkout_link", { method: "POST", body: JSON.stringify({ items: [{ sku: "50012", quantity: 1 }] }) }));
      const t = await r.text();
      actions.push({ id: "checkout-blue-hoodie-m", human, agent: { success: JSON.parse(t).status === "checkout_link", requests: 1, tokens: tokens(t.length) } });
    }

    const all = [...lookups, ...actions];
    const sum = (arm: "human" | "agent") => ({
      success: all.filter((x) => x[arm].success).length,
      requests: all.reduce((s, x) => s + x[arm].requests, 0),
      tokens: all.reduce((s, x) => s + x[arm].tokens, 0),
    });
    return { mode: opts.llm ? "claude" : "heuristic", lookups, actions, totals: { human: sum("human"), agent: sum("agent"), tasks: all.length } };
  } finally {
    if (!opts.sites) await sites.close();
  }
}

export function reportMarkdown(r: BenchReport): string {
  const pct = (n: number) => `${Math.round((n / r.totals.tasks) * 100)}%`;
  const row = (id: string, h: ArmResult, a: ArmResult) => `| ${id} | ${h.success ? "yes" : "no"} | ${h.requests} | ${h.tokens.toLocaleString("en-US")} | ${a.success ? "yes" : "no"} | ${a.requests} | ${a.tokens.toLocaleString("en-US")} |`;
  const t = r.totals;
  return [
    `# Benchmark results`,
    "",
    `Extraction mode: **${r.mode}** (${r.mode === "heuristic" ? "no API key; built-in rules only" : "Claude"}). Generated by \`npm run bench\`.`,
    "",
    "| | Tasks done | Requests | Tokens read (est.) |",
    "|---|---|---|---|",
    `| Human site (best case) | ${t.human.success}/${t.tasks} (${pct(t.human.success)}) | ${t.human.requests} | ${t.human.tokens.toLocaleString("en-US")} |`,
    `| Agent branch | ${t.agent.success}/${t.tasks} (${pct(t.agent.success)}) | ${t.agent.requests} | ${t.agent.tokens.toLocaleString("en-US")} |`,
    "",
    `The agent branch read **${Math.round((1 - t.agent.tokens / t.human.tokens) * 100)}% fewer tokens** with **${Math.round((1 - t.agent.requests / t.human.requests) * 100)}% fewer requests**.`,
    "",
    "## Per task",
    "",
    "| Task | Human: done | Human: requests | Human: tokens | Agent: done | Agent: requests | Agent: tokens |",
    "|---|---|---|---|---|---|---|",
    ...r.lookups.map((x) => row(`${x.site}: ${x.id}`, x.human, x.agent)),
    ...r.actions.map((x) => row(`action: ${x.id}`, x.human, x.agent)),
    "",
    "## How to read this",
    "",
    "- **Human site** is an idealised agent that reads raw HTML pages from the home page and stops the moment the answer appears. Real agents do worse: they must recognise the answer and choose links, and they often render pages and screenshots, which costs far more tokens.",
    "- **Agent branch** sends one `/ask` request per question (or the action's API calls).",
    "- Tokens are estimated as characters ÷ 4.",
    "- Action notes: " + r.actions.map((a) => `${a.id}: human site ${a.human.note}${a.agent.note ? `; agent branch ${a.agent.note}` : ""}`).join(". ") + ".",
    "",
  ].join("\n");
}
