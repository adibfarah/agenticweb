import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { ProjectConfig, SiteGraph, type ActionDef } from "@agenticweb-dev/core";
import { createApp, type CallContext } from "@agenticweb-dev/runtime";
import { serveNode } from "@agenticweb-dev/runtime/node";
import { Engine, MemoryStore, OutboxNotifier, builtinConnectors, calcom, createEngine, maskContact, openapi, parseApiKeys, shopify, stripe, syncSources } from "../src/index.ts";

let sites: DemoSites;
beforeAll(async () => {
  sites = await startDemoSites();
});
afterAll(() => sites.close());

const seen = "2026-11-07T00:00:00Z";
const graphWith = (actions: ActionDef[], entities: SiteGraph["entities"] = []) =>
  SiteGraph.parse({ site: { name: "Bella Cucina", url: sites.restaurant, contact: { email: "owner@bella.test" } }, generatedAt: seen, actions: actions.map((a) => ({ ...a, enabled: true })), entities });
const ctx = (over: Partial<CallContext> = {}): CallContext => ({ agent: "test-agent", ip: "1.2.3.4", baseUrl: "https://agents.bella.test", ...over });

async function calcomActions() {
  return (await calcom.sync!({ baseUrl: `${sites.restaurant}/calcom`, eventTypeId: 1, timeZone: "America/Los_Angeles" }, { env: {}, fetch, siteUrl: sites.restaurant })).actions;
}

function engineFor(actions: ActionDef[], opts: { env?: Record<string, string>; now?: () => Date } = {}) {
  const notifier = new OutboxNotifier();
  const store = new MemoryStore();
  const engine = new Engine({ graph: graphWith(actions), connectors: builtinConnectors, store, notifier, env: opts.env ?? { CALCOM_API_KEY: "test" }, ownerContact: "owner@bella.test", now: opts.now });
  return { engine, notifier, store };
}

const booking = { date: "2026-12-04", time: "19:30", party_size: 4, name: "Sam Lee", email: "sam@example.com" };

