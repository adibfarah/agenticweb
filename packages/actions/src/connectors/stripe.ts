import type { ActionDef, Entity } from "@agenticweb-dev/core";
import { ConnectorError, provenance, secret, type Connector } from "../types.ts";

/**
 * Stripe Payment Links. Config: { apiKeyEnv?: "STRIPE_SECRET_KEY", apiBase?: "https://api.stripe.com" }
 * sync() lists active prices as Products; create_payment_link returns a Stripe-hosted payment page.
 * AgenticWeb never sees card details: the person pays on Stripe.
 * Use a restricted key with only Prices (read) and Payment Links (write) permissions.
 */
const apiBase = (c: Record<string, unknown>) => String(c.apiBase ?? "https://api.stripe.com").replace(/\/$/, "");

type StripePrice = { id: string; unit_amount: number | null; currency: string; product: { id: string; name: string; description?: string | null; active: boolean } | string };

export const stripe: Connector = {
  id: "stripe",

  async sync(config, { env, fetch: f, siteUrl }) {
    const key = secret(env, config.apiKeyEnv ?? "STRIPE_SECRET_KEY", "Stripe");
    const res = await f(`${apiBase(config)}/v1/prices?active=true&limit=100&expand[]=data.product`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new ConnectorError(`Couldn't list Stripe prices (HTTP ${res.status}).`);
    const { data } = (await res.json()) as { data: StripePrice[] };
    const entities: Entity[] = data
      .filter((p) => typeof p.product === "object" && p.product.active && p.unit_amount != null)
      .map((p) => {
        const prod = p.product as Exclude<StripePrice["product"], string>;
        const id = `${siteUrl.replace(/\/$/, "")}/#stripe-${p.id}`;
        return {
          id,
          type: "Product",
          name: prod.name,
          data: {
            "@type": "Product",
            "@id": id,
            name: prod.name,
            ...(prod.description ? { description: prod.description } : {}),
            offers: { "@type": "Offer", sku: p.id, price: (p.unit_amount! / 100).toFixed(2), priceCurrency: p.currency.toUpperCase() },
          },
          hidden: false,
          source: provenance("stripe:prices"),
        };
      });
    const actions: ActionDef[] = [
      {
        name: "create_payment_link",
        description: "Create a Stripe payment page for one or more products to hand to the person, who pays there.",
        kind: "payment",
        input: [
          {
            name: "items",
            type: "array",
            description: "Items to buy",
            required: true,
            min: 1,
            max: 20,
            items: [
              { name: "sku", type: "string", description: "Price id (offers.sku)", required: true },
              { name: "quantity", type: "integer", description: "Quantity", required: true, min: 1, max: 99 },
            ],
          },
        ],
        backend: { type: "stripe", config: { apiKeyEnv: config.apiKeyEnv ?? "STRIPE_SECRET_KEY", ...(config.apiBase ? { apiBase: config.apiBase } : {}) }, operation: "create_payment_link" },
        confirmation: "checkout_link",
        idempotency: "required",
        limits: { perAgentPerHour: 20 },
        enabled: false,
        source: provenance("stripe"),
      },
    ];
    return { entities, actions };
  },

  async execute(a) {
    if (a.operation !== "create_payment_link") throw new ConnectorError(`Unknown Stripe operation ${a.operation}`);
    const key = secret(a.env, a.config.apiKeyEnv ?? "STRIPE_SECRET_KEY", "Stripe");
    const items = a.input.items as Array<{ sku: string; quantity: number }>;
    const body = new URLSearchParams();
    items.forEach((i, n) => {
      body.set(`line_items[${n}][price]`, i.sku);
      body.set(`line_items[${n}][quantity]`, String(i.quantity));
    });
    body.set("metadata[source]", "agenticweb");
    const res = await a.fetch(`${apiBase(a.config)}/v1/payment_links`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body });
    const json = (await res.json().catch(() => ({}))) as { url?: string; id?: string; error?: { message?: string } };
    if (!res.ok || !json.url) return { status: "failed", message: `Stripe said: ${json.error?.message ?? `HTTP ${res.status}`}` };
    return { status: "checkout_link", message: "Payment page ready. The person pays on Stripe.", checkout_url: json.url, data: { payment_link_id: json.id } };
  },
};
