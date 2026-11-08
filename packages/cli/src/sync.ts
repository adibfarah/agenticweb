import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDERS, type SiteGraph } from "@agenticweb-dev/core";
import { summarizeActivity, type ActionAudit, type ActivitySummary, type TrafficEvent } from "@agenticweb-dev/runtime";
import { Project, UserError } from "./project.ts";
import { cmdBuild, type BuildOptions } from "./commands.ts";

export type GraphDiff = {
  at: string;
  pages: { added: string[]; removed: string[]; changed: string[] };
  entities: { added: string[]; removed: string[]; changed: Array<{ name: string; fields: string[] }> };
  actions: { added: string[]; removed: string[] };
};

/** What changed between two builds, in terms an owner understands. */
export function diffGraphs(prev: SiteGraph | undefined, next: SiteGraph): GraphDiff {
  const at = next.generatedAt;
  if (!prev) {
    return { at, pages: { added: next.pages.map((p) => p.slug), removed: [], changed: [] }, entities: { added: next.entities.map((e) => e.name), removed: [], changed: [] }, actions: { added: next.actions.map((a) => a.name), removed: [] } };
  }
  const pPrev = new Map(prev.pages.map((p) => [p.url, p]));
  const pNext = new Map(next.pages.map((p) => [p.url, p]));
  const ePrev = new Map(prev.entities.map((e) => [e.id, e]));
  const eNext = new Map(next.entities.map((e) => [e.id, e]));
  const changedFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !k.startsWith("_") && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return {
    at,
    pages: {
      added: [...pNext.values()].filter((p) => !pPrev.has(p.url)).map((p) => p.slug),
      removed: [...pPrev.values()].filter((p) => !pNext.has(p.url)).map((p) => p.slug),
      changed: [...pNext.values()].filter((p) => pPrev.has(p.url) && pPrev.get(p.url)!.markdown !== p.markdown).map((p) => p.slug),
    },
    entities: {
      added: [...eNext.values()].filter((e) => !ePrev.has(e.id)).map((e) => e.name),
      removed: [...ePrev.values()].filter((e) => !eNext.has(e.id)).map((e) => e.name),
      changed: [...eNext.values()]
        .filter((e) => ePrev.has(e.id))
        .map((e) => ({ name: e.name, fields: changedFields(ePrev.get(e.id)!.data, e.data) }))
        .filter((c) => c.fields.length),
    },
    actions: {
      added: next.actions.filter((a) => !prev.actions.some((x) => x.name === a.name)).map((a) => a.name),
      removed: prev.actions.filter((a) => !next.actions.some((x) => x.name === a.name)).map((a) => a.name),
    },
  };
}

export function describeDiff(d: GraphDiff): string {
  const parts: string[] = [];
  const list = (label: string, xs: string[]) => xs.length && parts.push(`  ${label}: ${xs.slice(0, 8).join(", ")}${xs.length > 8 ? ` (+${xs.length - 8} more)` : ""}`);
  list("New pages", d.pages.added);
  list("Removed pages", d.pages.removed);
  list("Changed pages", d.pages.changed);
  list("New items", d.entities.added);
  list("Removed items", d.entities.removed);
  list("Changed items", d.entities.changed.map((c) => `${c.name} (${c.fields.join(", ")})`));
  list("New actions (off until you enable them)", d.actions.added);
  list("Removed actions", d.actions.removed);
  return parts.length ? parts.join("\n") : "  No changes.";
}

/** Rebuilds from the live site and records what changed in .agenticweb/changes.jsonl. */
export async function cmdSync(project: Project, opts: BuildOptions & { quiet?: boolean } = {}, out = { log: (m: string) => console.log(m) }): Promise<{ graph: SiteGraph; diff: GraphDiff }> {
  const prev = await project.graph();
  const quiet = { log: (m: string) => (opts.quiet ? undefined : out.log(m)) };
  const graph = await cmdBuild(project, opts, quiet);
  const diff = diffGraphs(prev, graph);
  await mkdir(project.dataDir, { recursive: true });
  await appendFile(path.join(project.dataDir, "changes.jsonl"), JSON.stringify(diff) + "\n");
  out.log(`Sync finished at ${graph.generatedAt}:\n${describeDiff(diff)}`);
  return { graph, diff };
}

