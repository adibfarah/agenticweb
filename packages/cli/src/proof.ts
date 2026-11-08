import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveTxt } from "node:dns/promises";
import path from "node:path";
import { Proof, SiteGraph, type ParityReport } from "@agenticweb-dev/core";
import { KEY_PATH, KEY_TXT_PREFIX, PROOF_PATH, checkParity, generateSigningKey, keyId, parityPages, signGraph, verifyProof, type Jwk } from "@agenticweb-dev/emitters";
import { Project, UserError } from "./project.ts";

/**
 * Parity proof for the CLI: check every fact against the live human pages, sign the result with the owner's
 * key, and let anyone verify a published agent branch.
 */

export const SIGNING_KEY_ENV = "AGENTICWEB_SIGNING_KEY";
const KEY_FILE = "signing-key.json";

/** The owner's signing key: from AGENTICWEB_SIGNING_KEY (for CI), or .agenticweb/signing-key.json (made on first use). */
export async function loadSigningKey(project: Project, env: NodeJS.ProcessEnv = process.env): Promise<{ key: Jwk; created: boolean }> {
  if (env[SIGNING_KEY_ENV]) {
    try {
      return { key: JSON.parse(env[SIGNING_KEY_ENV]!) as Jwk, created: false };
    } catch {
      throw new UserError(`${SIGNING_KEY_ENV} isn't valid JSON. Copy the whole contents of .agenticweb/${KEY_FILE} into it.`);
    }
  }
  const file = path.join(project.dataDir, KEY_FILE);
  if (existsSync(file)) return { key: JSON.parse(await readFile(file, "utf8")) as Jwk, created: false };
  const key = await generateSigningKey();
  await mkdir(project.dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(key, null, 2) + "\n", { mode: 0o600 });
  // Keep the private key out of git even if the rest of .agenticweb is committed.
  const ignore = path.join(project.dataDir, ".gitignore");
  const lines = existsSync(ignore) ? (await readFile(ignore, "utf8")).split("\n") : [];
  if (!lines.includes(KEY_FILE)) await writeFile(ignore, [...lines.filter(Boolean), KEY_FILE].join("\n") + "\n");
  return { key, created: true };
}

