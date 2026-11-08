import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export type FormField = {
  name: string;
  /** HTML input type, or "select" / "textarea" */
  type: string;
  label: string;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
  placeholder?: string;
};

export type FormInfo = {
  id?: string;
  action: string;
  method: "GET" | "POST";
  fields: FormField[];
  submitText: string;
  /** Text of the nearest heading before the form, for context. */
  heading: string;
};

export type ParsedPage = {
  url: string;
  title: string;
  /** From og:site_name or the "Page | Site" title suffix. */
  siteName?: string;
  description: string;
  lang?: string;
  /** Main content as clean Markdown (no nav, footer, scripts, banners). */
  markdown: string;
  /** Footer as Markdown. Often holds hours, address and contact details. */
  footerMarkdown: string;
  jsonLd: Record<string, unknown>[];
  links: string[];
  forms: FormInfo[];
  /** Alt text of meaningful images (menus, price lists may live in images). */
  images: Array<{ src: string; alt: string }>;
};

const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "link",
  "meta",
  "header",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "[aria-hidden=true]",
  "[hidden]",
  "[class*=cookie]",
  "[id*=cookie]",
  "[class*=consent]",
  "[class*=newsletter]",
  "[class*=chat-widget]",
  "[class*=modal]",
  "[class*=popup]",
];

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  // FAQ accordions: <summary> becomes a heading so the question stays attached to its answer.
  td.addRule("summary", {
    filter: ["summary"],
    replacement: (content) => `\n\n### ${content.trim()}\n\n`,
  });
  td.addRule("details", { filter: ["details"], replacement: (content) => `\n\n${content.trim()}\n\n` });
  // Simple tables to Markdown tables.
  td.addRule("table", {
    filter: ["table"],
    replacement: (_content, node) => `\n\n${tableToMarkdown(node as unknown as Element)}\n\n`,
  });
  td.addRule("images", {
    filter: ["img"],
    replacement: (_c, node) => {
      const alt = (node as unknown as Element).getAttribute("alt")?.trim();
      return alt && !/logo|icon/i.test(alt) ? `[Image: ${alt}]` : "";
    },
  });
  // Keep a space between side-by-side inline elements ("Dish</span><span>$9" → "Dish $9").
  td.addRule("spans", {
    filter: (node) => node.nodeName === "SPAN" || node.nodeName === "SMALL",
    replacement: (content, node) => (content.trim() ? `${content}${node.nextSibling ? " " : ""}` : ""),
  });
  td.remove(["input", "select", "textarea", "label"]);
  return td;
}

function tableToMarkdown(table: Element): string {
  // Turndown's internal DOM has no querySelectorAll, so walk with getElementsByTagName.
  const rows = Array.from(table.getElementsByTagName("tr")).map((tr) =>
    Array.from(tr.childNodes as unknown as ArrayLike<Element>)
      .filter((c) => c.nodeName === "TH" || c.nodeName === "TD")
      .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const [head, ...body] = rows;
  return [`| ${pad(head!).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`, ...body.map((r) => `| ${pad(r).join(" | ")} |`)].join("\n");
}

const td = makeTurndown();

function toMarkdown(html: string): string {
  return td
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function absolute(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  if (/^(mailto|tel|javascript|data):/i.test(href)) return undefined;
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

function parseJsonLd(doc: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent ?? "") as unknown;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object") {
          const graph = (item as Record<string, unknown>)["@graph"];
          if (Array.isArray(graph)) out.push(...(graph as Record<string, unknown>[]));
          else out.push(item as Record<string, unknown>);
        }
      }
    } catch {
      // Broken JSON-LD is common; skip it.
    }
  }
  return out;
}

function labelFor(el: Element, doc: Document): string {
  const id = el.getAttribute("id");
  if (id) {
    const l = doc.querySelector(`label[for="${id}"]`);
    if (l?.textContent) return l.textContent.trim();
  }
  const wrap = el.closest("label");
  if (wrap) {
    // Text of the label without the text of the control itself (e.g. select options).
    const clone = wrap.cloneNode(true) as Element;
    for (const c of clone.querySelectorAll("select,textarea,input")) c.remove();
    const t = clone.textContent?.trim();
    if (t) return t;
  }
  return el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "";
}

