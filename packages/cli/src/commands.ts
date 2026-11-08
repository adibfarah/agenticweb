import path from "node:path";
import { ActionDef, ProjectConfig, entitiesByType, type ProjectConfigInput, type SiteGraph } from "@agenticweb-dev/core";
import { crawl, isLocalHost, newVerifyToken, verifyOwnership } from "@agenticweb-dev/ingest";
import { ClaudeLlm, hasClaudeCredentials, understand, type Llm } from "@agenticweb-dev/understand";
import { discoverySnippets, emitAgentBranch } from "@agenticweb-dev/emitters";
import { Project, UserError, writeFiles } from "./project.ts";

export type Out = { log: (msg: string) => void };
const stdout: Out = { log: (m) => console.log(m) };

export async function cmdInit(project: Project, url: string, opts: { name?: string; force?: boolean } = {}, out: Out = stdout) {
  let site: string;
  try {
    site = new URL(url).toString().replace(/\/$/, "/");
  } catch {
    throw new UserError(`"${url}" is not a valid URL. Example: agenticweb init https://mysite.com`);
  }
  if (project.exists() && !opts.force) throw new UserError("This folder already has an agenticweb.config.json (use --force to overwrite).");
  const config: ProjectConfigInput = { site, ...(opts.name ? { name: opts.name } : {}) };
  await project.saveConfig(ProjectConfig.parse(config));
  const token = newVerifyToken();
  await project.saveState({ verifyToken: token });
  out.log(`Created agenticweb.config.json for ${site}`);
  if (isLocalHost(site)) {
    out.log("Local development site: ownership check skipped.");
  } else {
    const r = await verifyOwnership(site, token);
    if (r.verified) {
      await project.saveState({ verifyToken: token, ownership: r });
      out.log(`Ownership verified (${r.method}).`);
    } else {
      out.log(`\n${r.instructions}\n\nThen run: agenticweb verify`);
    }
  }
  out.log("Next: agenticweb build");
}

export async function cmdVerify(project: Project, out: Out = stdout) {
  const config = await project.config();
  const state = await project.state();
  const r = await verifyOwnership(config.site, state.verifyToken);
  if (!r.verified) throw new UserError(r.instructions ?? "Not verified.");
  await project.saveState({ ...state, ownership: { verified: true, method: r.method, verifiedAt: r.verifiedAt } });
  out.log(`Ownership of ${new URL(config.site).hostname} verified (${r.method}).`);
}

export type BuildOptions = {
  llm?: Llm | false;
  runtime?: boolean;
  outDir?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Check facts against the human pages and sign them (default on). */
  parity?: boolean;
  /** Extra data from connectors (Phase 3 wires these in). */
  connectors?: (config: ProjectConfig) => Promise<{ entities: SiteGraph["entities"]; actions: SiteGraph["actions"] }>;
};

