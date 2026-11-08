import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { crawl } from "@agenticweb-dev/ingest";
import { fieldsToJsonLd, parseOpeningHours, understand, type Llm } from "../src/index.ts";

let sites: DemoSites;
beforeAll(async () => {
  sites = await startDemoSites();
});
afterAll(() => sites.close());

describe("heuristic mode (no API key)", () => {
  it("builds a useful graph for the restaurant", async () => {
    const c = await crawl(sites.restaurant);
    const g = await understand(c, { siteUrl: sites.restaurant });
    expect(g.site.name).toBe("Bella Cucina");
    expect(g.site.type).toBe("Restaurant");
    expect(g.site.contact.phone).toBe("+1-503-555-0100");

    const biz = g.entities.find((e) => e.id.endsWith("#business"))!;
    const hours = biz.data.openingHoursSpecification as Array<{ dayOfWeek: string; opens: string }>;
    expect(hours).toHaveLength(6); // closed Mondays
    expect(hours.find((h) => h.dayOfWeek.endsWith("Friday"))?.opens).toBe("17:00");

    const faq = g.entities.find((e) => e.type === "FAQPage")!;
    expect((faq.data.mainEntity as unknown[]).length).toBe(5);

    const booking = g.actions.find((a) => a.backend.config.action === `${sites.restaurant}/api/book`)!;
    expect(booking.name).toBe("request_booking");
    expect(booking.enabled).toBe(false);
    expect(booking.confirmation).toBe("guest");
    expect(booking.input.find((f) => f.name === "party_size")).toMatchObject({ type: "integer", min: 1, max: 12 });
    expect(booking.input.find((f) => f.name === "time")?.type).toBe("time");

    expect(g.pages.find((p) => p.slug === "menu")?.pageType).toBe("menu");
    const dishes = g.entities.filter((e) => e.type === "MenuItem");
    expect(dishes).toHaveLength(12);
    const aglio = dishes.find((d) => d.name === "Spaghetti aglio e olio")!;
    expect(aglio.data.offers).toMatchObject({ price: "15", priceCurrency: "USD" });
    expect(aglio.data.suitableForDiet).toEqual(["https://schema.org/VeganDiet"]);
    expect(aglio.data.category).toBe("Pasta");
    expect(aglio.data.description).toBe("Garlic, chili, olive oil.");
    expect(g.pages.find((p) => p.slug === "index")?.markdown).toContain("Site information");
  });

  it("uses JSON-LD products from the shop", async () => {
    const g = await understand(await crawl(sites.shop), { siteUrl: sites.shop });
    const products = g.entities.filter((e) => e.type === "Product");
    expect(products.map((p) => p.name).sort()).toEqual(["Classic Hoodie", "Everyday Tee", "Merino Beanie", "Relaxed Chinos"]);
    expect(g.pages.find((p) => p.slug === "products-classic-hoodie")?.pageType).toBe("product");
    expect(g.actions.find((a) => a.name === "add_to_cart")).toBeDefined();
  });

  it("keeps owner choices on rebuild", async () => {
    const c = await crawl(sites.restaurant);
    const first = await understand(c, { siteUrl: sites.restaurant });
    first.actions[0]!.enabled = true;
    first.entities[0]!.hidden = true;
    const second = await understand(c, { siteUrl: sites.restaurant, previous: first });
    expect(second.actions[0]!.enabled).toBe(true);
    expect(second.entities.find((e) => e.id === first.entities[0]!.id)?.hidden).toBe(true);
  });
});

