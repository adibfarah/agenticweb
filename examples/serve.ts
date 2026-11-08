import http from "node:http";
import type { AddressInfo } from "node:net";
import { restaurant, restaurantPages } from "./sites/restaurant.ts";
import { shop, shopPages, shopProductsJson } from "./sites/shop.ts";
import { docsPages } from "./sites/docs.ts";

export type DemoState = {
  bookings: Array<{ uid: string; start: string; name: string; email: string; partySize: number; via: string }>;
  contacts: Array<Record<string, string>>;
  carts: Array<{ items: Array<{ variantId: number; quantity: number }> }>;
};

export type DemoSites = {
  restaurant: string;
  shop: string;
  docs: string;
  state: DemoState;
  close: () => Promise<void>;
};

type Handler = (req: http.IncomingMessage, url: URL, body: string) => { status?: number; type?: string; body: string } | undefined;

function sitemap(origin: string, paths: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${origin}${p}</loc></url>`)
    .join("")}</urlset>`;
}

function staticSite(getPages: (origin: string) => Record<string, string>, extra?: Handler, robots = "User-agent: *\nAllow: /\n"): (origin: string) => Handler {
  return (origin) => {
    return (req, url, body) => {
      // Rendered per request so tests can change site data (e.g. a price) while the server runs.
      const pages = getPages(origin);
      const hit = extra?.(req, url, body);
      if (hit) return hit;
      if (url.pathname === "/robots.txt") return { type: "text/plain", body: `${robots}Sitemap: ${origin}/sitemap.xml\n` };
      if (url.pathname === "/sitemap.xml") return { type: "application/xml", body: sitemap(origin, Object.keys(pages)) };
      if (url.pathname.startsWith("/static/")) return { type: "text/plain", body: "" };
      const html = pages[url.pathname] ?? pages[url.pathname.replace(/\/$/, "")] ?? pages[`${url.pathname}/`];
      if (html) return { type: "text/html; charset=utf-8", body: html };
      return undefined;
    };
  };
}

const json = (data: unknown, status = 200) => ({ status, type: "application/json", body: JSON.stringify(data) });

/** Opening slots for a date in the restaurant's local time, minus booked ones. */
function slotsFor(date: string, state: DemoState): string[] {
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const hours = restaurant.hours.find((h) => h.days === day);
  if (!hours?.open || !hours.close) return [];
  const out: string[] = [];
  const [oh, om] = hours.open.split(":").map(Number) as [number, number];
  const [ch] = hours.close.split(":").map(Number) as [number];
  for (let m = oh * 60 + om; m <= (ch - 1) * 60; m += 30) {
    const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const start = `${date}T${t}:00.000-08:00`;
    // Each slot holds up to 3 bookings in this demo.
    if (state.bookings.filter((b) => b.start === start).length < 3) out.push(start);
  }
  return out;
}

