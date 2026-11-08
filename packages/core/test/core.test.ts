import { describe, expect, it } from "vitest";
import {
  ProjectConfig,
  SiteGraph,
  entityFileName,
  fieldsToJsonSchema,
  publicView,
  slugForUrl,
  validateInput,
  type ActionField,
} from "../src/index.ts";

const fields: ActionField[] = [
  { name: "date", type: "date", description: "", required: true },
  { name: "time", type: "time", description: "", required: true },
  { name: "party_size", type: "integer", description: "", required: true, min: 1, max: 12 },
  { name: "email", type: "email", description: "", required: false },
];

const seen = "2026-11-07T00:00:00Z";

describe("fields", () => {
  it("builds a JSON schema", () => {
    const s = fieldsToJsonSchema(fields) as { required: string[]; properties: Record<string, { type: string }> };
    expect(s.required).toEqual(["date", "time", "party_size"]);
    expect(s.properties.party_size?.type).toBe("integer");
  });

  it("validates and coerces input", () => {
    const r = validateInput(fields, { date: "2026-12-04", time: "19:30", party_size: "4" });
    expect(r).toEqual({ ok: true, value: { date: "2026-12-04", time: "19:30", party_size: 4 } });
  });

  it("reports clear errors", () => {
    const r = validateInput(fields, { date: "tomorrow", party_size: 40, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("extra is not a known field");
      expect(r.errors).toContain("time is required");
      expect(r.errors.some((e) => e.startsWith("date"))).toBe(true);
      expect(r.errors).toContain("party_size must be at most 12");
    }
  });

  it("validates nested arrays", () => {
    const cart: ActionField[] = [
      {
        name: "items",
        type: "array",
        description: "",
        required: true,
        min: 1,
        items: [
          { name: "sku", type: "string", description: "", required: true },
          { name: "quantity", type: "integer", description: "", required: true, min: 1 },
        ],
      },
    ];
    expect(validateInput(cart, { items: [{ sku: "A", quantity: 2 }] }).ok).toBe(true);
    expect(validateInput(cart, { items: [{ sku: "A", quantity: 0 }] }).ok).toBe(false);
    expect(validateInput(cart, { items: [] }).ok).toBe(false);
  });
});

describe("util", () => {
  it("makes slugs from URLs", () => {
    expect(slugForUrl("https://x.com/")).toBe("index");
    expect(slugForUrl("https://x.com/menu.html")).toBe("menu");
    expect(slugForUrl("https://x.com/shop/Blue-Hoodie/")).toBe("shop-blue-hoodie");
  });

  it("names entity files", () => {
    expect(entityFileName("Product")).toBe("products");
    expect(entityFileName("MenuItem")).toBe("menu-items");
    expect(entityFileName("FAQPage")).toBe("faq-pages");
    expect(entityFileName("LocalBusiness")).toBe("local-business");
    expect(entityFileName("Policy")).toBe("policies");
  });

  it("hides what the owner hid", () => {
    const page = { url: "https://x.com/a", title: "A", markdown: "", hash: "1", updated: seen, source: { via: "crawl", seen } } as const;
    const g = SiteGraph.parse({
      site: { name: "X", url: "https://x.com" },
      generatedAt: seen,
      pages: [
        { ...page, slug: "a" },
        { ...page, slug: "b", hidden: true },
      ],
    });
    expect(publicView(g).pages.map((p) => p.slug)).toEqual(["a"]);
  });

  it("fills config defaults", () => {
    const c = ProjectConfig.parse({ site: "https://x.com" });
    expect(c.crawl.maxPages).toBe(200);
    expect(c.llm.extractModel).toBe("claude-opus-5-5");
  });
});
