import type { ActionDef, Entity } from "@agenticweb-dev/core";
import { ConnectorError, provenance, type Connector, type ExecuteArgs } from "../types.ts";

/**
 * Shopify storefront. Config: { store: "https://your-store.myshopify.com" (or your custom domain), currency?: "USD" }
 * Reads the public catalog (/products.json) and builds cart permalinks (/cart/<variant>:<qty>,...) that open checkout.
 * No API key needed. The person still pays on Shopify's own checkout.
 */
type ShopifyVariant = { id: number; title: string; price: string; available: boolean; sku?: string; option1?: string; option2?: string; option3?: string };
type ShopifyProduct = { id: number; title: string; handle: string; body_html?: string; product_type?: string; vendor?: string; variants: ShopifyVariant[]; options?: Array<{ name: string }> };

const storeOf = (config: Record<string, unknown>) => {
  if (!config.store) throw new ConnectorError("Shopify connector needs a store URL (config.store).");
  return String(config.store).replace(/\/$/, "");
};

async function allProducts(store: string, f: typeof fetch): Promise<ShopifyProduct[]> {
  const out: ShopifyProduct[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await f(`${store}/products.json?limit=250&page=${page}`);
    if (!res.ok) throw new ConnectorError(`Couldn't read the Shopify catalog (HTTP ${res.status}).`);
    const { products } = (await res.json()) as { products: ShopifyProduct[] };
    out.push(...products);
    if (products.length < 250) break;
  }
  return out;
}

const strip = (html = "") => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const shopify: Connector = {
  id: "shopify",

  async sync(config, { fetch: f }) {
    const store = storeOf(config);
    const currency = String(config.currency ?? "USD");
    const products = await allProducts(store, f);
    const entities: Entity[] = products.map((p) => {
      const id = `${store}/products/${p.handle}`;
      return {
        id,
        type: "Product",
        name: p.title,
        data: {
          "@type": "Product",
          "@id": id,
          name: p.title,
          description: strip(p.body_html),
          url: id,
          sku: String(p.id),
          ...(p.product_type ? { category: p.product_type } : {}),
          ...(p.vendor ? { brand: { "@type": "Brand", name: p.vendor } } : {}),
          offers: p.variants.map((v) => ({
            "@type": "Offer",
            sku: String(v.id),
            name: v.title,
            price: v.price,
            priceCurrency: currency,
            availability: v.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          })),
        },
        hidden: false,
        source: provenance(`${store}/products.json`),
      };
    });
    const backend = { type: "shopify", config: { store, currency } };
    const actions: ActionDef[] = [
      {
        name: "check_stock",
        description: "Check price and stock for a product's variants (sizes, colours). Use the product name or handle.",
        kind: "read",
        input: [{ name: "product", type: "string", description: "Product name or handle", required: true }],
        backend: { ...backend, operation: "check_stock" },
        confirmation: "none",
        limits: { perAgentPerHour: 120 },
        enabled: false,
        source: provenance(store),
      },
      {
        name: "create_checkout_link",
        description: "Put items in a cart and get a checkout link to hand to the person, who reviews and pays on the store's checkout. Use variant SKUs from the product data (offers[].sku).",
        kind: "write",
        input: [
          {
            name: "items",
            type: "array",
            description: "Items to buy",
            required: true,
            min: 1,
            max: 20,
            items: [
              { name: "sku", type: "string", description: "Variant SKU (offers[].sku)", required: true },
              { name: "quantity", type: "integer", description: "Quantity", required: true, min: 1, max: 10 },
            ],
          },
        ],
        backend: { ...backend, operation: "create_checkout_link" },
        confirmation: "checkout_link",
        idempotency: "optional",
        limits: { perAgentPerHour: 30 },
        enabled: false,
        source: provenance(store),
      },
    ];
    return { entities, actions };
  },

  async execute(a: ExecuteArgs) {
    const store = storeOf(a.config);
    if (a.operation === "check_stock") {
      const q = String(a.input.product).toLowerCase();
      const products = await allProducts(store, a.fetch);
      const p = products.find((x) => x.handle === q || x.title.toLowerCase() === q) ?? products.find((x) => x.title.toLowerCase().includes(q));
      if (!p) return { status: "rejected", message: `No product matching "${a.input.product}".` };
      const variants = p.variants.map((v) => ({ sku: String(v.id), variant: v.title, price: v.price, in_stock: v.available }));
      const inStock = variants.filter((v) => v.in_stock).map((v) => v.variant);
      return { status: "done", message: `${p.title}: ${inStock.length ? `in stock in ${inStock.join(", ")}` : "out of stock"}.`, data: { product: p.title, variants } };
    }
    if (a.operation === "create_checkout_link") {
      const items = a.input.items as Array<{ sku: string; quantity: number }>;
      const products = await allProducts(store, a.fetch);
      const variants = new Map(products.flatMap((p) => p.variants.map((v) => [String(v.id), { p, v }] as const)));
      const problems: string[] = [];
      for (const i of items) {
        const hit = variants.get(i.sku);
        if (!hit) problems.push(`Unknown SKU ${i.sku}`);
        else if (!hit.v.available) problems.push(`${hit.p.title} (${hit.v.title}) is out of stock`);
      }
      if (problems.length) return { status: "rejected", message: problems.join("; ") + "." };
      const url = `${store}/cart/${items.map((i) => `${i.sku}:${i.quantity}`).join(",")}`;
      const total = items.reduce((s, i) => s + Number(variants.get(i.sku)!.v.price) * i.quantity, 0);
      return {
        status: "checkout_link",
        message: `Checkout link ready (about ${total.toFixed(2)} ${a.config.currency ?? "USD"} before shipping and tax). The person reviews and pays on the store's checkout.`,
        checkout_url: url,
        data: { items: items.map((i) => ({ ...i, title: `${variants.get(i.sku)!.p.title} (${variants.get(i.sku)!.v.title})` })), subtotal: total.toFixed(2) },
      };
    }
    throw new ConnectorError(`Unknown Shopify operation ${a.operation}`);
  },
};
