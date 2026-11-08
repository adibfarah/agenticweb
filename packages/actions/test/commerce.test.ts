import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { ActionDef, SiteGraph, type Entity } from "@agenticweb-dev/core";
import { buildCatalog, createApp, isPublicHttps, toMinor } from "@agenticweb-dev/runtime";
import { Engine, MemoryStore, OutboxNotifier, builtinConnectors, shopify, woocommerce, type PaymentAdapter } from "../src/index.ts";

let sites: DemoSites;
let products: Entity[];
let shopActions: ActionDef[];
beforeAll(async () => {
  sites = await startDemoSites();
  const r = await shopify.sync!({ store: sites.shop }, { env: {}, fetch, siteUrl: sites.shop });
  products = r.entities;
  shopActions = r.actions;
});
afterAll(() => sites.close());

const PROFILE = "https://platform.example/profile";
/** Stands in for the agent platform's profile server (UCP-Agent). */
const profileFetch = (async (url: string | URL) =>
  String(url) === PROFILE ? Response.json({ ucp: { version: "2026-08-25" } }) : new Response("nope", { status: 404 })) as typeof fetch;

const paid: Array<{ input: Record<string, unknown>; credential?: string }> = [];
const testPay: PaymentAdapter = {
  id: "testpay",
  describe: () => "Test payments",
  pay: async (req) => {
    paid.push({ input: req.input, credential: req.credential });
    return req.credential?.includes("declined") ? { status: "rejected", message: "Card declined." } : { status: "done", message: "Paid.", data: { order_id: "ord_42", order_url: "https://shop.test/orders/42" } };
  },
};
const payAction = ActionDef.parse({
  name: "pay_order",
  description: "Pay for items with an agent payment token.",
  kind: "payment",
  input: [{ name: "items", type: "array", required: true, min: 1, items: [{ name: "sku", type: "string", required: true }, { name: "quantity", type: "integer", required: true, min: 1 }] }],
  backend: { type: "http", operation: "pay", config: { paymentAdapter: "testpay" } },
  confirmation: "payment_protocol",
  enabled: true,
  source: { via: "owner", seen: "2026-11-08T00:00:00Z" },
});

function appFor(opts: { payments?: boolean } = {}) {
  const checkout = shopActions.filter((a) => a.name === "create_checkout_link").map((a) => ({ ...a, enabled: true }));
  const actions = [...checkout, ...(opts.payments ? [payAction] : [])];
  const graph = SiteGraph.parse({ site: { name: "Demo Shop", url: sites.shop }, generatedAt: "2026-11-08T00:00:00Z", entities: products, actions, policies: { terms: "https://shop.test/terms" } });
  const engine = new Engine({ graph, connectors: builtinConnectors, store: new MemoryStore(), notifier: new OutboxNotifier(), env: {}, ownerContact: "owner@shop.test", payments: { testpay: testPay } });
  const app = createApp({ graph, engine, baseUrl: "https://shop.test/.agent", apiKeys: { key_openai: "OpenAI" }, commerce: { fetch: profileFetch } });
  return { app, graph };
}