function restaurantExtra(state: DemoState): Handler {
  return (req, url, body) => {
    // Mock of the Cal.com v2 API (the restaurant's booking provider).
    if (url.pathname === "/calcom/v2/slots" && req.method === "GET") {
      const start = url.searchParams.get("start") ?? "";
      const end = url.searchParams.get("end") ?? start;
      const data: Record<string, Array<{ start: string }>> = {};
      for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        const slots = slotsFor(date, state);
        if (slots.length) data[date] = slots.map((s) => ({ start: s }));
      }
      return json({ status: "success", data });
    }
    if (url.pathname === "/calcom/v2/bookings" && req.method === "POST") {
      if (!req.headers.authorization?.startsWith("Bearer ")) return json({ status: "error", error: { message: "Unauthorized" } }, 401);
      const b = JSON.parse(body || "{}") as { start?: string; attendee?: { name?: string; email?: string }; bookingFieldsResponses?: { guests_count?: number } };
      if (!b.start || !b.attendee?.name || !b.attendee.email) return json({ status: "error", error: { message: "start and attendee are required" } }, 400);
      // Cal.com takes the start time in UTC; match it to a local slot by instant.
      const at = Date.parse(b.start);
      const localDate = new Date(at - 8 * 3_600_000).toISOString().slice(0, 10);
      const slot = slotsFor(localDate, state).find((s) => Date.parse(s) === at);
      if (!slot) return json({ status: "error", error: { message: "Slot not available" } }, 409);
      const uid = `bk_${state.bookings.length + 1}`;
      state.bookings.push({ uid, start: slot, name: b.attendee.name, email: b.attendee.email, partySize: b.bookingFieldsResponses?.guests_count ?? 2, via: "calcom" });
      return json({ status: "success", data: { uid, start: slot, status: "accepted" } }, 201);
    }
    // The site's own HTML form handler.
    if (url.pathname === "/api/book" && req.method === "POST") {
      const f = Object.fromEntries(new URLSearchParams(body));
      const start = `${f.date}T${f.time}:00.000-08:00`;
      if (!f.date || !f.time || !f.name || !f.email) return { status: 400, type: "text/html", body: "<p>Missing fields</p>" };
      if (!slotsFor(f.date, state).includes(start)) return { status: 409, type: "text/html", body: "<p>Sorry, that time is fully booked.</p>" };
      const uid = `bk_${state.bookings.length + 1}`;
      state.bookings.push({ uid, start, name: f.name, email: f.email, partySize: Number(f.party_size ?? 2), via: "form" });
      return { type: "text/html", body: `<h1>Thank you!</h1><p>Booking request ${uid} received.</p>` };
    }
    if (url.pathname === "/catering-menu.pdf") {
      // A tiny placeholder PDF. Tests read it with a fake model; real runs send it to Claude.
      return { type: "application/pdf", body: "%PDF-1.4\n% Bella Cucina catering menu\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n" };
    }
    if (url.pathname === "/api/contact" && req.method === "POST") {
      state.contacts.push(Object.fromEntries(new URLSearchParams(body)));
      return { type: "text/html", body: "<p>Thanks, we'll be in touch.</p>" };
    }
    return undefined;
  };
}

function shopExtra(state: DemoState): Handler {
  return (_req, url) => {
    if (url.pathname === "/products.json") return json(shopProductsJson());
    // Shopify-style cart permalink: /cart/50012:1,50021:2
    const m = url.pathname.match(/^\/cart\/([\d:,]+)$/);
    if (m?.[1]) {
      const items = m[1].split(",").map((pair) => {
        const [variantId, quantity] = pair.split(":").map(Number) as [number, number];
        return { variantId, quantity };
      });
      state.carts.push({ items });
      const lines = items.map((i) => {
        const p = shop.products.find((pr) => pr.variants.some((v) => v.id === i.variantId));
        const v = p?.variants.find((x) => x.id === i.variantId);
        return `<li>${i.quantity} × ${p?.title} (${v?.color} / ${v?.size})</li>`;
      });
      return { type: "text/html", body: `<h1>Checkout</h1><ul>${lines.join("")}</ul><p>Enter your details to pay.</p>` };
    }
    return undefined;
  };
}

async function listen(handlerFor: (origin: string) => Handler, port: number): Promise<{ origin: string; server: http.Server }> {
  let handler: Handler = () => undefined;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const out = handler(req, url, body);
      if (!out) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<h1>Not found</h1>");
        return;
      }
      res.writeHead(out.status ?? 200, { "content-type": out.type ?? "text/html" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = handlerFor(origin);
  return { origin, server };
}

/** Starts the three demo sites. Port 0 picks a free port (used by tests). */
export async function startDemoSites(ports = { restaurant: 0, shop: 0, docs: 0 }): Promise<DemoSites> {
  const state: DemoState = { bookings: [], contacts: [], carts: [] };
  const r = await listen(staticSite(() => restaurantPages(), restaurantExtra(state), "User-agent: *\nDisallow: /api/\n"), ports.restaurant);
  const s = await listen(staticSite((o) => shopPages(o), shopExtra(state), "User-agent: *\nDisallow: /cart\n"), ports.shop);
  const d = await listen(staticSite(() => docsPages()), ports.docs);
  return {
    restaurant: r.origin,
    shop: s.origin,
    docs: d.origin,
    state,
    close: async () => {
      await Promise.all([r, s, d].map(({ server }) => new Promise<void>((res) => server.close(() => res()))));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("serve.ts")) {
  const sites = await startDemoSites({ restaurant: 4101, shop: 4102, docs: 4103 });
  console.log(`Demo restaurant: ${sites.restaurant}\nDemo shop:       ${sites.shop}\nDemo docs:       ${sites.docs}`);
}
