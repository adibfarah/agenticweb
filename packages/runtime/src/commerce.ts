import type { Context, Hono } from "hono";
import { publicView, type ActionDef, type SiteGraph } from "@agenticweb-dev/core";
import type { ActionEngine, ActionResult, CallContext } from "./engine.ts";

/**
 * Agent checkout protocols on top of the action engine, for any store (Shopify, WooCommerce, Stripe, custom).
 *
 * - UCP, Universal Commerce Protocol (https://ucp.dev, checkout REST binding, version 2026-08-25):
 *   profile at /.well-known/ucp, sessions at /ucp/v1/checkout-sessions.
 *   Without agent payments the session ends in `requires_escalation` with a `continue_url`: the store's own
 *   checkout, pre-filled, where the buyer reviews and pays (the spec's handoff).
 * - ACP, Agentic Commerce Protocol (https://developers.openai.com/commerce/specs/checkout):
 *   sessions at /acp/checkout_sessions. ACP always ends in a payment, so it is only offered when the owner
 *   has set up an agent-payment adapter (an action with confirmation "payment_protocol").
 *
 * Prices come from the Site Graph (connector data wins over crawled data). Tax and shipping are not known
 * here: sessions say so, and the store's checkout or the payment adapter works out the final amount.
 * AgenticWeb never sees card data; payment tokens go straight to the owner's payment adapter.
 */

export const UCP_VERSION = "2026-08-25";
const UCP_CHECKOUT = "dev.ucp.shopping.checkout";

/** The part of a key-value store sessions need (Cloudflare KV fits). */
export interface SessionKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export class MemoryKv implements SessionKv {
  private m = new Map<string, { v: string; until: number }>();
  async get(key: string) {
    const hit = this.m.get(key);
    if (!hit) return null;
    if (hit.until < Date.now()) {
      this.m.delete(key);
      return null;
    }
    return hit.v;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }) {
    this.m.set(key, { v: value, until: Date.now() + (opts?.expirationTtl ?? 3600) * 1000 });
  }
}

export type CommerceOptions = {
  ucp?: boolean;
  acp?: boolean;
  /** ACP payment_provider.provider: the provider whose delegated tokens your payment adapter accepts. */
  acpProvider?: string;
  /** Minutes a checkout session lives. Default 60. */
  sessionMinutes?: number;
  /** UCP: fetch and check the platform profile named in the UCP-Agent header (the spec requires it). Default true. */
  verifyAgentProfiles?: boolean;
  /** UCP payment_handlers published in /.well-known/ucp (your payment adapter's handlers). Default none. */
  paymentHandlers?: Record<string, unknown>;
  store?: SessionKv;
  fetch?: typeof fetch;
};

type Product = { sku: string; title: string; unit: number; currency: string; inStock: boolean; url?: string };
type Line = { id: string; sku: string; quantity: number };
type Msg = { type: "error" | "warning" | "info"; code?: string; path?: string; content: string; severity?: string };
type Session = {
  id: string;
  protocol: "ucp" | "acp";
  status: string;
  currency: string;
  lines: Line[];
  buyer?: Record<string, unknown>;
  fulfillmentAddress?: Record<string, unknown>;
  messages: Msg[];
  continueUrl?: string;
  order?: { id: string; permalink_url?: string };
  agent: string;
  createdAt: string;
  expiresAt: string;
};

/** Products agents can buy: every public Product offer with a SKU and a price. */
export function buildCatalog(g: SiteGraph): Map<string, Product> {
  const out = new Map<string, Product>();
  for (const e of publicView(g).entities) {
    if (e.type !== "Product") continue;
    const offers = ([] as Array<Record<string, unknown>>).concat((e.data.offers as never) ?? []);
    for (const o of offers) {
      const sku = o.sku ?? (offers.length === 1 ? e.data.sku : undefined);
      if (sku === undefined || o.price === undefined || !o.priceCurrency) continue;
      const currency = String(o.priceCurrency).toUpperCase();
      const variant = o.name && offers.length > 1 ? ` (${String(o.name)})` : "";
      out.set(String(sku), {
        sku: String(sku),
        title: `${e.name}${variant}`,
        unit: toMinor(String(o.price), currency),
        currency,
        inStock: !/OutOfStock|SoldOut|Discontinued/i.test(String(o.availability ?? "")),
        url: (e.data.url as string | undefined) ?? undefined,
      });
    }
  }
  return out;
}