describe("Cal.com booking with guest confirmation", () => {
  it("checks availability", async () => {
    const { engine } = engineFor(await calcomActions());
    const r = await engine.call("check_availability", { date: "2026-12-04" }, ctx());
    expect(r.status).toBe("done");
    expect(r.data?.times).toContain("19:30");
    const closed = await engine.call("check_availability", { date: "2026-12-07" }, ctx()); // Monday
    expect(closed.message).toMatch(/Nothing is available/);
  });

  it("books only after the guest confirms", async () => {
    const { engine, notifier } = engineFor(await calcomActions());
    const before = sites.state.bookings.length;

    const noKey = await engine.call("request_booking", booking, ctx());
    expect(noKey.status).toBe("rejected");
    expect(noKey.errors?.[0]).toMatch(/Idempotency-Key/);

    const r = await engine.call("request_booking", booking, ctx({ idempotencyKey: "k1" }));
    expect(r.status).toBe("pending_confirmation");
    expect(r.final).toBe(false);
    expect(r.message).toContain("s***@example.com");
    expect(sites.state.bookings.length).toBe(before); // nothing booked yet

    const again = await engine.call("request_booking", booking, ctx({ idempotencyKey: "k1" }));
    expect(again.id).toBe(r.id);
    expect(notifier.sent).toHaveLength(1);

    const notice = notifier.sent[0]!;
    expect(notice.to).toBe("sam@example.com");
    expect(notice.text).toContain("Number of people: 4");
    const token = notice.link!.split("/confirm/")[1]!;
    expect((await engine.describe(token))?.details).toContainEqual(["Business", "Bella Cucina"]);

    const done = await engine.confirm(token, "confirm");
    expect(done.ok).toBe(true);
    expect((await engine.status(r.id!))?.status).toBe("done");
    expect(sites.state.bookings.length).toBe(before + 1);
    expect(sites.state.bookings.at(-1)).toMatchObject({ name: "Sam Lee", start: "2026-12-04T19:30:00.000-08:00", via: "calcom" });

    expect((await engine.confirm(token, "confirm")).ok).toBe(false); // links work once
  });

  it("rejects unavailable times before bothering the guest", async () => {
    const { engine, notifier } = engineFor(await calcomActions());
    const r = await engine.call("request_booking", { ...booking, date: "2026-12-07" }, ctx({ idempotencyKey: "k2" }));
    expect(r.status).toBe("rejected");
    expect(notifier.sent).toHaveLength(0);
    const r2 = await engine.call("request_booking", { ...booking, time: "16:00" }, ctx({ idempotencyKey: "k3" }));
    expect(r2.message).toMatch(/Free times: 17:00/);
  });

  it("lets the guest decline", async () => {
    const { engine, notifier } = engineFor(await calcomActions());
    const before = sites.state.bookings.length;
    await engine.call("request_booking", { ...booking, time: "20:00" }, ctx({ idempotencyKey: "k4" }));
    const token = notifier.sent[0]!.link!.split("/confirm/")[1]!;
    const r = await engine.confirm(token, "reject");
    expect(r.result?.status).toBe("rejected");
    expect(sites.state.bookings.length).toBe(before);
  });

  it("expires unconfirmed requests", async () => {
    let now = new Date("2026-11-07T10:00:00Z");
    const { engine, notifier } = engineFor(await calcomActions(), { now: () => now });
    const r = await engine.call("request_booking", { ...booking, time: "20:30" }, ctx({ idempotencyKey: "k5" }));
    now = new Date("2026-11-07T10:16:00Z");
    expect((await engine.status(r.id!))?.status).toBe("expired");
    const token = notifier.sent[0]!.link!.split("/confirm/")[1]!;
    expect(await engine.describe(token)).toBeUndefined();
  });

  it("explains a missing API key", async () => {
    const { engine, notifier } = engineFor(await calcomActions(), { env: {} });
    await engine.call("request_booking", { ...booking, time: "21:00" }, ctx({ idempotencyKey: "k6" }));
    const r = await engine.confirm(notifier.sent[0]!.link!.split("/confirm/")[1]!, "confirm");
    expect(r.result?.status).toBe("failed");
    expect(r.message).toContain("CALCOM_API_KEY");
  });

  it("validates input and enforces per-agent limits", async () => {
    const actions = await calcomActions();
    actions.find((a) => a.name === "check_availability")!.limits = { perAgentPerHour: 1 };
    const { engine } = engineFor(actions);
    const bad = await engine.call("request_booking", { ...booking, party_size: 40, email: "nope" }, ctx({ idempotencyKey: "k7" }));
    expect(bad.errors).toEqual(expect.arrayContaining(["party_size must be at most 12", "email must be an email address"]));
    await engine.call("check_availability", { date: "2026-12-04" }, ctx());
    expect((await engine.call("check_availability", { date: "2026-12-04" }, ctx())).message).toMatch(/Too many/);
  });
});

describe("Shopify", () => {
  it("syncs products and builds checkout links", async () => {
    const { entities, actions } = await shopify.sync!({ store: sites.shop }, { env: {}, fetch, siteUrl: sites.shop });
    expect(entities.map((e) => e.name).sort()).toEqual(["Classic Hoodie", "Everyday Tee", "Merino Beanie", "Relaxed Chinos"]);
    const { engine } = engineFor(actions);

    const link = await engine.call("create_checkout_link", { items: [{ sku: "50012", quantity: 1 }, { sku: "50021", quantity: 2 }] }, ctx());
    expect(link.status).toBe("checkout_link");
    expect(link.checkout_url).toBe(`${sites.shop}/cart/50012:1,50021:2`);
    expect(link.data?.subtotal).toBe("124.00");
    const checkout = await (await fetch(link.checkout_url!)).text();
    expect(checkout).toContain("1 × Classic Hoodie (Blue / M)");

    const oos = await engine.call("create_checkout_link", { items: [{ sku: "50013", quantity: 1 }] }, ctx());
    expect(oos.status).toBe("rejected");
    expect(oos.message).toContain("out of stock");

    const stock = await engine.call("check_stock", { product: "classic hoodie" }, ctx());
    expect(stock.message).toContain("Blue / M");
    expect(stock.message).not.toContain("Blue / L");
  });
});

