import type { SiteGraph } from "./schema.ts";

/** Turns a URL path or title into a file-safe slug. "/" becomes "index". */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.(html?|php|aspx?)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "index";
}

/** Slug for a page URL, based on its path (and query when present). */
export function slugForUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/index\.html?$/, "/");
  return slugify(path + (u.search ? `-${u.search}` : ""));
}

export const nowIso = (): string => new Date().toISOString();

/** Returns only what the owner allowed to be public. */
export function publicView(graph: SiteGraph): SiteGraph {
  return {
    ...graph,
    pages: graph.pages.filter((p) => !p.hidden),
    entities: graph.entities.filter((e) => !e.hidden),
    actions: graph.actions.filter((a) => a.enabled),
  };
}

/** Groups entities by schema.org type, e.g. { Product: [...], FAQPage: [...] }. */
export function entitiesByType(graph: SiteGraph): Map<string, SiteGraph["entities"]> {
  const map = new Map<string, SiteGraph["entities"]>();
  for (const e of graph.entities) {
    const list = map.get(e.type) ?? [];
    list.push(e);
    map.set(e.type, list);
  }
  return map;
}

/** File name for an entity type: Product → products, FAQPage → faq-pages, MenuItem → menu-items. */
export function entityFileName(type: string): string {
  const kebab = type
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  if (/(ss|business)$/.test(kebab)) return kebab;
  if (kebab.endsWith("y") && !/[aeiou]y$/.test(kebab)) return kebab.slice(0, -1) + "ies";
  if (kebab.endsWith("s")) return kebab;
  return kebab + "s";
}
