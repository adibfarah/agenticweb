import type { Entity, ParityItem, ParityReport, Proof, SiteGraph } from "@agenticweb-dev/core";

/**
 * Proof that agents see the same facts as people:
 * - a parity report that checks every fact in the agent branch against the human page it came from, and
 * - a signature by the site owner's key over the facts and that report, so anyone can check both.
 * Web Crypto only, so it runs in Node, Workers and browsers.
 */

export const PROOF_SPEC = "agent-site-proof/0.1";
export const PROOF_PATH = ".well-known/agent-site-proof.json";
export const KEY_PATH = ".well-known/agent-site-key.json";
/** DNS TXT record that ties a signing key to a domain when the agent branch is on another host. */
export const KEY_TXT_PREFIX = "agenticweb-key=";

// ---------------------------------------------------------------------------------------------------------
// Text helpers

export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&euro;/g, "€")
    .replace(/&pound;/g, "£")
    .replace(/\s+/g, " ")
    .trim();
}

/** The JSON-LD blocks of a page, as raw text (for facts that are only in structured data). */
export function jsonLdText(html: string): string {
  return [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9'@.:+\-$€£ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ways a 24-hour time may be written on a page: 21:00, 9pm, 9:00 pm, 9 p.m. */
function timeForms(t: string): string[] {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return [t];
  const h = Number(m[1]);
  const min = m[2]!;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ap = h < 12 ? "am" : "pm";
  const forms = [`${String(h).padStart(2, "0")}:${min}`, `${h}:${min}`, `${h12}:${min} ${ap}`, `${h12}:${min}${ap}`, `${h12}:${min} ${ap[0]}.m.`];
  if (min === "00") forms.push(`${h12} ${ap}`, `${h12}${ap}`, `${h12} ${ap[0]}.m.`);
  if (h === 12 && min === "00") forms.push("noon", "midday");
  if (h === 0 && min === "00") forms.push("midnight");
  return forms;
}

/** True when the text states this fact. */
export function textHasFact(text: string, kind: ParityItem["field"], value: string): boolean {
  const t = norm(text);
  switch (kind) {
    case "price": {
      const n = Number(value);
      if (!Number.isFinite(n)) return t.includes(norm(value));
      const whole = Math.trunc(n);
      const cents = Math.round((n - whole) * 100);
      const body = cents ? `${whole}[.,]${String(cents).padStart(2, "0")}` : `${whole}(?:[.,]00?)?`;
      return new RegExp(`(?<![\\d.,])${body}(?![\\d])`).test(text);
    }
    case "hours":
      return timeForms(value).some((f) => new RegExp(`(?<![\\d:])${escapeRe(f.toLowerCase())}(?![\\d])`).test(text.toLowerCase()));
    case "phone": {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 7 && text.replace(/\D/g, "").includes(digits.slice(-7));
    }
    case "number":
      return new RegExp(`(?<![\\d.,])${escapeRe(value)}(?![\\d])`).test(text);
    default:
      return t.includes(norm(value));
  }
}

// ---------------------------------------------------------------------------------------------------------
// Facts

type Fact = { entity?: string; name: string; field: ParityItem["field"]; value: string; pages: string[]; via: string };

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function entityFacts(e: Entity, pageUrls: string[]): Fact[] {
  const d = e.data;
  const facts: Fact[] = [];
  const add = (field: ParityItem["field"], value: string | undefined) => {
    if (value && value.trim()) facts.push({ entity: e.id, name: e.name, field, value: value.trim(), pages: pageUrls, via: e.source.via });
  };
  if (e.type !== "Question" && e.type !== "FAQPage") add("name", e.name);
  for (const o of arr(d.offers)) add("price", str((o as { price?: unknown }).price));
  if (d.price !== undefined) add("price", str(d.price));
  add("phone", str(d.telephone));
  add("email", str(d.email));
  const addr = d.address as { streetAddress?: unknown } | string | undefined;
  add("address", typeof addr === "string" ? addr : str(addr?.streetAddress));
  for (const spec of arr(d.openingHoursSpecification)) {
    const s = spec as { opens?: unknown; closes?: unknown };
    add("hours", str(s.opens)?.slice(0, 5));
    add("hours", str(s.closes)?.slice(0, 5));
  }
  for (const h of arr(d.openingHours)) for (const m of String(h).matchAll(/\b\d{1,2}:\d{2}\b/g)) add("hours", m[0]);
  // FAQ answers: the numbers and times in them ("cancel at least 4 hours before").
  for (const q of e.type === "Question" ? [d] : arr(d.mainEntity)) {
    const a = str(((q as { acceptedAnswer?: { text?: unknown } }).acceptedAnswer ?? {}).text);
    if (!a) continue;
    for (const m of a.matchAll(/\b\d{1,2}:\d{2}\b/g)) add("hours", m[0]);
    for (const m of a.replace(/\b\d{1,2}:\d{2}\b/g, " ").matchAll(/(?<![\d.,])\d+(?:[.,]\d+)?(?![\d])/g)) add("number", m[0]);
  }
  // Same fact twice on one entity: check it once.
  return facts.filter((f, i) => facts.findIndex((g) => g.field === f.field && g.value === f.value) === i);
}

/** The pages each fact should appear on. */
export function factsOf(g: SiteGraph): Fact[] {
  const site = new URL(g.site.url);
  const onSite = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "") === site.hostname.replace(/^www\./, "");
    } catch {
      return false;
    }
  };
  const pages = g.pages.filter((p) => !p.hidden);
  const facts: Fact[] = [];
  for (const e of g.entities.filter((x) => !x.hidden)) {
    const urls = new Set<string>();
    if (e.source.url && onSite(e.source.url)) urls.add(e.source.url.split("#")[0]!);
    const own = str(e.data.url);
    if (own && onSite(own)) urls.add(own.split("#")[0]!);
    for (const p of pages) if (p.entityIds.includes(e.id)) urls.add(p.url);
    facts.push(...entityFacts(e, [...urls]));
  }
  // Contact details: on the home page, a contact page, or any page's footer.
  const contactPages = pages.filter((p) => p.pageType === "home" || p.pageType === "contact" || p.pageType === "location").map((p) => p.url);
  const c = g.site.contact;
  const sitePages = contactPages.length ? contactPages : [g.site.url];
  if (c.phone) facts.push({ name: g.site.name, field: "phone", value: c.phone, pages: sitePages, via: "site" });
  if (c.email) facts.push({ name: g.site.name, field: "email", value: c.email, pages: sitePages, via: "site" });
  if (c.address) facts.push({ name: g.site.name, field: "address", value: c.address.split(",")[0]!, pages: sitePages, via: "site" });
  return facts;
}

