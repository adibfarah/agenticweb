import type { ActionDef, Entity } from "@agenticweb-dev/core";
import { ConnectorError, provenance, type Connector } from "../types.ts";

/**
 * WooCommerce via the public Store API (/wp-json/wc/store/v1). Config: { store: "https://shop.example.com" }
 * Checkout links use WooCommerce's shareable checkout URL, /checkout-link/?products=<id>:<qty>,<id>:<qty>
 * (WooCommerce 10 and later), so one link can hold several products. On older stores set
 * config.checkoutLinks to "add-to-cart", which uses ?add-to-cart=<id>&quantity=<n> (one product per link).
 * Check the Store API version on your site if requests fail.
 */
type WooProduct = {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  short_description?: string;
  description?: string;
  is_in_stock?: boolean;
  prices: { price: string; currency_code: string; currency_minor_unit: number };
  categories?: Array<{ name: string }>;
};

const storeOf = (config: Record<string, unknown>) => {
  if (!config.store) throw new ConnectorError("WooCommerce connector needs a store URL (config.store).");
  return String(config.store).replace(/\/$/, "");
};
const price = (p: WooProduct) => (Number(p.prices.price) / 10 ** (p.prices.currency_minor_unit ?? 2)).toFixed(2);
const strip = (html = "") => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function allProducts(store: string, f: typeof fetch): Promise<WooProduct[]> {
  const out: WooProduct[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await f(`${store}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!res.ok) throw new ConnectorError(`Couldn't read the WooCommerce catalog (HTTP ${res.status}).`);
    const list = (await res.json()) as WooProduct[];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

export const woocommerce: Connector = {
  id: "woocommerce",

  async sync(config, { fetch: f }) {
    const store = storeOf(config);
    const products = await allProducts(store, f);
    const entities: Entity[] = products.map((p) => ({
      id: p.permalink,
      type: "Product",
      name: p.name,
      data: {
        "@type": "Product",
        "@id": p.permalink,
        name: p.name,
        description: strip(p.short_description || p.description),
        url: p.permalink,
        sku: String(p.id),
        ...(p.categories?.[0] ? { category: p.categories[0].name } : {}),
        offers: { "@type": "Offer", sku: String(p.id), price: price(p), priceCurrency: p.prices.currency_code, availability: p.is_in_stock === false ? "https://schema.org/OutOfStock" : "https://schema.org/InStock" },
      },
      hidden: false,
      source: provenance(`${store}/wp-json/wc/store/v1/products`),
    }));
    const actions: ActionDef[] = [
      {
        name: "create_checkout_link",
        description: "Put products in a cart and get a checkout link to hand to the person, who reviews and pays on the store's checkout. Use the SKUs from the product data (offers.sku).",
        kind: "write",
        input: [
          {
            name: "items",
            type: "array",
            description: "Products to buy",
            required: true,
            min: 1,
            max: 20,
            items: [
              { name: "sku", type: "string", description: "Product SKU (offers.sku)", required: true },
              { name: "quantity", type: "integer", description: "Quantity", required: true, min: 1, max: 20 },
            ],
          },
        ],
        backend: { type: "woocommerce", config: { store }, operation: "create_checkout_link" },
        confirmation: "checkout_link",
        limits: { perAgentPerHour: 30 },
        enabled: false,
        source: provenance(store),
      },
    ];
    return { entities, actions };
  },

  async execute(a) {
    if (a.operation !== "create_checkout_link") throw new ConnectorError(`Unknown WooCommerce operation ${a.operation}`);
    const store = storeOf(a.config);
    // Older configs used a single sku and quantity.
    const items = (a.input.items as Array<{ sku: string; quantity: number }> | undefined) ?? [{ sku: String(a.input.sku), quantity: Number(a.input.quantity ?? 1) }];
    const legacy = a.config.checkoutLinks === "add-to-cart";
    if (legacy && items.length > 1) return { status: "rejected", message: "This store's checkout links take one product at a time. Send one item." };

    const found: Array<{ p: WooProduct; quantity: number }> = [];
    for (const i of items) {
      const res = await a.fetch(`${store}/wp-json/wc/store/v1/products/${encodeURIComponent(i.sku)}`);
      if (!res.ok) return { status: "rejected", message: `Unknown product ${i.sku}.` };
      const p = (await res.json()) as WooProduct;
      if (p.is_in_stock === false) return { status: "rejected", message: `${p.name} is out of stock.` };
      found.push({ p, quantity: i.quantity });
    }
    const currency = found[0]!.p.prices.currency_code;
    const subtotal = found.reduce((s, { p, quantity }) => s + Number(price(p)) * quantity, 0).toFixed(2);
    const url = legacy
      ? `${store}/checkout/?add-to-cart=${found[0]!.p.id}&quantity=${found[0]!.quantity}`
      : `${store}/checkout-link/?products=${found.map(({ p, quantity }) => `${p.id}:${quantity}`).join(",")}`;
    return {
      status: "checkout_link",
      message: `Checkout link ready for ${found.map(({ p, quantity }) => `${quantity} × ${p.name}`).join(", ")} (${subtotal} ${currency} before tax and shipping).`,
      checkout_url: url,
      data: { items: found.map(({ p, quantity }) => ({ sku: String(p.id), quantity, title: p.name, price: price(p) })), subtotal, currency },
    };
  },
};
