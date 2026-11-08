import { entityFileName, type Entity, type SiteGraph } from "@agenticweb-dev/core";

export type SearchDoc = {
  id: string;
  kind: "page" | "entity";
  title: string;
  text: string;
  /** Source URL on the human site. */
  url: string;
  /** Where the agent branch serves it. */
  href: string;
  type?: string;
};

export type SearchHit = SearchDoc & { score: number; snippet: string };

const STOP = new Set(
  "a an and are as at be by do does for from has have how i in is it its me my of on or our that the their them there they this to was we what when where which who why will with you your can".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9$€£]+/)
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOP.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("es") && !t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 5 && t.endsWith("ed")) return t.slice(0, -2);
  return t;
}

/** Words people use in questions that the site says differently. Applied to queries only. */
const SYNONYMS: Record<string, string[]> = {
  close: ["hour", "open"],
  open: ["hour"],
  phone: ["telephone", "call"],
  call: ["phone"],
  cost: ["price"],
  much: ["price"],
  price: ["cost"],
  email: ["mail"],
  address: ["location", "visit"],
  refund: ["return"],
  return: ["refund"],
  deliver: ["shipping"],
  delivery: ["shipping"],
  ship: ["shipping"],
};

export function expandQuery(tokens: string[]): string[] {
  return [...new Set(tokens.flatMap((t) => [t, ...(SYNONYMS[t] ?? []).map(stem)]))];
}

/** Plain-text description of an entity, so it can be searched and quoted. */
export function entityText(e: Entity): string {
  const d = e.data as Record<string, unknown>;
  const parts: string[] = [`${e.name} (${e.type})`];
  if (typeof d.description === "string") parts.push(d.description);
  if (typeof d.category === "string") parts.push(`Category: ${d.category}`);
  const offers = Array.isArray(d.offers) ? d.offers : d.offers ? [d.offers] : [];
  for (const o of offers as Array<Record<string, unknown>>) {
    const avail = typeof o.availability === "string" ? ` (${String(o.availability).split("/").pop()})` : "";
    parts.push(`${o.name ? `${o.name}: ` : ""}Price ${o.price} ${o.priceCurrency ?? ""}${avail}`.trim());
  }
  if (Array.isArray(d.suitableForDiet)) parts.push(`Diet: ${(d.suitableForDiet as string[]).map((x) => x.split("/").pop()!.replace(/Diet$/, "")).join(", ")}`);
  for (const p of (d.additionalProperty as Array<{ name: string; value: string }> | undefined) ?? []) parts.push(`${p.name}: ${p.value}`);
  if (Array.isArray(d.openingHoursSpecification)) {
    parts.push(
      "Opening hours: " +
        (d.openingHoursSpecification as Array<{ dayOfWeek: string; opens: string; closes: string }>).map((h) => `${h.dayOfWeek.split("/").pop()} ${h.opens}-${h.closes}`).join(", "),
    );
  }
  const labels: Record<string, string> = { telephone: "Phone", email: "Email", address: "Address", startDate: "Starts", location: "Location", duration: "Duration" };
  for (const [k, label] of Object.entries(labels)) if (typeof d[k] === "string") parts.push(`${label}: ${d[k]}`);
  if (Array.isArray(d.mainEntity)) {
    for (const q of d.mainEntity as Array<{ name: string; acceptedAnswer?: { text: string } }>) parts.push(`Q: ${q.name} A: ${q.acceptedAnswer?.text ?? ""}`);
  }
  return parts.join(". ");
}

/** Splits page Markdown into sections by heading so results point at the relevant part. */
function pageSections(markdown: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ heading, text });
    buf = [];
  };
  for (const line of markdown.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      flush();
      heading = h[1]!.trim();
    }
    buf.push(line);
  }
  flush();
  return out;
}

