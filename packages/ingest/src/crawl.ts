import { createHash } from "node:crypto";
import { parseRobots, USER_AGENT, type Robots } from "./robots.ts";
import { readSitemaps } from "./sitemap.ts";
import { parsePage, type ParsedPage } from "./html.ts";

export type CrawledPage = ParsedPage & {
  status: number;
  hash: string;
  fetchedAt: string;
};

export type CrawlOptions = {
  maxPages?: number;
  include?: string[];
  exclude?: string[];
  respectRobots?: boolean;
  concurrency?: number;
  render?: "fetch" | "browser";
  /** Hashes from a previous crawl; unchanged pages are reported but not re-parsed. */
  previousHashes?: Map<string, string>;
  onPage?: (page: CrawledPage) => void;
  fetchImpl?: typeof fetch;
};

export type CrawlResult = {
  pages: CrawledPage[];
  skipped: Array<{ url: string; reason: string }>;
  /** Non-HTML documents found (PDFs etc.) for later processing. */
  documents: string[];
  unchanged: string[];
};

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|css|js|mjs|zip|gz|mp4|mp3|woff2?|ttf|xml|json)$/i;
const DOC_EXT = /\.(pdf|docx?)$/i;

/** Normalises a URL so the same page isn't crawled twice. */
export function normalizeUrl(input: string): string {
  const u = new URL(input);
  u.hash = "";
  u.pathname = u.pathname.replace(/\/index\.html?$/i, "/");
  for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(p)) u.searchParams.delete(p);
  return u.toString();
}

function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

export async function crawl(startUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const f = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 200;
  const origin = new URL(startUrl).origin;
  const include = (opts.include ?? []).map(globToRe);
  const exclude = (opts.exclude ?? []).map(globToRe);
  const result: CrawlResult = { pages: [], skipped: [], documents: [], unchanged: [] };

  const fetchText = async (url: string): Promise<string | undefined> => {
    try {
      const res = await f(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? await res.text() : undefined;
    } catch {
      return undefined;
    }
  };

  let robots: Robots = { isAllowed: () => true, sitemaps: [] };
  const robotsTxt = await fetchText(`${origin}/robots.txt`);
  if (robotsTxt) robots = parseRobots(robotsTxt);
  const respect = opts.respectRobots ?? true;

  const sitemapUrls = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const fromSitemap = await readSitemaps(sitemapUrls, fetchText, maxPages * 2);

  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (raw: string) => {
    let url: string;
    try {
      url = normalizeUrl(raw);
    } catch {
      return;
    }
    if (seen.has(url)) return;
    const u = new URL(url);
    if (u.origin !== origin) return;
    seen.add(url);
    if (DOC_EXT.test(u.pathname)) {
      result.documents.push(url);
      return;
    }
    if (SKIP_EXT.test(u.pathname)) return;
    if (include.length && !include.some((r) => r.test(u.pathname))) return result.skipped.push({ url, reason: "not included" }), undefined;
    if (exclude.some((r) => r.test(u.pathname))) return result.skipped.push({ url, reason: "excluded" }), undefined;
    if (respect && !robots.isAllowed(u.pathname + u.search)) return result.skipped.push({ url, reason: "robots.txt" }), undefined;
    queue.push(url);
  };

  enqueue(startUrl);
  for (const u of fromSitemap) enqueue(u);

  const renderer = opts.render === "browser" ? await import("./render.ts").then((m) => m.createRenderer()) : undefined;

  const fetchPage = async (url: string): Promise<{ status: number; html: string; type: string } | undefined> => {
    if (renderer) return renderer.render(url);
    try {
      const res = await f(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
      return { status: res.status, html: await res.text(), type: res.headers.get("content-type") ?? "" };
    } catch (err) {
      result.skipped.push({ url, reason: `fetch failed: ${(err as Error).message}` });
      return undefined;
    }
  };

  let inFlight = 0;
  const worker = async () => {
    while (true) {
      if (result.pages.length + inFlight >= maxPages) return;
      const url = queue.shift();
      if (!url) return;
      inFlight++;
      try {
        const r = await fetchPage(url);
        if (!r) continue;
        if (r.status >= 400) {
          result.skipped.push({ url, reason: `HTTP ${r.status}` });
          continue;
        }
        if (r.type && !r.type.includes("html")) {
          result.skipped.push({ url, reason: `not HTML (${r.type})` });
          continue;
        }
        const hash = createHash("sha256").update(r.html).digest("hex").slice(0, 16);
        if (opts.previousHashes?.get(url) === hash) result.unchanged.push(url);
        const parsed = parsePage(r.html, url);
        const page: CrawledPage = { ...parsed, status: r.status, hash, fetchedAt: new Date().toISOString() };
        result.pages.push(page);
        opts.onPage?.(page);
        for (const link of parsed.links) enqueue(link);
      } finally {
        inFlight--;
      }
    }
  };

  // Workers exit when the queue is momentarily empty, so loop until no work is left.
  while (queue.length && result.pages.length < maxPages) {
    await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  }
  await renderer?.close();
  return result;
}
