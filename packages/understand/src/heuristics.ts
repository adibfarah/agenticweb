import { slugify, type ActionDef, type ActionField, type Entity, type PageType, type SiteInfo } from "@agenticweb-dev/core";
import type { CrawledPage, FormInfo } from "@agenticweb-dev/ingest";

const PAGE_RULES: Array<[PageType, RegExp]> = [
  ["faq", /\b(faq|frequently|questions|help)\b/i],
  ["menu", /\b(menu|food|drinks|wine)\b/i],
  ["booking", /\b(book|booking|reserv|appointment|schedule)\b/i],
  ["contact", /\b(contact|get in touch|find us|location)\b/i],
  ["about", /\b(about|our story|team|who we are)\b/i],
  ["policy", /\b(privacy|terms|policy|returns|refund|shipping|cookie|legal)\b/i],
  ["product-list", /\b(collections?|shop all|catalog|category|products)\b/i],
  ["docs", /\b(docs?|documentation|api|reference|guide|authentication)\b/i],
  ["event", /\b(events?|tickets|calendar)\b/i],
  ["service", /\b(services?|pricing|plans)\b/i],
  ["article", /\b(blog|news|article|post)\b/i],
];

/** Guesses the kind of page from its URL, title and structure. */
export function classifyPage(page: CrawledPage): PageType {
  const path = new URL(page.url).pathname;
  if (path === "/" || path === "") return "home";
  if (page.jsonLd.some((j) => j["@type"] === "Product")) return "product";
  if (/\/products?\//i.test(path)) return "product";
  const hay = `${path} ${page.title}`;
  for (const [type, re] of PAGE_RULES) if (re.test(hay)) return type;
  return "other";
}

const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Basic site facts from the home page, JSON-LD and footer. */
export function siteInfoFromPages(pages: CrawledPage[], siteUrl: string, name?: string): SiteInfo {
  const home = pages.find((p) => new URL(p.url).pathname === "/") ?? pages[0];
  const org = pages.flatMap((p) => p.jsonLd).find((j) => /Organization|LocalBusiness|Restaurant|Store/.test(String(j["@type"])));
  const footer = home?.footerMarkdown ?? "";
  // Code samples (API docs) are full of example numbers and addresses that aren't the business's.
  const noCode = (md: string) => md.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const allText = `${footer}\n${pages.map((p) => noCode(p.markdown)).join("\n")}`;
  const mailto = allText.match(EMAIL)?.[0];
  const phone = footer.match(PHONE)?.[1]?.trim() ?? allText.match(PHONE)?.[1]?.trim();
  return {
    name: name ?? (org?.name as string | undefined) ?? home?.siteName ?? home?.title ?? new URL(siteUrl).hostname,
    url: siteUrl,
    description: home?.description || (org?.description as string | undefined) || "",
    type: (org?.["@type"] as string | undefined) ?? guessBusinessType(pages),
    languages: [home?.lang ?? "en"],
    contact: { email: mailto, phone },
  };
}

function guessBusinessType(pages: CrawledPage[]): string {
  const types = pages.map(classifyPage);
  if (types.includes("menu")) return "Restaurant";
  if (types.includes("product")) return "Store";
  if (types.includes("docs")) return "SoftwareApplication";
  return "Organization";
}

/** Opening hours written like "Tuesday: 17:00–22:00" or "Monday: Closed". */
export function parseOpeningHours(text: string): Array<{ dayOfWeek: string; opens: string; closes: string }> {
  const out: Array<{ dayOfWeek: string; opens: string; closes: string }> = [];
  const re = new RegExp(`(${DAYS.join("|")})s?\\s*[:\\-]\\s*(\\d{1,2}[:.]\\d{2})\\s*[–—-]\\s*(\\d{1,2}[:.]\\d{2})`, "gi");
  for (const m of text.matchAll(re)) {
    const day = DAYS.find((d) => d.toLowerCase() === m[1]!.toLowerCase())!;
    if (!out.some((o) => o.dayOfWeek === day)) out.push({ dayOfWeek: day, opens: m[2]!.replace(".", ":").padStart(5, "0"), closes: m[3]!.replace(".", ":").padStart(5, "0") });
  }
  return out;
}

/** The business itself as a schema.org entity, with opening hours when found. */
export function businessEntity(info: SiteInfo, pages: CrawledPage[], seen: string): Entity {
  const footer = pages.find((p) => new URL(p.url).pathname === "/")?.footerMarkdown ?? "";
  const hours = parseOpeningHours(footer + "\n" + pages.map((p) => p.markdown).join("\n"));
  const address = footer.match(/\d+[^\n]*\b(St|Ave|Blvd|Rd|Road|Street|Avenue|Lane|Way)\b[^\n]*/i)?.[0]?.trim();
  const data: Record<string, unknown> = {
    "@type": info.type,
    "@id": `${info.url.replace(/\/$/, "")}/#business`,
    name: info.name,
    url: info.url,
    ...(info.description ? { description: info.description } : {}),
    ...(info.contact.phone ? { telephone: info.contact.phone } : {}),
    ...(info.contact.email ? { email: info.contact.email } : {}),
    ...(address ? { address } : {}),
    ...(hours.length
      ? { openingHoursSpecification: hours.map((h) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${h.dayOfWeek}`, opens: h.opens, closes: h.closes })) }
      : {}),
  };
  return { id: data["@id"] as string, type: info.type, name: info.name, data, hidden: false, source: { url: info.url, via: "heuristic", seen } };
}

/** FAQ pairs from "### Question" headings followed by answer text. */
export function faqFromMarkdown(page: CrawledPage, seen: string): Entity | undefined {
  const pairs: Array<{ q: string; a: string }> = [];
  const re = /^###\s+(.+\?)\s*\n+([\s\S]*?)(?=\n###\s|\n##\s|$)/gm;
  for (const m of page.markdown.matchAll(re)) {
    const a = m[2]!.trim();
    if (a) pairs.push({ q: m[1]!.trim(), a });
  }
  if (pairs.length < 2) return undefined;
  const id = `${page.url}#faq`;
  return {
    id,
    type: "FAQPage",
    name: page.title || "FAQ",
    data: {
      "@type": "FAQPage",
      "@id": id,
      mainEntity: pairs.map((p) => ({ "@type": "Question", name: p.q, acceptedAnswer: { "@type": "Answer", text: p.a } })),
    },
    hidden: false,
    source: { url: page.url, via: "heuristic", seen },
  };
}

const PRICE_LINE = /^(?:[-*]\s+)?\**([^$€£\n]{2,80}?)\**\s*[-–—:.]*\s*([$€£])\s?(\d{1,5}(?:[.,]\d{2})?)\s*$/;
const DIETS = ["vegan", "vegetarian", "gluten-free", "halal", "kosher"];

/**
 * Items with prices written as "Name $9" lines (menus, price lists, service tables),
 * with the following line as description and diet/allergen notes when present.
 */
export function priceListFromMarkdown(page: CrawledPage, pageType: PageType, seen: string): Entity[] {
  const type = pageType === "menu" ? "MenuItem" : pageType === "service" ? "Service" : "Offer";
  const lines = page.markdown.split("\n").map((l) => l.trim());
  const items: Array<{ name: string; price: string; currency: string; section?: string; description?: string; diet: string[]; allergens: string[] }> = [];
  let section: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    const h = line.match(/^#{2,4}\s+(.+)$/);
    if (h) {
      section = h[1]!.trim();
      continue;
    }
    const m = line.match(PRICE_LINE);
    if (m && !/^(total|subtotal|from|only)$/i.test(m[1]!.trim())) {
      const currency = m[2] === "€" ? "EUR" : m[2] === "£" ? "GBP" : "USD";
      items.push({ name: m[1]!.trim(), price: m[3]!.replace(",", "."), currency, section, diet: [], allergens: [] });
      continue;
    }
    const cur = items[items.length - 1];
    if (!cur) continue;
    const contains = line.match(/contains:\s*(.+)$/i);
    const diets = DIETS.filter((d) => new RegExp(`\\b${d}\\b`, "i").test(line.replace(/contains:.*$/i, "")));
    if (contains || diets.length) {
      if (contains) cur.allergens.push(...contains[1]!.split(/,\s*/).map((a) => a.replace(/[.*_]/g, "").trim()).filter(Boolean));
      cur.diet.push(...diets);
    } else if (!cur.description && !line.startsWith("#") && line.length < 300) {
      cur.description = line;
    }
  }
  if (items.length < 3) return [];
  return items.map((it) => {
    const id = `${page.url}#${slugify(it.name)}`;
    const data: Record<string, unknown> = {
      "@type": type,
      "@id": id,
      name: it.name,
      ...(it.description ? { description: it.description } : {}),
      offers: { "@type": "Offer", price: it.price, priceCurrency: it.currency },
      ...(it.diet.length ? { suitableForDiet: it.diet.map((d) => `https://schema.org/${d.replace(/-(\w)/, (_m, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase())}Diet`) } : {}),
      ...(it.section ? { category: it.section } : {}),
      ...(it.allergens.length ? { additionalProperty: [{ "@type": "PropertyValue", name: "allergens", value: it.allergens.join(", ") }] } : {}),
    };
    return { id, type, name: it.name, data, hidden: false, source: { url: page.url, via: "heuristic", seen } };
  });
}

const GENERIC_SUBMIT = /^(submit|send|go|ok|continue|search)$/i;

/** Turns an HTML form into a draft action. Drafts are disabled until the owner enables them. */
export function actionFromForm(form: FormInfo, pageUrl: string, seen: string): ActionDef | undefined {
  const names = form.fields.map((f) => f.name.toLowerCase());
  // Skip search boxes and newsletter sign-ups.
  if (form.method === "GET" && names.some((n) => ["q", "s", "query", "search"].includes(n))) return undefined;
  if (form.fields.length === 1 && form.fields[0]!.type === "email") return undefined;

  const basis = !GENERIC_SUBMIT.test(form.submitText) ? form.submitText : form.heading || form.id || "form";
  let name = slugify(basis).replace(/-/g, "_");
  if (!/^[a-z]/.test(name)) name = `submit_${name}`;
  if (GENERIC_SUBMIT.test(form.submitText)) name = `submit_${name}`;

  const input: ActionField[] = form.fields.map((f) => fieldFromForm(f));
  const hasContact = input.some((f) => f.type === "email" || f.type === "phone");
  return {
    name: name.slice(0, 48),
    description: `${form.submitText}${form.heading ? ` (${form.heading})` : ""}. Submits the form on ${new URL(pageUrl).pathname}.`,
    kind: "write",
    input,
    backend: { type: "form-bridge", operation: "submit", config: { action: form.action, method: form.method, page: pageUrl } },
    confirmation: hasContact ? "guest" : "owner",
    idempotency: "required",
    limits: { perAgentPerHour: 10, perIpPerHour: 20 },
    enabled: false,
    note: "Discovered from an HTML form. Prefer a native connector; enable the form bridge only if none exists.",
    source: { url: pageUrl, via: "heuristic", seen },
  };
}

function fieldFromForm(f: FormInfo["fields"][number]): ActionField {
  const base = { name: slugify(f.name).replace(/-/g, "_"), description: f.label, required: f.required };
  switch (f.type) {
    case "number":
    case "range":
      return { ...base, type: "integer", ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) };
    case "email":
      return { ...base, type: "email" };
    case "tel":
      return { ...base, type: "phone" };
    case "date":
      return { ...base, type: "date" };
    case "time":
      return { ...base, type: "time" };
    case "datetime-local":
      return { ...base, type: "datetime" };
    case "checkbox":
      return { ...base, type: "boolean" };
    case "select":
    case "radio":
      return f.options?.length
        ? f.options.every((o) => /^\d{1,2}:\d{2}$/.test(o))
          ? { ...base, type: "time", description: `${f.label} (one of: ${f.options.join(", ")})` }
          : { ...base, type: "enum", enum: f.options }
        : { ...base, type: "string" };
    default:
      return { ...base, type: "string" };
  }
}