describe("form bridge", () => {
  it("submits the site's HTML form", async () => {
    const action: ActionDef = {
      name: "request_booking",
      description: "Book",
      kind: "write",
      input: [
        { name: "date", type: "date", description: "", required: true },
        { name: "time", type: "time", description: "", required: true },
        { name: "name", type: "string", description: "", required: true },
        { name: "email", type: "email", description: "", required: true },
      ],
      backend: { type: "form-bridge", operation: "submit", config: { action: `${sites.restaurant}/api/book`, method: "POST" } },
      confirmation: "none",
      limits: {},
      enabled: true,
      source: { via: "heuristic", seen },
    };
    const { engine } = engineFor([action]);
    const r = await engine.call("request_booking", { date: "2026-12-05", time: "18:00", name: "Ana", email: "ana@example.com" }, ctx());
    expect(r.status).toBe("done");
    expect(r.message).toContain("Thank you");
    const full = await engine.call("request_booking", { date: "2026-12-07", time: "18:00", name: "Ana", email: "ana@example.com" }, ctx());
    expect(full.status).toBe("rejected");
  });
});

describe("Stripe and OpenAPI (fake APIs)", () => {
  it("creates a Stripe payment link", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body?.toString() });
      if (String(url).includes("/v1/prices")) return Response.json({ data: [{ id: "price_1", unit_amount: 2500, currency: "usd", product: { id: "prod_1", name: "Gift card", active: true } }] });
      return Response.json({ id: "plink_1", url: "https://buy.stripe.com/test_123" });
    }) as typeof fetch;
    const env = { STRIPE_SECRET_KEY: "rk_test" };
    const { entities, actions } = await stripe.sync!({}, { env, fetch: fakeFetch, siteUrl: "https://shop.test" });
    expect(entities[0]?.data.offers).toMatchObject({ price: "25.00", priceCurrency: "USD", sku: "price_1" });
    const engine = new Engine({ graph: graphWith(actions), connectors: builtinConnectors, store: new MemoryStore(), notifier: new OutboxNotifier(), env, fetch: fakeFetch });
    const r = await engine.call("create_payment_link", { items: [{ sku: "price_1", quantity: 2 }] }, ctx({ idempotencyKey: "p1" }));
    expect(r).toMatchObject({ status: "checkout_link", checkout_url: "https://buy.stripe.com/test_123" });
    expect(decodeURIComponent(calls.at(-1)!.body!)).toContain("line_items[0][quantity]=2");
  });

  it("turns OpenAPI operations into actions", async () => {
    const spec = {
      servers: [{ url: "https://api.salon.test" }],
      paths: {
        "/appointments/{location}": {
          post: {
            operationId: "createAppointment",
            summary: "Book an appointment",
            parameters: [{ name: "location", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" }, service: { type: "string", enum: ["cut", "color"] } } } } } },
          },
        },
      },
    };
    let seenReq: { url: string; auth?: string; body?: string } | undefined;
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      seenReq = { url: String(url), auth: (init?.headers as Record<string, string>)?.authorization, body: init?.body as string };
      return Response.json({ message: "Booked" });
    }) as typeof fetch;
    const { actions } = await openapi.sync!({ spec, operations: ["createAppointment"], auth: { header: "authorization", env: "SALON_TOKEN", prefix: "Bearer " }, confirmation: { createAppointment: "none" } }, { env: {}, fetch: fakeFetch, siteUrl: "https://salon.test" });
    expect(actions[0]).toMatchObject({ name: "create_appointment", kind: "write" });
    expect(actions[0]!.input.find((f) => f.name === "service")).toMatchObject({ type: "enum", enum: ["cut", "color"] });
    const engine = new Engine({ graph: graphWith(actions), connectors: builtinConnectors, store: new MemoryStore(), notifier: new OutboxNotifier(), env: { SALON_TOKEN: "t" }, fetch: fakeFetch });
    const r = await engine.call("create_appointment", { location: "downtown", email: "a@b.co", service: "cut" }, ctx({ idempotencyKey: "o1" }));
    expect(r.status).toBe("done");
    expect(seenReq).toMatchObject({ url: "https://api.salon.test/appointments/downtown", auth: "Bearer t" });
    expect(JSON.parse(seenReq!.body!)).toEqual({ email: "a@b.co", service: "cut" });
  });
});

