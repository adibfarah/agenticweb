/** Reads sitemap.xml files, following sitemap indexes. */
export async function readSitemaps(
  urls: string[],
  fetchText: (url: string) => Promise<string | undefined>,
  limit = 5000,
): Promise<string[]> {
  const seen = new Set<string>();
  const pages: string[] = [];
  const queue = [...urls];
  while (queue.length && pages.length < limit) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await fetchText(sm);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXml(m[1]!));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs);
    else pages.push(...locs);
  }
  return pages.slice(0, limit);
}

const decodeXml = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