describe("Claude mode (fake model)", () => {
  it("adds extracted entities and refined actions", async () => {
    const calls: string[] = [];
    const fake: Llm = {
      async extract({ system, content }) {
        calls.push(system.slice(0, 30));
        if (system.includes("describe a business")) {
          return { name: "Bella Cucina", description: "Italian restaurant.", type: "Restaurant", phone: "", email: "", address: "" } as never;
        }
        if (system.includes("HTML forms")) {
          return {
            actions: [
              { formIndex: 0, skip: false, name: "request_booking", description: "Request a table.", confirmation: "guest" },
              { formIndex: 1, skip: true, name: "x", description: "", confirmation: "none" },
            ],
          } as never;
        }
        if (content.includes("/menu.html")) {
          return {
            pageType: "menu",
            summary: "The menu.",
            entities: [{ type: "MenuItem", name: "Margherita", description: "Tomato, mozzarella, basil.", fields: [{ name: "price", value: "$16" }, { name: "diet", value: "vegetarian" }] }],
          } as never;
        }
        return { pageType: "other", summary: "", entities: [] } as never;
      },
    };
    const g = await understand(await crawl(sites.restaurant), { siteUrl: sites.restaurant, llm: fake });
    const pizza = g.entities.find((e) => e.name === "Margherita")!;
    expect(pizza.source.via).toBe("llm");
    expect(pizza.data.offers).toMatchObject({ price: "16", priceCurrency: "USD" });
    expect(pizza.data.suitableForDiet).toEqual(["https://schema.org/VegetarianDiet"]);
    expect(g.actions.map((a) => a.name)).toEqual(["request_booking"]);
    expect(g.site.description).toBe("Italian restaurant.");
    expect(calls.length).toBeGreaterThan(3);
  });

  it("reads PDFs into pages when the model can", async () => {
    const c = await crawl(sites.restaurant);
    expect(c.documents).toEqual([`${sites.restaurant}/catering-menu.pdf`]);
    const fake: Llm = {
      extract: async () => Promise.reject(new Error("skip")),
      readDocument: async ({ pdfBase64 }) => {
        expect(Buffer.from(pdfBase64, "base64").toString()).toContain("%PDF");
        return { title: "Catering menu", markdown: "## Trays\n\nLasagna tray $85\nServes 10.\n\nCaprese salad tray $45\nServes 10.\n\nTiramisu tray $55\nServes 12." } as never;
      },
    };
    const g = await understand(c, { siteUrl: sites.restaurant, llm: fake });
    const page = g.pages.find((p) => p.url.endsWith("catering-menu.pdf"))!;
    expect(page.title).toBe("Catering menu");
    expect(g.entities.find((e) => e.name === "Lasagna tray")?.data.offers).toMatchObject({ price: "85" });
  });

  it("falls back to heuristics when Claude fails", async () => {
    const broken: Llm = { extract: async () => Promise.reject(new Error("offline")) };
    const g = await understand(await crawl(sites.restaurant), { siteUrl: sites.restaurant, llm: broken });
    expect(g.entities.some((e) => e.type === "FAQPage")).toBe(true);
    expect(g.actions.length).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  it("parses opening hours", () => {
    expect(parseOpeningHours("- Monday: Closed\n- Tuesday: 17:00–22:00\n- Sunday: 9.30-21:00")).toEqual([
      { dayOfWeek: "Tuesday", opens: "17:00", closes: "22:00" },
      { dayOfWeek: "Sunday", opens: "09:30", closes: "21:00" },
    ]);
  });

  it("maps fields to schema.org", () => {
    const ld = fieldsToJsonLd("Product", "Tee", "", [
      { name: "price", value: "€28" },
      { name: "availability", value: "sold out" },
      { name: "fabric", value: "cotton" },
    ]);
    expect(ld.offers).toEqual({ "@type": "Offer", price: "28", priceCurrency: "EUR", availability: "https://schema.org/OutOfStock" });
    expect(ld.additionalProperty).toEqual([{ "@type": "PropertyValue", name: "fabric", value: "cotton" }]);
  });
});

describe("contact details", () => {
  it("ignores example numbers in code samples", async () => {
    const c = await crawl(sites.docs);
    const g = await understand(c, { siteUrl: sites.docs });
    expect(g.site.contact.phone).toBeUndefined();
  });
});

describe("other AI providers", () => {
  it("reads the site with a Chat Completions provider", async () => {
    const { llmFromSettings } = await import("../src/index.ts");
    const { ProjectConfig } = await import("@agenticweb-dev/core");
    const settings = ProjectConfig.parse({ site: sites.restaurant, llm: { provider: "gemini" } }).llm;
    expect(llmFromSettings(settings, {})).toBeUndefined();
    const models: string[] = [];
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      // An empty but valid reply for any extraction step: the build falls back to built-in rules where it's thin.
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
    }) as typeof fetch;
    const ai = llmFromSettings(settings, { GEMINI_API_KEY: "k" }, f)!;
    expect(ai.label).toBe("Gemini");
    const { z } = await import("zod");
    const out = await ai.llm.extract({ model: "claude-opus-5-5", system: "s", content: "c", schema: z.object({ name: z.string().optional() }) });
    expect(out).toEqual({});
    expect(models).toEqual(["gemini-3-flash-preview"]);
    expect(ai.llm.readDocument).toBeUndefined();
  });
});