/** "19.99" USD → 1999; "500" JPY → 500. */
export function toMinor(price: string, currency: string): number {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Unknown currency code: assume cents.
  }
  return Math.round(Number(price) * 10 ** digits);
}

const hasField = (a: ActionDef, name: string) => a.input.some((f) => f.name === name);
const enabledActions = (engine: ActionEngine) => engine.actions().filter((a) => a.enabled !== false);
/** The action that turns items into a checkout link on the store (Shopify, WooCommerce, Stripe…). */
export const checkoutActionOf = (engine?: ActionEngine) => engine && enabledActions(engine).find((a) => a.confirmation === "checkout_link" && (hasField(a, "items") || hasField(a, "sku")));
/** The action that takes payment through an agent-payment adapter. */
export const paymentActionOf = (engine?: ActionEngine) => engine && enabledActions(engine).find((a) => a.confirmation === "payment_protocol" && hasField(a, "items"));

function actionInput(a: ActionDef, lines: Line[], buyer?: Record<string, unknown>): Record<string, unknown> | undefined {
  const items = lines.map((l) => ({ sku: l.sku, quantity: l.quantity }));
  if (hasField(a, "items")) return { items, ...(buyer && hasField(a, "buyer") ? { buyer } : {}) };
  if (lines.length === 1) return { sku: lines[0]!.sku, quantity: lines[0]!.quantity };
  return undefined;
}

type Deps = { graph: SiteGraph; engine?: ActionEngine; ctxOf: (c: Context) => CallContext; baseUrl?: string };