/** Every page the parity check needs to read. */
export function parityPages(g: SiteGraph): string[] {
  return [...new Set(factsOf(g).flatMap((f) => f.pages))];
}

/**
 * Checks each fact against the human pages it came from.
 * @param pages URL → the page's HTML as people get it (undefined when it couldn't be fetched).
 */
export function checkParity(g: SiteGraph, pages: Map<string, string | undefined>, now = new Date()): ParityReport {
  const items: ParityItem[] = [];
  const cache = new Map<string, { text: string; ld: string } | undefined>();
  const read = (u: string) => {
    if (!cache.has(u)) {
      const html = pages.get(u);
      cache.set(u, html === undefined ? undefined : { text: visibleText(html), ld: jsonLdText(html) });
    }
    return cache.get(u);
  };
  for (const f of factsOf(g)) {
    const base = { ...(f.entity ? { entity: f.entity } : {}), name: f.name, field: f.field, value: f.value };
    if (!f.pages.length) {
      items.push({ ...base, status: "no-page", note: f.via === "connector" ? "from your store or booking system; no page shows it" : "no page to compare with" });
      continue;
    }
    const readable = f.pages.map((u) => [u, read(u)] as const).filter(([, p]) => p);
    if (!readable.length) {
      items.push({ ...base, page: f.pages[0], status: "unreachable" });
      continue;
    }
    const seen = readable.find(([, p]) => textHasFact(p!.text, f.field, f.value));
    if (seen) items.push({ ...base, page: seen[0], status: "match" });
    else {
      const ld = readable.find(([, p]) => textHasFact(p!.ld, f.field, f.value));
      items.push({ ...base, page: (ld ?? readable[0]!)[0], status: ld ? "structured-data" : "missing" });
    }
  }
  const count = (s: ParityItem["status"]) => items.filter((i) => i.status === s).length;
  const matched = count("match");
  const structured = count("structured-data");
  const missing = count("missing");
  const compared = matched + structured + missing;
  return {
    checkedAt: now.toISOString(),
    summary: { facts: items.length, matched, structuredOnly: structured, missing, notCompared: count("no-page") + count("unreachable"), score: compared ? Math.round(((matched + structured) / compared) * 100) : 100 },
    items,
  };
}