export async function cmdBuild(project: Project, opts: BuildOptions = {}, out: Out = stdout): Promise<SiteGraph> {
  const config = await project.config();
  const state = await project.state();
  const local = isLocalHost(config.site);
  if (!local && !state.ownership?.verified) {
    throw new UserError("Ownership of this site isn't verified yet. Run: agenticweb verify");
  }
  const previous = await project.graph();

  out.log(`Crawling ${config.site} (up to ${config.crawl.maxPages} pages)…`);
  const c = await crawl(config.site, {
    maxPages: config.crawl.maxPages,
    include: config.crawl.include,
    exclude: config.crawl.exclude,
    respectRobots: config.crawl.respectRobots,
    concurrency: config.crawl.concurrency,
    render: config.crawl.render,
    previousHashes: new Map(previous?.pages.map((p) => [p.url, p.hash]) ?? []),
    fetchImpl: opts.fetchImpl,
  });
  out.log(`  ${c.pages.length} pages read, ${c.unchanged.length} unchanged, ${c.skipped.length} skipped${c.documents.length ? `, ${c.documents.length} documents found` : ""}`);
  if (!c.pages.length) throw new UserError(`No pages could be read from ${config.site}. Is the site running and reachable?`);

  let llm: Llm | undefined;
  if (opts.llm !== false && config.llm.enabled) {
    if (opts.llm) llm = opts.llm;
    else if (hasClaudeCredentials()) llm = new ClaudeLlm();
    else out.log("  No Anthropic credentials found: using built-in heuristics. Set ANTHROPIC_API_KEY for richer extraction.");
  }

  const extra = opts.connectors
    ? await opts.connectors(config)
    : await import("./actions-hook.ts").then((m) => m.defaultConnectors(config, (msg) => out.log(`  ${msg}`)));
  let graph = await understand(c, {
    siteUrl: config.site,
    name: config.name,
    llm,
    models: { classify: config.llm.classifyModel, extract: config.llm.extractModel, actions: config.llm.actionsModel },
    ownership: local ? { verified: true, method: "skipped-local" } : state.ownership,
    previous,
    extraEntities: extra.entities,
    extraActions: applyActionOverrides(extra.actions, config),
    onProgress: (m) => out.log(`  ${m}`),
  });
  // Owner-written action settings from the config file always win.
  graph.actions = applyActionOverrides(graph.actions, config);

  if (opts.parity !== false) {
    const { proveGraph, paritySummary, SIGNING_KEY_ENV } = await import("./proof.ts");
    const proved = await proveGraph(project, graph, { fetchImpl: opts.fetchImpl });
    graph = proved.graph;
    out.log(`  ${paritySummary(graph.parity!)}. Signed with your key.`);
    if (proved.createdKey) out.log(`  Made a signing key in .agenticweb/signing-key.json. Keep it private; in CI, put its contents in ${SIGNING_KEY_ENV}.`);
  }

  await project.saveGraph(graph);
  // Approved suggestions that now appear on the site are live.
  {
    const { loadSuggestions, saveSuggestions, markLive } = await import("./suggest.ts");
    const list = await loadSuggestions(project);
    if (list.length) {
      const next = markLive(list, graph);
      const live = next.filter((s, i) => s.status === "live" && list[i]!.status !== "live");
      if (live.length) {
        await saveSuggestions(project, next);
        out.log(`  ${live.length} approved suggestion(s) are now on your site and in the agent branch.`);
      }
    }
  }
  const outDir = path.resolve(project.dir, opts.outDir ?? "agent-branch");
  const runtime = opts.runtime ?? config.deploy.target !== "static";
  const files = emitAgentBranch(graph, { runtime, baseUrl: opts.baseUrl ?? config.deploy.baseUrl });
  await writeFiles(outDir, files);
  await project.saveState({ ...state, lastBuild: graph.generatedAt });

  out.log(`\n${summary(graph)}`);
  out.log(`\nWrote ${files.size} files to ${path.relative(process.cwd(), outDir) || "."}`);
  const drafts = graph.actions.filter((a) => !a.enabled);
  if (drafts.length) out.log(`\n${drafts.length} action(s) found but not enabled. Review them with: agenticweb actions`);
  return graph;
}

/** Applies the owner's edits from the config file. Only fields the owner wrote change. */
export function applyActionOverrides(actions: SiteGraph["actions"], config: ProjectConfig): SiteGraph["actions"] {
  const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  const merged = actions.map((a) => {
    const o = config.actions.find((x) => x.name === a.name);
    return o ? ({ ...a, ...defined(o), limits: { ...a.limits, ...defined(o.limits ?? {}) } } as SiteGraph["actions"][number]) : a;
  });
  // Complete owner-written actions that weren't discovered are added as new actions.
  for (const o of config.actions) {
    if (merged.some((a) => a.name === o.name) || !o.description || !o.kind || !o.backend) continue;
    merged.push(
      ActionDef.parse({
        ...defined(o),
        input: o.input ?? [],
        confirmation: o.confirmation ?? (o.kind === "read" ? "none" : "owner"),
        enabled: o.enabled ?? false,
        source: { via: "owner", seen: new Date().toISOString() },
      }),
    );
  }
  return merged;
}