const sku = () => (products[0]!.data.offers as Array<{ sku: string }>)[0]!.sku;
const ucp = (app: ReturnType<typeof createApp>, path: string, init: RequestInit & { json?: unknown } = {}) =>
  app.fetch(
    new Request(`https://shop.test${path}`, {
      method: init.method ?? (init.json ? "POST" : "GET"),
      headers: { "content-type": "application/json", "ucp-agent": `profile="${PROFILE}"`, ...(init.headers as Record<string, string>) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    }),
  );
const acp = (app: ReturnType<typeof createApp>, path: string, json?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://shop.test${path}`, { method: json === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer key_openai", ...headers }, body: json === undefined ? undefined : JSON.stringify(json) }));

describe("catalog", () => {
  it("reads every priced offer, in minor units", () => {
    const { graph } = appFor();
    const cat = buildCatalog(graph);
    expect(cat.size).toBeGreaterThan(products.length - 1);
    expect(cat.get(sku())!.unit).toBeGreaterThan(0);
    expect(toMinor("19.99", "USD")).toBe(1999);
    expect(toMinor("500", "JPY")).toBe(500);
  });
  it("only fetches public https profiles", () => {
    expect(isPublicHttps("https://platform.example/p")).toBe(true);
    for (const bad of ["http://platform.example/p", "https://localhost/p", "https://127.0.0.1/p", "https://[::1]/p", "https://db.internal/p", "https://intranet/p"]) expect(isPublicHttps(bad)).toBe(false);
  });
});

describe("UCP checkout (handoff to the store's checkout)", () => {
  it("publishes a business profile and lists it in the manifest", async () => {
    const { app } = appFor();
    const profile = (await (await app.fetch(new Request("https://shop.test/.well-known/ucp"))).json()) as { ucp: { version: string; services: Record<string, Array<{ endpoint: string; transport: string }>>; capabilities: Record<string, unknown>; payment_handlers: object } };
    expect(profile.ucp.version).toBe("2026-08-25");
    expect(profile.ucp.services["dev.ucp.shopping"]![0]).toMatchObject({ transport: "rest", endpoint: "https://shop.test/.agent/ucp/v1" });
    expect(profile.ucp.capabilities["dev.ucp.shopping.checkout"]).toBeDefined();
    expect(profile.ucp.payment_handlers).toEqual({});
    const manifest = (await (await app.fetch(new Request("https://shop.test/.well-known/agent-site.json"))).json()) as { interfaces: Record<string, unknown> };
    expect(manifest.interfaces.ucp).toBeDefined();
    expect(manifest.interfaces.acp).toBeUndefined(); // no payment adapter, no ACP
    expect((await acp(app, "/acp/checkout_sessions", { items: [{ id: sku(), quantity: 1 }] })).status).toBe(404);
  });

  it("creates a session that hands the buyer to the store's checkout", async () => {
    const { app } = appFor();
    const res = await ucp(app, "/ucp/v1/checkout-sessions", { json: { line_items: [{ item: { id: sku() }, quantity: 2 }] } });
    expect(res.status).toBe(201);
    const s = (await res.json()) as { id: string; status: string; continue_url: string; currency: string; totals: Array<{ type: string; amount: number }>; messages: Array<{ severity?: string }>; line_items: Array<{ item: { title: string } }>; links: unknown[] };
    expect(s.status).toBe("requires_escalation");
    expect(s.continue_url).toBe(`${sites.shop}/cart/${sku()}:2`);
    expect(s.messages.some((m) => m.severity === "requires_buyer_review")).toBe(true);
    expect(s.totals.find((t) => t.type === "total")!.amount).toBe(buildCatalog(appFor().graph).get(sku())!.unit * 2);
    expect(s.line_items[0]!.item.title).toBeTruthy();
    expect(s.links).toEqual([{ type: "terms_of_service", url: "https://shop.test/terms" }]);

    // Get, then a full-replacement update.
    expect(((await (await ucp(app, `/ucp/v1/checkout-sessions/${s.id}`)).json()) as { id: string }).id).toBe(s.id);
    const up = (await (await ucp(app, `/ucp/v1/checkout-sessions/${s.id}`, { method: "PUT", json: { line_items: [{ item: { id: sku() }, quantity: 1 }] } })).json()) as { continue_url: string };
    expect(up.continue_url).toBe(`${sites.shop}/cart/${sku()}:1`);

    // Complete without agent payments keeps pointing at the handoff.
    const done = (await (await ucp(app, `/ucp/v1/checkout-sessions/${s.id}/complete`, { json: { payment: { instruments: [] } } })).json()) as { status: string };
    expect(done.status).toBe("requires_escalation");
    const canceled = (await (await ucp(app, `/ucp/v1/checkout-sessions/${s.id}/cancel`, { method: "POST" })).json()) as { status: string; continue_url?: string };
    expect(canceled.status).toBe("canceled");
    expect(canceled.continue_url).toBeUndefined();
  });

  it("explains unknown items instead of failing", async () => {
    const { app } = appFor();
    const s = (await (await ucp(app, "/ucp/v1/checkout-sessions", { json: { line_items: [{ item: { id: "nope" }, quantity: 1 }] } })).json()) as { status: string; messages: Array<{ code: string; path: string }> };
    expect(s.status).toBe("incomplete");
    expect(s.messages[0]).toMatchObject({ code: "item_unavailable", path: "$.line_items[0].item.id" });
  });

  it("requires and checks the platform profile", async () => {
    const { app } = appFor();
    const noHeader = await app.fetch(new Request("https://shop.test/ucp/v1/checkout-sessions", { method: "POST", body: "{}" }));
    expect(noHeader.status).toBe(400);
    const unknown = await ucp(app, "/ucp/v1/checkout-sessions", { json: { line_items: [] }, headers: { "ucp-agent": 'profile="https://other.example/profile"' } });
    expect(unknown.status).toBe(424);
    const internal = await ucp(app, "/ucp/v1/checkout-sessions", { json: { line_items: [] }, headers: { "ucp-agent": 'profile="https://169.254.169.254/latest"' } });
    expect(internal.status).toBe(422);
  });

  it("replays repeated requests and refuses a reused key", async () => {
    const { app } = appFor();
    const body = { line_items: [{ item: { id: sku() }, quantity: 1 }] };
    const a = (await (await ucp(app, "/ucp/v1/checkout-sessions", { json: body, headers: { "idempotency-key": "k1" } })).json()) as { id: string };
    const b = (await (await ucp(app, "/ucp/v1/checkout-sessions", { json: body, headers: { "idempotency-key": "k1" } })).json()) as { id: string };
    expect(b.id).toBe(a.id);
    const c = await ucp(app, "/ucp/v1/checkout-sessions", { json: { line_items: [{ item: { id: sku() }, quantity: 3 }] }, headers: { "idempotency-key": "k1" } });
    expect(c.status).toBe(409);
  });
});

describe("UCP and ACP with agent payments", () => {
  it("UCP completes through the payment adapter", async () => {
    const { app } = appFor({ payments: true });
    const s = (await (await ucp(app, "/ucp/v1/checkout-sessions", { json: { line_items: [{ item: { id: sku() }, quantity: 1 }] } })).json()) as { id: string; status: string };
    expect(s.status).toBe("ready_for_complete");
    const instrument = { id: "instr_1", handler_id: "testpay", type: "card", selected: true, credential: { type: "token", token: "tok_ok" } };
    const done = (await (await ucp(app, `/ucp/v1/checkout-sessions/${s.id}/complete`, { json: { payment: { instruments: [instrument] } } })).json()) as { status: string; order: { id: string; permalink_url: string } };
    expect(done.status).toBe("completed");
    expect(done.order).toEqual({ id: "ord_42", permalink_url: "https://shop.test/orders/42" });
    expect(paid.at(-1)!.input).toEqual({ items: [{ sku: sku(), quantity: 1 }] });
    expect(paid.at(-1)!.credential).toContain("tok_ok");
  });

  it("ACP runs the full checkout session flow", async () => {
    const { app } = appFor({ payments: true });
    const manifest = (await (await app.fetch(new Request("https://shop.test/.well-known/agent-site.json"))).json()) as { interfaces: Record<string, unknown> };
    expect(manifest.interfaces.acp).toBeDefined();

    const created = await acp(app, "/acp/checkout_sessions", { items: [{ id: sku(), quantity: 2 }] });
    expect(created.status).toBe(201);
    const s = (await created.json()) as { id: string; status: string; currency: string; payment_provider: { provider: string }; line_items: Array<{ base_amount: number; total: number }>; totals: Array<{ type: string; amount: number }>; fulfillment_options: unknown[]; links: Array<{ type: string }> };
    expect(s.status).toBe("ready_for_payment");
    expect(s.currency).toMatch(/^[a-z]{3}$/);
    expect(s.payment_provider.provider).toBe("stripe");
    expect(s.line_items[0]!.total).toBe(s.line_items[0]!.base_amount);
    expect(s.totals.map((t) => t.type)).toEqual(["items_base_amount", "subtotal", "total"]);
    expect(s.links[0]!.type).toBe("terms_of_use");

    const updated = (await (await acp(app, `/acp/checkout_sessions/${s.id}`, { items: [{ id: sku(), quantity: 1 }] })).json()) as { line_items: Array<{ item: { quantity: number } }> };
    expect(updated.line_items[0]!.item.quantity).toBe(1);

    const declined = (await (await acp(app, `/acp/checkout_sessions/${s.id}/complete`, { payment_data: { token: "spt_declined", provider: "stripe" } })).json()) as { status: string; messages: Array<{ code: string }> };
    expect(declined.status).toBe("ready_for_payment");
    expect(declined.messages[0]!.code).toBe("payment_declined");

    const done = (await (await acp(app, `/acp/checkout_sessions/${s.id}/complete`, { payment_data: { token: "spt_ok", provider: "stripe" } })).json()) as { status: string; order: { id: string; checkout_session_id: string } };
    expect(done.status).toBe("completed");
    expect(done.order).toMatchObject({ id: "ord_42", checkout_session_id: s.id });
    expect((await acp(app, `/acp/checkout_sessions/${s.id}/cancel`, {})).status).toBe(405);
  });

  it("ACP needs an API key the store issued", async () => {
    const { app } = appFor({ payments: true });
    expect((await acp(app, "/acp/checkout_sessions", { items: [{ id: sku(), quantity: 1 }] }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await acp(app, "/acp/checkout_sessions", { items: [] })).status).toBe(400);
  });
});

describe("WooCommerce checkout links", () => {
  const product = (id: number, name: string) => ({ id, name, slug: name, permalink: "", is_in_stock: true, prices: { price: "1250", currency_code: "EUR", currency_minor_unit: 2 } });
  const wooFetch = (async (url: string | URL) => {
    const id = Number(String(url).split("/").pop());
    return id === 404 ? new Response("", { status: 404 }) : Response.json(product(id, `Mug ${id}`));
  }) as typeof fetch;
  const run = (input: Record<string, unknown>, config: Record<string, unknown> = {}) =>
    woocommerce.execute({ operation: "create_checkout_link", input, config: { store: "https://shop.test", ...config }, env: {}, fetch: wooFetch });

  it("puts several products in one shareable checkout link", async () => {
    const r = await run({ items: [{ sku: "11", quantity: 2 }, { sku: "12", quantity: 1 }] });
    expect(r.checkout_url).toBe("https://shop.test/checkout-link/?products=11:2,12:1");
    expect(r.data?.subtotal).toBe("37.50");
  });
  it("keeps the old one-product links for older stores", async () => {
    expect((await run({ items: [{ sku: "11", quantity: 3 }] }, { checkoutLinks: "add-to-cart" })).checkout_url).toBe("https://shop.test/checkout/?add-to-cart=11&quantity=3");
    expect((await run({ items: [{ sku: "11", quantity: 1 }, { sku: "12", quantity: 1 }] }, { checkoutLinks: "add-to-cart" })).status).toBe("rejected");
  });
  it("rejects unknown products", async () => {
    expect((await run({ items: [{ sku: "404", quantity: 1 }] })).status).toBe("rejected");
  });
});