export function documentsFor(g: SiteGraph): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const p of g.pages) {
    for (const [i, s] of pageSections(p.markdown).entries()) {
      docs.push({ id: `${p.slug}#${i}`, kind: "page", title: s.heading ? `${p.title}: ${s.heading}` : p.title, text: s.text, url: p.url, href: `/pages/${p.slug}.md`, type: p.pageType });
    }
  }
  for (const e of g.entities) {
    const href = `/data/${entityFileName(e.type)}.json`;
    const url = e.source.url ?? g.site.url;
    const questions = e.data.mainEntity as Array<{ name: string; acceptedAnswer?: { text: string } }> | undefined;
    if (e.type === "FAQPage" && Array.isArray(questions)) {
      // One search entry per question, so the answer comes back with its question.
      questions.forEach((q, i) => docs.push({ id: `${e.id}#q${i}`, kind: "entity", title: q.name, text: q.acceptedAnswer?.text ?? "", url, href, type: "Question" }));
      continue;
    }
    docs.push({ id: e.id, kind: "entity", title: e.name, text: entityText(e), url, href, type: e.type });
  }
  return docs;
}

/** Small BM25 index. Pure TypeScript so it runs anywhere (Node, Workers, Deno, Bun). */
export class SearchIndex {
  private docs: SearchDoc[];
  private tf: Array<Map<string, number>>;
  private len: number[];
  private df = new Map<string, number>();
  private avgLen: number;

  constructor(docs: SearchDoc[]) {
    this.docs = docs;
    this.tf = docs.map((d) => {
      const m = new Map<string, number>();
      // Titles count double.
      for (const t of [...tokenize(d.title), ...tokenize(d.title), ...tokenize(d.text)]) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    });
    this.len = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  }

  static fromGraph(g: SiteGraph): SearchIndex {
    return new SearchIndex(documentsFor(g));
  }

  search(query: string, opts: { limit?: number; type?: string; kind?: "page" | "entity" } = {}): SearchHit[] {
    const q = expandQuery(tokenize(query));
    if (!q.length) return [];
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const hits: SearchHit[] = [];
    this.docs.forEach((d, i) => {
      if (opts.type && d.type !== opts.type) return;
      if (opts.kind && d.kind !== opts.kind) return;
      let score = 0;
      for (const t of q) {
        const f = this.tf[i]!.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * this.len[i]!) / this.avgLen)));
      }
      if (score > 0) hits.push({ ...d, score, snippet: snippet(d.text, q) });
    });
    return hits.sort((a, b2) => b2.score - a.score).slice(0, opts.limit ?? 10);
  }
}

/** The sentence(s) of a text that best match the query terms. */
/** Rewrites Markdown table rows as "Header: value, …" so a matching row carries its meaning. */
function tablesToSentences(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const sep = lines[i + 1]?.trim() ?? "";
    if (line.startsWith("|") && /^\|[\s:|-]+\|$/.test(sep)) {
      const headers = line.split("|").slice(1, -1).map((h) => h.trim());
      i += 2;
      for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
        const cells = lines[i]!.trim().split("|").slice(1, -1).map((c) => c.trim());
        out.push(cells.map((c, j) => `${headers[j] ?? ""}: ${c}`).join(", ") + ".");
      }
      i--;
      continue;
    }
    out.push(lines[i]!);
  }
  return out.join("\n");
}

export function snippet(text: string, queryTokens: string[], max = 280): string {
  const all = tablesToSentences(text)
    .replace(/\n+/g, " \n ")
    .split(/(?<=[.!?])\s+|\s\n\s/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/^[#>*\-\s]+/, "").length > 2);
  // Headings rarely answer anything on their own; use them only if nothing else matches.
  const body = all.filter((s) => !s.startsWith("#"));
  const sentences = (body.length ? body : all).map((s) => s.replace(/^[#>*\-\s]+/, ""));
  const scored = sentences.map((s, i) => {
    const toks = new Set(tokenize(s));
    return { i, score: queryTokens.filter((t) => toks.has(t)).length };
  });
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i);
  if (!ranked.length) return "";
  // Keep the two best sentences (in reading order) so a near-tie doesn't hide the answer.
  const picks = ranked.slice(0, 2).filter((r, n) => n === 0 || (r.score > 0 && r.score >= ranked[0]!.score - 1));
  const parts: string[] = [];
  for (const { i } of picks.sort((a, b) => a.i - b.i)) {
    const s = sentences[i]!;
    // A matching question is only useful with its answer.
    parts.push(s.endsWith("?") && sentences[i + 1] ? `${s} ${sentences[i + 1]}` : s);
  }
  const best = [...new Set(parts)].join(" ");
  return best.length > max ? best.slice(0, max - 1) + "…" : best;
}