describe("payment protocol adapters", () => {
  it("delegates payment_protocol actions to the registered adapter", async () => {
    const action: ActionDef = {
      name: "buy_gift_card",
      description: "Buy a gift card",
      kind: "payment",
      input: [{ name: "amount", type: "integer", description: "", required: true, min: 10, max: 500 }],
      backend: { type: "http", operation: "x", config: { paymentAdapter: "testpay" } },
      confirmation: "payment_protocol",
      limits: {},
      enabled: true,
      source: { via: "owner", seen },
    };
    const seenReqs: unknown[] = [];
    const engine = new Engine({
      graph: graphWith([action]),
      connectors: builtinConnectors,
      store: new MemoryStore(),
      notifier: new OutboxNotifier(),
      payments: {
        testpay: {
          id: "testpay",
          describe: () => "Test protocol",
          pay: async (req) => (seenReqs.push(req), req.credential === "tok_ok" ? { status: "done", message: "Paid" } : { status: "rejected", message: "Payment declined" }),
        },
      },
    });
    expect(await engine.call("buy_gift_card", { amount: 50 }, ctx({ paymentCredential: "tok_ok" }))).toMatchObject({ status: "done", final: true });
    expect((await engine.call("buy_gift_card", { amount: 50 }, ctx({ paymentCredential: "bad" }))).status).toBe("rejected");
    expect(seenReqs[0]).toMatchObject({ action: "buy_gift_card", input: { amount: 50 }, agent: "test-agent" });

    const noAdapter = new Engine({ graph: graphWith([action]), connectors: builtinConnectors, store: new MemoryStore(), notifier: new OutboxNotifier() });
    expect((await noAdapter.call("buy_gift_card", { amount: 50 }, ctx())).message).toMatch(/checkout link/);
  });
});

describe("setup helpers", () => {
  it("syncs configured sources", async () => {
    const config = ProjectConfig.parse({ site: sites.shop, sources: [{ type: "shopify", config: { store: sites.shop } }] });
    const r = await syncSources(config, { env: {} });
    expect(r.entities).toHaveLength(4);
    expect(r.actions.map((a) => a.name)).toEqual(["check_stock", "create_checkout_link"]);
  });

  it("parses API keys and masks contacts", () => {
    expect(parseApiKeys("abc:travel-bot, def")).toEqual({ abc: "travel-bot", def: "agent" });
    expect(maskContact("sam@example.com")).toBe("s***@example.com");
    expect(maskContact("+15035550100")).toBe("***0100");
  });
});

describe("end to end through HTTP and MCP", () => {
  it("books a table via REST and the confirmation page", async () => {
    const config = ProjectConfig.parse({ site: sites.restaurant });
    const notifier = new OutboxNotifier();
    const engine = createEngine({ graph: graphWith(await calcomActions()), config, env: { CALCOM_API_KEY: "k" }, notifier });
    const app = createApp({ graph: graphWith(await calcomActions()), engine, baseUrl: "http://agents.test" });
    const before = sites.state.bookings.length;

    const res = await app.fetch(new Request("http://agents.test/api/request_booking", { method: "POST", headers: { "idempotency-key": "e2e-1" }, body: JSON.stringify({ ...booking, time: "18:30" }) }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string };
    const link = notifier.sent[0]!.link!;
    expect(link.startsWith("http://agents.test/confirm/")).toBe(true);

    const pageHtml = await (await app.fetch(new Request(link))).text();
    expect(pageHtml).toContain("Sam Lee");
    const confirmed = await app.fetch(new Request(link, { method: "POST", body: new URLSearchParams({ decision: "confirm" }) }));
    expect(await confirmed.text()).toContain("Booked for 2026-12-04 at 18:30");
    expect(((await (await app.fetch(new Request(`http://agents.test/api/actions/${body.id}`))).json()) as { status: string }).status).toBe("done");
    expect(sites.state.bookings.length).toBe(before + 1);
  });

  it("exposes actions as MCP tools", async () => {
    const config = ProjectConfig.parse({ site: sites.restaurant });
    const graph = graphWith(await calcomActions());
    const engine = createEngine({ graph, config, env: {}, notifier: new OutboxNotifier() });
    const server = await serveNode({ graph, engine, port: 0 });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const { tools } = await client.listTools();
      const req = tools.find((t) => t.name === "request_booking")!;
      expect(req.description).toContain("confirmation: guest");
      expect((req.inputSchema as { required: string[] }).required).toContain("email");
      const r = await client.callTool({ name: "check_availability", arguments: { date: "2026-12-06" } });
      expect((r.content as Array<{ text: string }>)[0]!.text).toContain("12:00");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
