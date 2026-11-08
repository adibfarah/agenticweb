import { esc, layout } from "./layout.ts";

/** Ground truth for the demo shop. Shaped like a Shopify store (it serves /products.json). */
export const shop = {
  name: "Northwind Threads",
  description: "Organic cotton basics, made in Portugal. Free shipping over $75.",
  email: "support@northwind.example",
  currency: "USD",
  returnPolicy: "Returns accepted within 30 days of delivery for unworn items. Sale items can be returned within 14 days for store credit only.",
  shippingPolicy: "Free standard shipping on orders over $75. Standard shipping is $6 and takes 3–5 business days.",
  products: [
    {
      id: 1001, handle: "classic-hoodie", title: "Classic Hoodie", type: "Hoodies", price: 68,
      description: "Heavyweight organic cotton hoodie with a brushed interior.",
      variants: [
        { id: 50011, color: "Blue", size: "S", stock: 4 },
        { id: 50012, color: "Blue", size: "M", stock: 9 },
        { id: 50013, color: "Blue", size: "L", stock: 0 },
        { id: 50014, color: "Black", size: "M", stock: 12 },
        { id: 50015, color: "Black", size: "L", stock: 3 },
      ],
    },
    {
      id: 1002, handle: "everyday-tee", title: "Everyday Tee", type: "T-Shirts", price: 28,
      description: "Midweight crew neck tee. Pre-shrunk.",
      variants: [
        { id: 50021, color: "White", size: "S", stock: 20 },
        { id: 50022, color: "White", size: "M", stock: 25 },
        { id: 50023, color: "Olive", size: "M", stock: 7 },
        { id: 50024, color: "Olive", size: "L", stock: 0 },
      ],
    },
    {
      id: 1003, handle: "relaxed-chinos", title: "Relaxed Chinos", type: "Trousers", price: 79, compareAt: 95,
      description: "Garment-dyed chinos with a relaxed fit. On sale.",
      variants: [
        { id: 50031, color: "Sand", size: "30", stock: 5 },
        { id: 50032, color: "Sand", size: "32", stock: 2 },
        { id: 50033, color: "Navy", size: "32", stock: 6 },
      ],
    },
    {
      id: 1004, handle: "merino-beanie", title: "Merino Beanie", type: "Accessories", price: 32,
      description: "Soft merino wool beanie. One size.",
      variants: [
        { id: 50041, color: "Charcoal", size: "One size", stock: 15 },
        { id: 50042, color: "Rust", size: "One size", stock: 0 },
      ],
    },
  ],
};

const nav: Array<[string, string]> = [
  ["/", "Home"],
  ["/collections/all", "Shop all"],
  ["/pages/shipping", "Shipping"],
  ["/pages/returns", "Returns"],
  ["/pages/contact", "Contact"],
];
const footer = `<p>Questions? <a href="mailto:${shop.email}">${shop.email}</a></p><form class="newsletter"><input type="email" placeholder="Join our newsletter"><button>Subscribe</button></form>`;
const page = (title: string, body: string, head?: string, description?: string) =>
  layout({ siteName: shop.name, title, body, footer, nav, head, description });

type Product = (typeof shop.products)[number];

function productJsonLd(p: Product, origin: string): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    description: p.description,
    sku: String(p.id),
    url: `${origin}/products/${p.handle}`,
    brand: { "@type": "Brand", name: shop.name },
    offers: p.variants.map((v) => ({
      "@type": "Offer",
      sku: String(v.id),
      name: `${v.color} / ${v.size}`,
      price: p.price.toFixed(2),
      priceCurrency: shop.currency,
      availability: v.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

export function shopPages(origin: string): Record<string, string> {
  const pages: Record<string, string> = {
    "/": page(
      "Home",
      `<section class="hero"><h1>Basics that last.</h1><p>${shop.description}</p><a class="btn" href="/collections/all">Shop now</a></section>
       <section class="featured">${shop.products
         .slice(0, 2)
         .map((p) => `<a class="card" href="/products/${p.handle}"><img src="/static/${p.handle}.jpg" alt=""><span>${p.title}</span></a>`)
         .join("")}</section>`,
      undefined,
      shop.description,
    ),
    "/collections/all": page(
      "Shop all",
      `<h1>All products</h1><div class="grid">${shop.products
        .map(
          (p) => `<a class="card" href="/products/${p.handle}"><img src="/static/${p.handle}.jpg" alt="${esc(p.title)}">
          <span class="title">${esc(p.title)}</span><span class="price">${"compareAt" in p ? `<s>$${p.compareAt}</s> ` : ""}$${p.price}</span></a>`,
        )
        .join("")}</div>`,
    ),
    "/pages/shipping": page("Shipping", `<h1>Shipping</h1><p>${shop.shippingPolicy}</p><p>We ship to the US and Canada.</p>`),
    "/pages/returns": page("Returns", `<h1>Returns &amp; exchanges</h1><p>${shop.returnPolicy}</p><p>Start a return by emailing ${shop.email}.</p>`),
    "/pages/contact": page("Contact", `<h1>Contact</h1><p>Email ${shop.email}. We reply within one business day.</p>`),
  };
  for (const p of shop.products) {
    const colors = [...new Set(p.variants.map((v) => v.color))];
    const sizes = [...new Set(p.variants.map((v) => v.size))];
    pages[`/products/${p.handle}`] = page(
      p.title,
      `<div class="product"><div class="gallery"><img src="/static/${p.handle}.jpg" alt="${esc(p.title)}"></div>
       <div class="info"><h1>${esc(p.title)}</h1>
       <p class="price">${"compareAt" in p ? `<s>$${p.compareAt}</s> ` : ""}<span data-price>$${p.price}</span></p>
       <p>${esc(p.description)}</p>
       <form action="/cart/add" method="post" class="add-to-cart">
         <label>Color <select name="color">${colors.map((c) => `<option>${c}</option>`).join("")}</select></label>
         <label>Size <select name="size">${sizes.map((s) => `<option>${s}</option>`).join("")}</select></label>
         <input type="hidden" name="product_id" value="${p.id}">
         <label>Quantity <input type="number" name="quantity" value="1" min="1"></label>
         <button type="submit">Add to cart</button>
       </form>
       <p class="stock-note" data-js-stock>Checking stock…</p>
       </div></div>`,
      productJsonLd(p, origin),
      p.description,
    );
  }
  return pages;
}

/** Shopify-style public catalog JSON (GET /products.json). */
export function shopProductsJson() {
  return {
    products: shop.products.map((p) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      body_html: `<p>${p.description}</p>`,
      product_type: p.type,
      vendor: shop.name,
      tags: [],
      variants: p.variants.map((v) => ({
        id: v.id,
        title: `${v.color} / ${v.size}`,
        option1: v.color,
        option2: v.size,
        price: p.price.toFixed(2),
        compare_at_price: "compareAt" in p ? Number(p.compareAt).toFixed(2) : null,
        available: v.stock > 0,
        sku: String(v.id),
      })),
      options: [
        { name: "Color", values: [...new Set(p.variants.map((v) => v.color))] },
        { name: "Size", values: [...new Set(p.variants.map((v) => v.size))] },
      ],
    })),
  };
}