/** Adds UCP and ACP routes to the runtime when the site has a way to check out. Returns what was enabled. */
export function mountCommerce(app: Hono, d: Deps, opts: CommerceOptions = {}): { ucp: boolean; acp: boolean } {
  const checkout = checkoutActionOf(d.engine);
  const payment = paymentActionOf(d.engine);
  const ucpOn = opts.ucp !== false && Boolean(checkout || payment);
  const acpOn = opts.acp !== false && Boolean(payment);
  if (!ucpOn && !acpOn) return { ucp: false, acp: false };

  const catalog = buildCatalog(d.graph);
  const kv = opts.store ?? new MemoryKv();
  const ttl = (opts.sessionMinutes ?? 60) * 60;
  const f = opts.fetch ?? fetch;
  const policies = d.graph.policies;
  const base = (c: Context) => (d.baseUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");

  const load = async (id: string) => {
    const raw = await kv.get(`co:${id}`);
    return raw ? (JSON.parse(raw) as Session) : undefined;
  };
  const save = (s: Session) => kv.put(`co:${s.id}`, JSON.stringify(s), { expirationTtl: ttl });

  /** Checks the cart against the catalog. Returns problems as protocol messages. */
  const validate = (lines: Line[]): { messages: Msg[]; currency: string } => {
    const messages: Msg[] = [];
    let currency = "";
    if (!lines.length) messages.push({ type: "error", code: "missing", path: "$.line_items", content: "Add at least one item.", severity: "recoverable" });
    lines.forEach((l, i) => {
      const p = catalog.get(l.sku);
      if (!p) return messages.push({ type: "error", code: "item_unavailable", path: `$.line_items[${i}].item.id`, content: `Unknown item "${l.sku}". Item ids are the offers' sku values in the site's product data.`, severity: "recoverable" });
      if (!p.inStock) messages.push({ type: "error", code: "out_of_stock", path: `$.line_items[${i}]`, content: `${p.title} is out of stock.`, severity: "recoverable" });
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 100) messages.push({ type: "error", code: "invalid", path: `$.line_items[${i}].quantity`, content: "Quantity must be a whole number from 1 to 100.", severity: "recoverable" });
      if (currency && p.currency !== currency) messages.push({ type: "error", code: "invalid", path: `$.line_items[${i}]`, content: "All items must be in the same currency.", severity: "recoverable" });
      currency ||= p.currency;
    });
    return { messages, currency: currency || "USD" };
  };

  /** Works out the session's status: what's missing, and whether it can be paid here or must hand off. */
  const evaluate = async (s: Session, c: Context) => {
    const { messages, currency } = validate(s.lines);
    s.currency = currency;
    s.messages = messages;
    s.continueUrl = undefined;
    if (messages.some((m) => m.type === "error")) {
      s.status = s.protocol === "ucp" ? "incomplete" : "not_ready_for_payment";
      return;
    }
    s.messages.push({ type: "warning", code: "totals_estimated", path: "$.totals", content: "Totals are item prices only. Tax and shipping are added at payment." });
    if (payment) {
      s.status = s.protocol === "ucp" ? "ready_for_complete" : "ready_for_payment";
      return;
    }
    // UCP handoff: the store's own checkout, pre-filled with these items.
    const input = checkout && actionInput(checkout, s.lines);
    if (!checkout || !input) {
      s.status = "incomplete";
      s.messages.push({ type: "error", code: "invalid", path: "$.line_items", content: "This store's checkout links take one item at a time. Remove items until one is left.", severity: "recoverable" });
      return;
    }
    const r = await d.engine!.call(checkout.name, input, { ...d.ctxOf(c), idempotencyKey: `${s.id}:${JSON.stringify(input)}` });
    if (r.checkout_url) {
      s.status = "requires_escalation";
      s.continueUrl = r.checkout_url;
      s.messages.push({ type: "error", code: "payment_required", content: "The buyer reviews the order and pays on the store's own checkout at continue_url.", severity: "requires_buyer_review" });
    } else {
      s.status = "incomplete";
      s.messages.push({ type: "error", code: "invalid", content: r.message || "The store couldn't prepare a checkout for these items.", severity: "recoverable" });
    }
  };

  const totalOf = (s: Session) => s.lines.reduce((sum, l) => sum + (catalog.get(l.sku)?.unit ?? 0) * l.quantity, 0);
  const links = () =>
    [
      policies.terms ? { type: "terms_of_service", url: policies.terms } : undefined,
    ].filter(Boolean) as Array<{ type: string; url: string }>;

  /** Pays through the owner's payment adapter. */
  const pay = async (s: Session, c: Context, credential: string, buyer?: Record<string, unknown>): Promise<ActionResult> => {
    const input = actionInput(payment!, s.lines, buyer ?? s.buyer)!;
    // One engine attempt per payment attempt: a retry after a decline (new token) must not replay the decline.
    // The token itself is never stored, only a hash of it.
    const attempt = c.req.header("idempotency-key") ?? fnv1a(credential);
    return d.engine!.call(payment!.name, input, { ...d.ctxOf(c), paymentCredential: credential, idempotencyKey: `${s.id}:complete:${attempt}` });
  };

  /** Replays the first response for a repeated Idempotency-Key; refuses a reused key with a different body. */
  const idempotent = async (c: Context, scope: string, body: unknown, run: () => Promise<{ status: number; body: unknown }>, conflict: () => unknown) => {
    const key = c.req.header("idempotency-key");
    if (!key) {
      const r = await run();
      return c.json(r.body as object, r.status as never);
    }
    const slot = `idem:${scope}:${d.ctxOf(c).agent}:${key}`;
    const hash = `${c.req.method} ${new URL(c.req.url).pathname} ${JSON.stringify(body ?? null)}`;
    const prev = await kv.get(slot);
    if (prev) {
      const p = JSON.parse(prev) as { hash: string; status: number; body: unknown };
      if (p.hash !== hash) return c.json(conflict() as object, 409);
      return c.json(p.body as object, p.status as never);
    }
    const r = await run();
    if (r.status < 500) await kv.put(slot, JSON.stringify({ hash, ...r }), { expirationTtl: 24 * 3600 });
    return c.json(r.body as object, r.status as never);
  };

  const newSession = (protocol: Session["protocol"], agent: string): Session => {
    const now = new Date();
    return { id: `chk_${randomId()}`, protocol, status: "incomplete", currency: "USD", lines: [], messages: [], agent, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
  };

  if (ucpOn) mountUcp();
  if (acpOn) mountAcp();
  return { ucp: ucpOn, acp: acpOn };

  // ---------------------------------------------------------------- UCP
  function mountUcp() {
    const profiles = new Map<string, { ok: boolean; at: number }>();
    const ucpError = (code: string, content: string) => ({ ucp: { version: UCP_VERSION, status: "error" }, code, content });

    /** The spec requires the business to fetch and check the platform profile named in UCP-Agent. */
    const checkAgent = async (c: Context): Promise<Response | undefined> => {
      const header = c.req.header("ucp-agent");
      const uri = header?.match(/profile="([^"]+)"/)?.[1];
      if (!uri) return c.json(ucpError("missing_ucp_agent", 'Send a UCP-Agent header: profile="https://your-platform/profile"'), 400);
      if (opts.verifyAgentProfiles === false) return undefined;
      const cached = profiles.get(uri);
      if (cached && Date.now() - cached.at < 10 * 60_000) return cached.ok ? undefined : c.json(ucpError("invalid_profile", "The platform profile isn't a UCP profile."), 422);
      if (!isPublicHttps(uri)) return c.json(ucpError("invalid_profile", "The platform profile must be a public https URL."), 422);
      try {
        const res = await f(uri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
        if (!res.ok) return c.json(ucpError("profile_unreachable", `Couldn't fetch the platform profile (HTTP ${res.status}).`), 424);
        const profile = (await res.json()) as { ucp?: { version?: string } };
        const ok = typeof profile.ucp?.version === "string";
        profiles.set(uri, { ok, at: Date.now() });
        return ok ? undefined : c.json(ucpError("invalid_profile", "The platform profile has no ucp.version."), 422);
      } catch {
        return c.json(ucpError("profile_unreachable", "Couldn't fetch the platform profile."), 424);
      }
    };

    const view = (s: Session) => ({
      ucp: { version: UCP_VERSION, capabilities: { [UCP_CHECKOUT]: [{ version: UCP_VERSION }] }, payment_handlers: opts.paymentHandlers ?? {} },
      id: s.id,
      status: s.status,
      currency: s.currency,
      line_items: s.lines.map((l) => {
        const p = catalog.get(l.sku);
        const amount = (p?.unit ?? 0) * l.quantity;
        return { id: l.id, item: { id: l.sku, title: p?.title ?? l.sku, price: p?.unit ?? 0 }, quantity: l.quantity, totals: [{ type: "subtotal", amount }, { type: "total", amount }] };
      }),
      totals: [{ type: "subtotal", amount: totalOf(s) }, { type: "total", amount: totalOf(s) }],
      messages: s.messages,
      links: links(),
      ...(s.buyer ? { buyer: s.buyer } : {}),
      ...(s.continueUrl && s.status !== "completed" && s.status !== "canceled" ? { continue_url: s.continueUrl } : {}),
      ...(s.order ? { order: s.order } : {}),
      expires_at: s.expiresAt,
    });
    const linesFrom = (body: { line_items?: Array<{ id?: string; item?: { id?: string }; quantity?: number }> }): Line[] =>
      (body.line_items ?? []).map((li, i) => ({ id: li.id ?? `li_${i + 1}`, sku: String(li.item?.id ?? ""), quantity: Number(li.quantity ?? 1) }));
    const body = async (c: Context) => (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const found = async (c: Context) => {
      const s = await load(c.req.param("id")!);
      return s && s.protocol === "ucp" ? s : undefined;
    };

    app.get("/.well-known/ucp", (c) =>
      c.json({
        ucp: {
          version: UCP_VERSION,
          services: { "dev.ucp.shopping": [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/overview/", transport: "rest", endpoint: `${base(c)}/ucp/v1`, schema: `${base(c)}/ucp/v1/openapi.json` }] },
          capabilities: { [UCP_CHECKOUT]: [{ version: UCP_VERSION, spec: "https://ucp.dev/specification/shopping/checkout/", schema: `${base(c)}/ucp/v1/openapi.json` }] },
          payment_handlers: opts.paymentHandlers ?? {},
        },
      }),
    );
    app.get("/ucp/v1/openapi.json", (c) => c.json(ucpOpenApi(base(c))));

    app.post("/ucp/v1/checkout-sessions", async (c) => {
      const bad = await checkAgent(c);
      if (bad) return bad;
      const b = await body(c);
      if (!b) return c.json(ucpError("invalid_request", "Send the checkout as a JSON body."), 400);
      return idempotent(c, "ucp", b, async () => {
        const s = newSession("ucp", d.ctxOf(c).agent);
        s.lines = linesFrom(b);
        if (b.buyer && typeof b.buyer === "object") s.buyer = b.buyer as Record<string, unknown>;
        await evaluate(s, c);
        await save(s);
        return { status: 201, body: view(s) };
      }, () => ucpError("idempotency_conflict", "This Idempotency-Key was used with a different request."));
    });
    app.get("/ucp/v1/checkout-sessions/:id", async (c) => {
      const bad = await checkAgent(c);
      if (bad) return bad;
      const s = await found(c);
      return s ? c.json(view(s)) : c.json(ucpError("not_found", "No checkout session with that id (it may have expired)."), 404);
    });
    app.put("/ucp/v1/checkout-sessions/:id", async (c) => {
      const bad = await checkAgent(c);
      if (bad) return bad;
      const s = await found(c);
      if (!s) return c.json(ucpError("not_found", "No checkout session with that id (it may have expired)."), 404);
      if (s.status === "completed" || s.status === "canceled" || s.status === "complete_in_progress") return c.json(ucpError("invalid_state", `The checkout is ${s.status}.`), 409);
      const b = await body(c);
      if (!b) return c.json(ucpError("invalid_request", "Send the checkout as a JSON body."), 400);
      return idempotent(c, "ucp", b, async () => {
        // Update is a full replacement.
        s.lines = linesFrom(b);
        s.buyer = b.buyer && typeof b.buyer === "object" ? (b.buyer as Record<string, unknown>) : undefined;
        await evaluate(s, c);
        await save(s);
        return { status: 200, body: view(s) };
      }, () => ucpError("idempotency_conflict", "This Idempotency-Key was used with a different request."));
    });
    app.post("/ucp/v1/checkout-sessions/:id/complete", async (c) => {
      const bad = await checkAgent(c);
      if (bad) return bad;
      const s = await found(c);
      if (!s) return c.json(ucpError("not_found", "No checkout session with that id (it may have expired)."), 404);
      const b = (await body(c)) ?? {};
      return idempotent(c, "ucp", b, async () => {
        if (s.status === "completed") return { status: 200, body: view(s) };
        if (s.status === "canceled") return { status: 409, body: ucpError("invalid_state", "The checkout was canceled.") };
        await evaluate(s, c);
        if (s.status !== "ready_for_complete") {
          await save(s);
          return { status: 200, body: view(s) }; // incomplete, or requires_escalation with continue_url
        }
        const instruments = ((b.payment as { instruments?: Array<Record<string, unknown>> } | undefined)?.instruments ?? []) as Array<Record<string, unknown>>;
        const chosen = instruments.find((i) => i.selected) ?? instruments[0];
        if (!chosen) {
          s.messages.push({ type: "error", code: "payment_required", path: "$.payment.instruments", content: "Complete Checkout needs a payment instrument.", severity: "recoverable" });
          return { status: 200, body: view(s) };
        }
        const r = await pay(s, c, JSON.stringify(chosen), b.buyer as Record<string, unknown> | undefined);
        applyPayment(s, r);
        await save(s);
        return { status: 200, body: view(s) };
      }, () => ucpError("idempotency_conflict", "This Idempotency-Key was used with a different request."));
    });
    app.post("/ucp/v1/checkout-sessions/:id/cancel", async (c) => {
      const bad = await checkAgent(c);
      if (bad) return bad;
      const s = await found(c);
      if (!s) return c.json(ucpError("not_found", "No checkout session with that id (it may have expired)."), 404);
      if (s.status === "completed") return c.json(ucpError("invalid_state", "The order was already placed."), 409);
      s.status = "canceled";
      s.messages = [];
      await save(s);
      return c.json(view(s));
    });

    function applyPayment(s: Session, r: ActionResult) {
      if (r.status === "done") {
        s.status = "completed";
        s.messages = [];
        s.order = { id: String(r.data?.order_id ?? r.id ?? s.id), ...(r.data?.order_url ? { permalink_url: String(r.data.order_url) } : {}) };
      } else if (r.status === "checkout_link" && r.checkout_url) {
        s.status = "requires_escalation";
        s.continueUrl = r.checkout_url;
        s.messages = [{ type: "error", code: "payment_required", content: r.message, severity: "requires_buyer_review" }];
      } else if (r.status === "pending_confirmation" || r.status === "pending_owner") {
        s.status = "complete_in_progress";
        s.messages = [{ type: "info", content: r.message }];
      } else {
        s.messages = [{ type: "error", code: "payment_failed", path: "$.payment", content: r.message, severity: "recoverable" }];
      }
    }
  }

  // ---------------------------------------------------------------- ACP
  function mountAcp() {
    const acpError = (code: string, message: string, param?: string) => ({ type: "invalid_request", code, message, ...(param ? { param } : {}) });
    const authed = (c: Context) => {
      // ACP is server-to-server with an API key you issue to the agent platform (AGENTICWEB_API_KEYS).
      return d.ctxOf(c).agentFromKey === true;
    };
    const view = (s: Session) => {
      const subtotal = totalOf(s);
      return {
        id: s.id,
        ...(s.buyer ? { buyer: s.buyer } : {}),
        payment_provider: { provider: opts.acpProvider ?? "stripe", supported_payment_methods: ["card"] },
        status: s.status,
        currency: s.currency.toLowerCase(),
        line_items: s.lines.map((l) => {
          const amount = (catalog.get(l.sku)?.unit ?? 0) * l.quantity;
          return { id: l.id, item: { id: l.sku, quantity: l.quantity }, base_amount: amount, discount: 0, subtotal: amount, tax: 0, total: amount };
        }),
        ...(s.fulfillmentAddress ? { fulfillment_address: s.fulfillmentAddress } : {}),
        fulfillment_options: [],
        totals: [
          { type: "items_base_amount", display_text: "Item(s) total", amount: subtotal },
          { type: "subtotal", display_text: "Subtotal", amount: subtotal },
          { type: "total", display_text: "Total", amount: subtotal },
        ],
        messages: s.messages.map((m) =>
          m.type === "error"
            ? { type: "error", code: acpCode(m.code), param: m.path, content_type: "plain", content: m.content }
            : { type: "info", param: m.path ?? "$", content_type: "plain", content: m.content },
        ),
        links: links().map((l) => ({ type: l.type === "terms_of_service" ? "terms_of_use" : l.type, url: l.url })),
        ...(s.order ? { order: { id: s.order.id, checkout_session_id: s.id, permalink_url: s.order.permalink_url ?? "" } } : {}),
      };
    };
    const linesFrom = (items: unknown): Line[] =>
      ((items as Array<{ id?: string; quantity?: number }> | undefined) ?? []).map((it, i) => ({ id: `li_${i + 1}`, sku: String(it.id ?? ""), quantity: Number(it.quantity ?? 1) }));
    const body = async (c: Context) => ((await c.req.json().catch(() => undefined)) ?? undefined) as Record<string, unknown> | undefined;
    const found = async (c: Context) => {
      const s = await load(c.req.param("id")!);
      return s && s.protocol === "acp" ? s : undefined;
    };
    const guard = (c: Context) => (authed(c) ? undefined : c.json(acpError("unauthorized", "Send Authorization: Bearer <API key issued by this store>."), 401));
    const conflict = () => acpError("request_not_idempotent", "This Idempotency-Key was used with a different request.");

    app.post("/acp/checkout_sessions", async (c) => {
      const no = guard(c);
      if (no) return no;
      const b = await body(c);
      if (!b || !Array.isArray(b.items) || !b.items.length) return c.json(acpError("invalid", "items must be a non-empty list.", "$.items"), 400);
      return idempotent(c, "acp", b, async () => {
        const s = newSession("acp", d.ctxOf(c).agent);
        s.lines = linesFrom(b.items);
        if (b.buyer && typeof b.buyer === "object") s.buyer = b.buyer as Record<string, unknown>;
        if (b.fulfillment_address && typeof b.fulfillment_address === "object") s.fulfillmentAddress = b.fulfillment_address as Record<string, unknown>;
        await evaluate(s, c);
        await save(s);
        return { status: 201, body: view(s) };
      }, conflict);
    });
    app.get("/acp/checkout_sessions/:id", async (c) => {
      const no = guard(c);
      if (no) return no;
      const s = await found(c);
      return s ? c.json(view(s)) : c.json(acpError("not_found", "No checkout session with that id."), 404);
    });
    app.post("/acp/checkout_sessions/:id", async (c) => {
      const no = guard(c);
      if (no) return no;
      const s = await found(c);
      if (!s) return c.json(acpError("not_found", "No checkout session with that id."), 404);
      if (s.status === "completed" || s.status === "canceled") return c.json(acpError("invalid", `The checkout session is ${s.status}.`), 405);
      const b = (await body(c)) ?? {};
      return idempotent(c, "acp", b, async () => {
        // Update changes only the fields sent.
        if (Array.isArray(b.items)) s.lines = linesFrom(b.items);
        if (b.buyer && typeof b.buyer === "object") s.buyer = b.buyer as Record<string, unknown>;
        if (b.fulfillment_address && typeof b.fulfillment_address === "object") s.fulfillmentAddress = b.fulfillment_address as Record<string, unknown>;
        await evaluate(s, c);
        await save(s);
        return { status: 200, body: view(s) };
      }, conflict);
    });
    app.post("/acp/checkout_sessions/:id/complete", async (c) => {
      const no = guard(c);
      if (no) return no;
      const s = await found(c);
      if (!s) return c.json(acpError("not_found", "No checkout session with that id."), 404);
      const b = (await body(c)) ?? {};
      const pd = b.payment_data as { token?: string; provider?: string } | undefined;
      if (!pd?.token) return c.json(acpError("invalid", "payment_data.token is required.", "$.payment_data.token"), 400);
      return idempotent(c, "acp", b, async () => {
        if (s.status === "completed") return { status: 200, body: view(s) };
        if (s.status === "canceled") return { status: 405, body: acpError("invalid", "The checkout session was canceled.") };
        await evaluate(s, c);
        if (s.status !== "ready_for_payment") {
          await save(s);
          return { status: 200, body: view(s) };
        }
        const r = await pay(s, c, pd.token!, b.buyer as Record<string, unknown> | undefined);
        if (r.status === "done") {
          s.status = "completed";
          s.messages = [];
          s.order = { id: String(r.data?.order_id ?? r.id ?? s.id), ...(r.data?.order_url ? { permalink_url: String(r.data.order_url) } : {}) };
        } else {
          s.messages = [{ type: "error", code: "payment_declined", path: "$.payment_data", content: r.message }];
        }
        await save(s);
        return { status: 200, body: view(s) };
      }, conflict);
    });
    app.post("/acp/checkout_sessions/:id/cancel", async (c) => {
      const no = guard(c);
      if (no) return no;
      const s = await found(c);
      if (!s) return c.json(acpError("not_found", "No checkout session with that id."), 404);
      if (s.status === "completed" || s.status === "canceled") return c.json(acpError("invalid", `The checkout session is already ${s.status}.`), 405);
      s.status = "canceled";
      s.messages = [];
      await save(s);
      return c.json(view(s));
    });
  }
}

/** ACP has a short list of error codes; map ours onto it. */
function acpCode(code?: string): string {
  if (code === "out_of_stock" || code === "missing" || code === "payment_declined") return code;
  if (code === "payment_failed") return "payment_declined";
  return "invalid";
}

/** Only public https addresses: never fetch internal hosts named in a request header. */
export function isPublicHttps(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return false; // IP literals
  return true;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function ucpOpenApi(base: string) {
  const ref = { $ref: "#/components/schemas/Checkout" };
  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const op = (summary: string, withBody: boolean) => ({
    summary,
    parameters: [{ name: "UCP-Agent", in: "header", required: true, schema: { type: "string" } }, { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
    ...(withBody ? { requestBody: { required: true, ...json(ref) } } : {}),
    responses: { "200": { description: "Checkout", ...json(ref) }, "201": { description: "Created", ...json(ref) } },
  });
  return {
    openapi: "3.1.0",
    info: { title: "UCP checkout (AgenticWeb)", version: UCP_VERSION, description: "UCP checkout REST binding. See https://ucp.dev/specification/shopping/checkout/rest/" },
    servers: [{ url: `${base}/ucp/v1` }],
    paths: {
      "/checkout-sessions": { post: op("Create checkout", true) },
      "/checkout-sessions/{id}": { get: op("Get checkout", false), put: op("Update checkout (full replacement)", true) },
      "/checkout-sessions/{id}/complete": { post: op("Complete checkout", true) },
      "/checkout-sessions/{id}/cancel": { post: op("Cancel checkout", false) },
    },
    components: {
      schemas: {
        Checkout: {
          type: "object",
          properties: {
            line_items: { type: "array", items: { type: "object", properties: { item: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, quantity: { type: "integer", minimum: 1 } } } },
            buyer: { type: "object" },
            payment: { type: "object" },
          },
        },
      },
    },
  };
}