/** Reads the human pages the facts came from, as people get them. */
export async function fetchHumanPages(g: SiteGraph, fetchImpl: typeof fetch = fetch, concurrency = 4): Promise<Map<string, string | undefined>> {
  const urls = parityPages(g);
  const out = new Map<string, string | undefined>();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const u = urls[next++]!;
      try {
        const res = await fetchImpl(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; agenticweb-parity)", accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
        out.set(u, res.ok ? await res.text() : undefined);
      } catch {
        out.set(u, undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

/** Runs the parity check and signs the facts. Returns the graph with `parity` and `proof` set. */
export async function proveGraph(project: Project, g: SiteGraph, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<{ graph: SiteGraph; createdKey: boolean }> {
  const parity = checkParity(g, await fetchHumanPages(g, opts.fetchImpl));
  const withParity = { ...g, parity };
  const { key, created } = await loadSigningKey(project, opts.env);
  return { graph: { ...withParity, proof: await signGraph(withParity, key) }, createdKey: created };
}

export const paritySummary = (p: ParityReport) =>
  `Parity: ${p.summary.score}% (${p.summary.matched} of ${p.summary.facts} facts on the human pages as written${p.summary.structuredOnly ? `, ${p.summary.structuredOnly} only in structured data` : ""}${p.summary.missing ? `, ${p.summary.missing} not found` : ""})`;

/** `agenticweb parity`: re-checks the facts against the live site and re-signs. */
export async function cmdParity(project: Project, opts: { strict?: boolean; fetchImpl?: typeof fetch } = {}, out = { log: (m: string) => console.log(m) }) {
  const g = await project.requireGraph();
  const { graph } = await proveGraph(project, g, { fetchImpl: opts.fetchImpl });
  await project.saveGraph(graph);
  const p = graph.parity!;
  out.log(paritySummary(p));
  for (const i of p.items.filter((x) => x.status === "missing" || x.status === "structured-data").slice(0, 20)) {
    out.log(`  ${i.status === "missing" ? "✗" : "~"} ${i.name}: ${i.field} "${i.value}" ${i.status === "missing" ? "isn't on" : "is only in the structured data of"} ${i.page}`);
  }
  out.log("Saved and signed. Run `agenticweb build` (or deploy) to publish the updated report.");
  if (opts.strict && p.summary.missing) throw new UserError(`${p.summary.missing} fact(s) weren't found on the human pages.`);
  return graph;
}

export type CheckResult = {
  site: string;
  signature: { ok: boolean; problems: string[]; signedAt?: string };
  /** How the signing key is tied to the site's own domain. */
  key: { anchored: boolean; how?: string };
  /** A fresh parity check against the live human pages. */
  parity?: ParityReport;
  ok: boolean;
};

/** `agenticweb check <agent-branch-url>`: anyone can verify a published agent branch. */
export async function cmdCheck(
  url: string,
  opts: { strict?: boolean; fetchImpl?: typeof fetch; resolveTxt?: (h: string) => Promise<string[][]> } = {},
  out = { log: (m: string) => console.log(m) },
): Promise<CheckResult> {
  if (!url) throw new UserError("Usage: agenticweb check <agent-branch-url>");
  const f = opts.fetchImpl ?? fetch;
  const base = url.replace(/\/+$/, "").replace(/\/\.well-known\/agent-site\.json$/, "");
  const getJson = async (p: string) => {
    const res = await f(`${base}/${p}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    return res.json().catch(() => undefined) as Promise<unknown>;
  };
  const rawGraph = await getJson("site-graph.json");
  const parsed = SiteGraph.safeParse(rawGraph);
  if (!parsed.success) throw new UserError(`Couldn't read ${base}/site-graph.json. Is this an AgenticWeb agent branch?`);
  const g = parsed.data;
  const result: CheckResult = { site: g.site.url, signature: { ok: false, problems: [] }, key: { anchored: false }, ok: false };

  const proof = Proof.safeParse(await getJson(PROOF_PATH));
  if (!proof.success) result.signature.problems.push("No owner signature published.");
  else {
    const v = await verifyProof(g, proof.data);
    result.signature = { ...v, signedAt: proof.data.signedAt };
    // Is the key the site's own? Either the human site serves it, or its DNS names it.
    const site = new URL(g.site.url);
    try {
      const res = await f(`${site.origin}/${KEY_PATH}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const keys = res.ok ? ((await res.json()) as { keys?: Array<{ x?: string; crv?: string; kty?: string }> }).keys : undefined;
      for (const k of keys ?? []) if ((await keyId({ kty: k.kty ?? "", crv: k.crv, x: k.x })) === proof.data.kid) result.key = { anchored: true, how: `published on ${site.hostname}` };
    } catch {
      // try DNS
    }
    if (!result.key.anchored) {
      const resolver = opts.resolveTxt ?? resolveTxt;
      for (const host of [site.hostname, site.hostname.replace(/^www\./, "")]) {
        try {
          const records = (await resolver(host)).map((r) => r.join(""));
          if (records.includes(KEY_TXT_PREFIX + proof.data.kid)) {
            result.key = { anchored: true, how: `DNS TXT record on ${host}` };
            break;
          }
        } catch {
          // no records
        }
      }
    }
  }
  result.parity = checkParity(g, await fetchHumanPages(g, f));
  result.ok = result.signature.ok && result.key.anchored && (!opts.strict || result.parity.summary.missing === 0);

  out.log(`Agent branch for ${g.site.name} (${g.site.url})`);
  if (result.signature.ok) out.log(`  ✓ Signed by the owner's key on ${result.signature.signedAt?.slice(0, 10)}; the facts haven't changed since.`);
  else for (const p of result.signature.problems) out.log(`  ✗ ${p}`);
  if (proof.success) out.log(result.key.anchored ? `  ✓ The key belongs to the site (${result.key.how}).` : `  ✗ The key isn't tied to ${new URL(g.site.url).hostname}: it isn't at /${KEY_PATH} there and no DNS TXT record "${KEY_TXT_PREFIX}${proof.data.kid}".`);
  out.log(`  ${result.parity.summary.missing ? "✗" : "✓"} ${paritySummary(result.parity)}, checked just now.`);
  for (const i of result.parity.items.filter((x) => x.status === "missing").slice(0, 20)) out.log(`      ${i.name}: ${i.field} "${i.value}" isn't on ${i.page}`);
  if (!result.ok && opts.strict) throw new UserError("Check failed.");
  return result;
}
