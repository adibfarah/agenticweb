import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { crawl, parsePage, parseRobots, verifyOwnership } from "../src/index.ts";

let sites: DemoSites;
beforeAll(async () => {
  sites = await startDemoSites();
});
afterAll(() => sites.close());

describe("robots", () => {
  it("applies the longest matching rule", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\nSitemap: https://x.com/s.xml");
    expect(r.isAllowed("/private/x")).toBe(false);
    expect(r.isAllowed("/private/ok/1")).toBe(true);
    expect(r.isAllowed("/menu")).toBe(true);
    expect(r.sitemaps).toEqual(["https://x.com/s.xml"]);
  });

  it("prefers a group for our own bot", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: AgenticWebBot\nAllow: /");
    expect(r.isAllowed("/anything")).toBe(true);
  });
});

describe("parsePage", () => {
  it("strips clutter and keeps content", () => {
    const html = `<html><head><title>Menu | Cafe</title><meta name="description" content="Food"></head><body>
      <div class="cookie-banner">We use cookies</div><nav><a href="/a">A</a></nav>
      <main><h1>Menu</h1><p>Soup $5</p><details><summary>Vegan?</summary><p>Yes</p></details>
      <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$49</td></tr></table></main>
      <footer>Open daily 9-5</footer><script>track()</script></body></html>`;
    const p = parsePage(html, "https://cafe.test/menu");
    expect(p.title).toBe("Menu");
    expect(p.description).toBe("Food");
    expect(p.markdown).toContain("# Menu");
    expect(p.markdown).toContain("### Vegan?");
    expect(p.markdown).toContain("| Pro | $49 |");
    expect(p.markdown).not.toContain("cookies");
    expect(p.markdown).not.toContain("track()");
    expect(p.footerMarkdown).toContain("Open daily");
  });

  it("extracts forms with labels", () => {
    const html = `<h2>Book</h2><form action="/api/book" method="post"><label>Guests <input type="number" name="party_size" min="1" max="12" required></label>
      <label>Time <select name="time"><option>18:00</option><option>19:00</option></select></label><button>Request booking</button></form>`;
    const [form] = parsePage(html, "https://cafe.test/book").forms;
    expect(form?.action).toBe("https://cafe.test/api/book");
    expect(form?.method).toBe("POST");
    expect(form?.heading).toBe("Book");
    expect(form?.fields[0]).toMatchObject({ name: "party_size", type: "number", label: "Guests", required: true, min: 1, max: 12 });
    expect(form?.fields[1]?.options).toEqual(["18:00", "19:00"]);
  });
});

describe("crawl", () => {
  it("crawls the demo restaurant and respects robots.txt", async () => {
    const r = await crawl(sites.restaurant, { maxPages: 50 });
    const paths = r.pages.map((p) => new URL(p.url).pathname).sort();
    expect(paths).toEqual(["/", "/about.html", "/book.html", "/contact.html", "/faq.html", "/menu.html", "/privacy"]);
    const menu = r.pages.find((p) => p.url.endsWith("/menu.html"))!;
    expect(menu.markdown).toContain("Spaghetti aglio e olio");
    expect(menu.markdown).not.toContain("Accept all");
    expect(r.pages.find((p) => p.url.endsWith("/book.html"))!.forms[0]?.fields.map((f) => f.name)).toContain("party_size");
  });

  it("reads JSON-LD from the demo shop", async () => {
    const r = await crawl(sites.shop, { maxPages: 50 });
    const hoodie = r.pages.find((p) => p.url.endsWith("/products/classic-hoodie"))!;
    expect(hoodie.jsonLd[0]?.["@type"]).toBe("Product");
  });

  it("stops at maxPages", async () => {
    const r = await crawl(sites.shop, { maxPages: 3 });
    expect(r.pages.length).toBe(3);
  });
});

describe("verifyOwnership", () => {
  it("skips verification for local hosts", async () => {
    expect((await verifyOwnership(sites.restaurant, "t")).method).toBe("skipped-local");
  });

  it("accepts a DNS TXT record", async () => {
    const r = await verifyOwnership("https://example.com", "abc", { resolveTxt: async () => [["agenticweb-verify=abc"]] });
    expect(r).toMatchObject({ verified: true, method: "dns-txt" });
  });

  it("explains how to verify when nothing matches", async () => {
    const r = await verifyOwnership("https://example.com", "abc", {
      resolveTxt: async () => [],
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    expect(r.verified).toBe(false);
    expect(r.instructions).toContain("agenticweb-verify=abc");
  });
});