function parseForms(doc: Document, base: string): FormInfo[] {
  const forms: FormInfo[] = [];
  for (const form of doc.querySelectorAll("form")) {
    const fields: FormField[] = [];
    for (const el of form.querySelectorAll("input,select,textarea")) {
      const name = el.getAttribute("name");
      if (!name) continue;
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
      if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(type)) continue;
      const f: FormField = { name, type, label: labelFor(el, doc), required: el.hasAttribute("required") };
      if (tag === "select") f.options = [...el.querySelectorAll("option")].map((o) => (o.getAttribute("value") ?? o.textContent ?? "").trim());
      const min = el.getAttribute("min");
      const max = el.getAttribute("max");
      if (min && !Number.isNaN(Number(min))) f.min = Number(min);
      if (max && !Number.isNaN(Number(max))) f.max = Number(max);
      const ph = el.getAttribute("placeholder");
      if (ph) f.placeholder = ph;
      fields.push(f);
    }
    if (!fields.length) continue;
    const submit = form.querySelector('button,[type="submit"]');
    let heading = "";
    let prev: Element | null = form;
    while (prev && !heading) {
      let sib: Element | null = prev.previousElementSibling;
      while (sib && !heading) {
        if (/^H[1-4]$/.test(sib.tagName)) heading = sib.textContent?.trim() ?? "";
        sib = sib.previousElementSibling;
      }
      prev = prev.parentElement;
    }
    forms.push({
      id: form.getAttribute("id") ?? undefined,
      action: absolute(form.getAttribute("action") ?? "", base) ?? base,
      method: (form.getAttribute("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
      fields,
      submitText: (submit?.textContent ?? submit?.getAttribute("value") ?? "Submit").trim(),
      heading,
    });
  }
  return forms;
}

/** Parses one HTML page into clean Markdown plus structured hints. */
export function parsePage(html: string, url: string): ParsedPage {
  const { document: doc } = parseHTML(html) as unknown as { document: Document };
  const rawTitle = (doc.querySelector("title")?.textContent ?? "").trim();
  const suffix = rawTitle.match(/\s[|–—-]\s([^|–—-]+)$/)?.[1]?.trim();
  const siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() || suffix || undefined;
  const title = (suffix ? rawTitle.slice(0, rawTitle.lastIndexOf(suffix)).replace(/\s[|–—-]\s*$/, "").trim() : rawTitle) || (doc.querySelector("h1")?.textContent ?? "").trim();
  const description = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
  const lang = doc.documentElement?.getAttribute("lang") ?? undefined;
  const jsonLd = parseJsonLd(doc);
  const forms = parseForms(doc, url);

  const links = new Set<string>();
  for (const a of doc.querySelectorAll("a[href]")) {
    const abs = absolute(a.getAttribute("href"), url);
    if (abs) links.add(abs);
  }
  const images = [...doc.querySelectorAll("img")]
    .map((img) => ({ src: absolute(img.getAttribute("src"), url) ?? "", alt: (img.getAttribute("alt") ?? "").trim() }))
    .filter((i) => i.src && !/logo|icon|avatar/i.test(i.src + i.alt));

  const footerEl = doc.querySelector("footer, [role=contentinfo]");
  const footerMarkdown = footerEl ? toMarkdown(footerEl.innerHTML) : "";

  const body = doc.querySelector("main, [role=main], article") ?? doc.body;
  const clone = body ? (body.cloneNode(true) as Element) : undefined;
  if (clone) for (const sel of CHROME_SELECTORS) for (const el of clone.querySelectorAll(sel)) el.remove();
  const markdown = clone ? toMarkdown(clone.innerHTML) : "";

  return { url, title, siteName, description, lang, markdown, footerMarkdown, jsonLd, links: [...links], forms, images };
}