/** Repeats sync on an interval until stopped (for a long-running server or a VM). */
export async function cmdSyncLoop(project: Project, minutes: number, opts: BuildOptions = {}, out = { log: (m: string) => console.log(m) }) {
  if (!(minutes >= 5)) throw new UserError("Use an interval of at least 5 minutes: agenticweb sync --every 60");
  out.log(`Syncing every ${minutes} minutes. Press Ctrl+C to stop.`);
  for (;;) {
    try {
      await cmdSync(project, { ...opts, quiet: true }, out);
    } catch (err) {
      out.log(`Sync failed: ${(err as Error).message}. Will retry next time.`);
    }
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

export async function loadActivity(project: Project, days = 7): Promise<ActivitySummary> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const traffic = await readJsonl<TrafficEvent>(path.join(project.dataDir, "traffic.jsonl"));
  const actionsFile = path.join(project.dataDir, "actions.json");
  const actions = existsSync(actionsFile) ? (JSON.parse(await readFile(actionsFile, "utf8")) as ActionAudit[]) : [];
  return summarizeActivity(traffic, actions, { since });
}

export async function cmdActivity(project: Project, days = 7, out = { log: (m: string) => console.log(m) }) {
  const s = await loadActivity(project, days);
  if (!s.requests && !s.actions.length) {
    out.log(`No agent activity recorded in the last ${days} days. Activity is recorded by \`agenticweb serve\` (and printed as JSON logs by deployed servers).`);
    return;
  }
  const rows = (xs: Array<[string, number]>) => (xs.length ? xs.map(([k, n]) => `    ${String(n).padStart(5)}  ${k}`).join("\n") : "    (none)");
  out.log(`Agent activity, last ${days} days: ${s.requests} requests, median ${s.p50ms} ms${s.errors ? `, ${s.errors} server errors` : ""}\n`);
  out.log(`  Agents:\n${rows(s.byAgent)}\n`);
  out.log(`  What they used:\n${rows(s.byKind)}\n`);
  out.log(`  Top questions:\n${rows(s.topQuestions)}\n`);
  if (s.unanswered.length) out.log(`  Questions your site couldn't answer (add this info to your site):\n${rows(s.unanswered)}\n`);
  if (s.topSearches.length) out.log(`  Top searches:\n${rows(s.topSearches)}\n`);
  if (s.actions.length) {
    out.log("  Actions:");
    for (const a of s.actions) out.log(`    ${a.action}: ${a.started} started, ${a.done} completed (${a.completionRate}%), ${a.pending} pending, ${a.declined} declined, ${a.expired} expired, ${a.failed} failed`);
  }
}

const WORKFLOW = (cron: string, target: string, aiKeyEnv: string) => `# Keeps your agent branch in sync with your site. Generated by AgenticWeb.
name: Sync agent branch
on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Rebuild the agent branch
        run: npx agenticweb-cli@latest build
        env:
          ${aiKeyEnv}: \${{ secrets.${aiKeyEnv} }}
          # The contents of .agenticweb/signing-key.json, so every build is signed with the same key.
          AGENTICWEB_SIGNING_KEY: \${{ secrets.AGENTICWEB_SIGNING_KEY }}
      - name: Agent Readiness tests (a task that used to pass and now fails stops the deploy)
        if: hashFiles('agenticweb.tests.json') != ''
        run: npx agenticweb-cli@latest test --strict
        env:
          ${aiKeyEnv}: \${{ secrets.${aiKeyEnv} }}
      - name: Keep the readiness report
        if: always() && hashFiles('agent-readiness/report.md') != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-readiness
          path: agent-readiness/
      - name: Deploy
        run: npx agenticweb-cli@latest deploy --target ${target}
${
  target === "cloudflare"
    ? `      - name: Publish to Cloudflare Pages
        run: npx wrangler pages deploy agent-branch --project-name \${{ vars.CF_PAGES_PROJECT }}
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`
    : target === "cloudflare-worker"
      ? `      - name: Publish the Worker
        working-directory: agent-worker
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`
      : ""
}      - name: Keep the build state for next time
        uses: actions/upload-artifact@v4
        with:
          name: agenticweb-state
          path: .agenticweb/site-graph.json
`;

/** Writes a GitHub Actions workflow that rebuilds and deploys on a schedule. */
export async function cmdCi(project: Project, opts: { every?: string; target?: string }, out = { log: (m: string) => console.log(m) }) {
  const config = await project.config();
  const hours = Number(opts.every ?? 6);
  if (!(hours >= 1 && hours <= 24)) throw new UserError("--every is in hours, between 1 and 24.");
  const cron = hours === 24 ? "17 3 * * *" : `17 */${hours} * * *`;
  const file = path.join(project.dir, ".github", "workflows", "agenticweb-sync.yml");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, WORKFLOW(cron, opts.target ?? config.deploy.target, config.llm.apiKeyEnv ?? PROVIDERS[config.llm.provider].apiKeyEnv));
  out.log(`Wrote ${path.relative(project.dir, file)}. It rebuilds every ${hours} hour(s).`);
  out.log("Add the repository secrets it uses (Settings → Secrets and variables → Actions), then commit the file.");
}