export function parityMarkdown(g: SiteGraph, r: ParityReport): string {
  const s = r.summary;
  const label: Record<ParityItem["status"], string> = { match: "same", "structured-data": "in the page's structured data only", missing: "not on the page", "no-page": "not compared", unreachable: "page not reachable" };
  const problems = r.items.filter((i) => i.status === "missing" || i.status === "structured-data");
  return [
    `# Parity report: ${g.site.name}`,
    "",
    `Every fact in this agent branch, checked against the page people see on ${g.site.url}. Checked ${r.checkedAt.slice(0, 16).replace("T", " ")} UTC.`,
    "",
    `- **${s.matched}** of ${s.facts} facts appear on the human page as written.`,
    `- **${s.structuredOnly}** are in the page's structured data (JSON-LD) but not its visible text.`,
    `- **${s.missing}** weren't found on the page.`,
    `- **${s.notCompared}** couldn't be compared (no page shows them, or the page didn't load).`,
    "",
    `Parity: **${s.score}%** of the facts that could be compared.`,
    "",
    ...(problems.length
      ? ["## Differences", "", "| Item | Fact | Value | Page | Result |", "|---|---|---|---|---|", ...problems.map((i) => `| ${esc(i.name)} | ${i.field} | ${esc(i.value)} | ${i.page ?? ""} | ${label[i.status]} |`), ""]
      : ["No differences found.", ""]),
    "## All facts",
    "",
    "| Item | Fact | Value | Result |",
    "|---|---|---|---|",
    ...r.items.map((i) => `| ${esc(i.name)} | ${i.field} | ${esc(i.value)} | ${label[i.status]}${i.note ? ` (${i.note})` : ""} |`),
    "",
    "Check it yourself: `npx agenticweb-cli check <agent-branch-url>` re-reads the human pages and verifies the owner's signature.",
    "",
  ].join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

// ---------------------------------------------------------------------------------------------------------
// Signing

/** JSON with sorted keys, so the same data always gives the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** What the signature covers: what agents are told, not when or how it was built. */
export async function factsDigest(g: SiteGraph): Promise<string> {
  const pages = g.pages
    .filter((p) => !p.hidden)
    .map((p) => ({ slug: p.slug, url: p.url, title: p.title, markdown: p.markdown }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const entities = g.entities
    .filter((e) => !e.hidden)
    .map((e) => ({ id: e.id, type: e.type, name: e.name, data: e.data }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalJson({ site: { name: g.site.name, url: g.site.url, description: g.site.description, contact: g.site.contact }, pages, entities }));
}

export type Jwk = { kty: string; crv?: string; x?: string; d?: string; kid?: string };

export async function keyId(publicJwk: Jwk): Promise<string> {
  return sha256(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }));
}

export async function generateSigningKey(): Promise<Jwk> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d };
}

const payloadOf = (p: Omit<Proof, "signature">) => canonicalJson({ spec: PROOF_SPEC, site: p.site, kid: p.kid, signedAt: p.signedAt, factsSha256: p.factsSha256, paritySha256: p.paritySha256 });

/** Signs the facts and the parity report with the owner's private key. */
export async function signGraph(g: SiteGraph, privateJwk: Jwk, now = new Date()): Promise<Proof> {
  if (!privateJwk.d) throw new Error("The signing key has no private part.");
  const publicKey = { kty: "OKP", crv: "Ed25519", x: privateJwk.x! };
  const kid = await keyId(publicKey);
  const unsigned = {
    alg: "Ed25519" as const,
    kid,
    publicKey,
    site: g.site.url,
    signedAt: now.toISOString(),
    factsSha256: await factsDigest(g),
    ...(g.parity ? { paritySha256: await sha256(canonicalJson(g.parity)) } : {}),
  };
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateJwk.x, d: privateJwk.d }, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(payloadOf(unsigned)));
  return { ...unsigned, signature: b64url(sig) };
}

export type ProofCheck = { ok: boolean; problems: string[] };

/** Checks a proof against a graph: the signature, the facts and the parity report. */
export async function verifyProof(g: SiteGraph, proof: Proof): Promise<ProofCheck> {
  const problems: string[] = [];
  if ((await keyId(proof.publicKey)) !== proof.kid) problems.push("The key id doesn't match the public key.");
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: proof.publicKey.x }, { name: "Ed25519" }, false, ["verify"]);
    const { signature, ...unsigned } = proof;
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64url(signature) as Uint8Array<ArrayBuffer>, new TextEncoder().encode(payloadOf(unsigned)));
    if (!ok) problems.push("The signature doesn't match.");
  } catch (err) {
    problems.push(`The signature couldn't be checked: ${(err as Error).message}`);
  }
  if ((await factsDigest(g)) !== proof.factsSha256) problems.push("The facts were changed after they were signed.");
  if (proof.paritySha256 && (!g.parity || (await sha256(canonicalJson(g.parity))) !== proof.paritySha256)) problems.push("The parity report was changed after it was signed.");
  return { ok: problems.length === 0, problems };
}