export function summary(g: SiteGraph): string {
  const types = [...entitiesByType(g)].map(([t, l]) => `${l.length} ${t}`).join(", ");
  const enabled = g.actions.filter((a) => a.enabled).length;
  return [
    `${g.site.name} (${g.site.type})`,
    `  Pages:    ${g.pages.filter((p) => !p.hidden).length} public${g.pages.some((p) => p.hidden) ? `, ${g.pages.filter((p) => p.hidden).length} hidden` : ""}`,
    `  Data:     ${types || "none"}`,
    `  Actions:  ${enabled} enabled, ${g.actions.length - enabled} drafts`,
    `  Owner:    ${g.ownership.verified ? `verified (${g.ownership.method})` : "not verified"}`,
  ].join("\n");
}

export async function cmdStatus(project: Project, out: Out = stdout) {
  out.log(summary(await project.requireGraph()));
}

export async function cmdActions(project: Project, sub: string | undefined, name: string | undefined, out: Out = stdout) {
  const g = await project.requireGraph();
  if (!sub || sub === "list") {
    if (!g.actions.length) return out.log("No actions found. Connect a data source or add actions in agenticweb.config.json.");
    for (const a of g.actions) {
      out.log(`${a.enabled ? "[on] " : "[off]"} ${a.name}  (${a.kind}, confirmation: ${a.confirmation}, backend: ${a.backend.type})`);
      out.log(`      ${a.description}`);
      out.log(`      inputs: ${a.input.map((f) => `${f.name}${f.required ? "" : "?"}:${f.type}`).join(", ")}`);
    }
    return;
  }
  if (sub !== "enable" && sub !== "disable") throw new UserError("Usage: agenticweb actions [list|enable <name>|disable <name>]");
  const a = g.actions.find((x) => x.name === name);
  if (!a) throw new UserError(`No action named "${name}". Run: agenticweb actions`);
  if (sub === "enable" && a.backend.type === "form-bridge") {
    out.log("Note: this action submits your site's HTML form. A native connector (Cal.com, Shopify, …) is more reliable.");
  }
  a.enabled = sub === "enable";
  await project.saveGraph(g);
  await persistActionOverride(project, a.name, { enabled: a.enabled });
  out.log(`${a.name} ${a.enabled ? "enabled" : "disabled"}. Rebuild to publish: agenticweb build`);
}

/** Saves an owner's action choice in the config file, so it survives rebuilds and lives in version control. */
export async function persistActionOverride(project: Project, name: string, change: Record<string, unknown>) {
  const config = await project.config();
  const existing = config.actions.find((x) => x.name === name);
  if (existing) Object.assign(existing, change);
  else config.actions.push({ name, ...change });
  await project.saveConfig(config);
}

export async function cmdVisibility(project: Project, hide: boolean, target: string | undefined, out: Out = stdout) {
  if (!target) throw new UserError(`Usage: agenticweb ${hide ? "hide" : "show"} <page-slug | entity-id>`);
  const g = await project.requireGraph();
  const page = g.pages.find((p) => p.slug === target || p.url === target);
  const entity = g.entities.find((e) => e.id === target || e.name === target);
  if (!page && !entity) throw new UserError(`Nothing matches "${target}". Page slugs are listed in agent-branch/pages/.`);
  if (page) page.hidden = hide;
  if (entity) entity.hidden = hide;
  await project.saveGraph(g);
  out.log(`${page ? `Page ${page.slug}` : `Entity ${entity!.name}`} is now ${hide ? "hidden" : "public"}. Rebuild to publish: agenticweb build`);
}

export async function cmdSnippets(project: Project, baseUrl: string | undefined, out: Out = stdout) {
  const g = await project.requireGraph();
  const config = await project.config();
  const base = baseUrl ?? config.deploy.baseUrl;
  if (!base) throw new UserError("Pass the agent branch URL: agenticweb snippets --base-url https://agents.mysite.com");
  const s = discoverySnippets(g, base);
  out.log("Add to the <head> of every page on your site:\n");
  out.log(s.head);
  out.log("\nAdd to your robots.txt:\n");
  out.log(s.robots);
  if (s.jsonLd) out.log("Optional, on your home page (structured data for search engines and agents):\n\n" + s.jsonLd);
}
