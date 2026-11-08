import { slugify, type Entity, type Provenance } from "@agenticweb-dev/core";

/** Turns a JSON-LD object found on a page into a Site Graph entity. */
export function entityFromJsonLd(obj: Record<string, unknown>, pageUrl: string, seen: string): Entity | undefined {
  const rawType = obj["@type"];
  const type = Array.isArray(rawType) ? String(rawType[0]) : typeof rawType === "string" ? rawType : undefined;
  if (!type || type === "WebSite" || type === "WebPage" || type === "BreadcrumbList" || type === "SearchAction") return undefined;
  const name = String(obj.name ?? obj.headline ?? type);
  const data: Record<string, unknown> = { ...obj };
  delete data["@context"];
  const id = typeof obj["@id"] === "string" ? obj["@id"] : typeof obj.url === "string" ? obj.url : `${pageUrl}#${slugify(name)}`;
  data["@id"] = id;
  const source: Provenance = { url: pageUrl, via: "jsonld", seen };
  return { id, type, name, data, hidden: false, source };
}

export type ExtractedField = { name: string; value: string };

/**
 * Maps generic extracted fields onto schema.org properties.
 * Unknown fields become schema.org PropertyValue entries under additionalProperty.
 */
export function fieldsToJsonLd(type: string, name: string, description: string, fields: ExtractedField[]): Record<string, unknown> {
  const out: Record<string, unknown> = { "@type": type, name };
  if (description) out.description = description;
  const extra: Array<{ "@type": "PropertyValue"; name: string; value: string }> = [];
  let price: string | undefined;
  let currency: string | undefined;
  let availability: string | undefined;
  for (const { name: rawKey, value } of fields) {
    const key = rawKey.toLowerCase().replace(/[\s_-]+/g, "");
    if (!value) continue;
    switch (key) {
      case "price":
        price = value.replace(/[^0-9.]/g, "") || value;
        if (!currency && value.includes("$")) currency = "USD";
        if (!currency && value.includes("€")) currency = "EUR";
        if (!currency && value.includes("£")) currency = "GBP";
        break;
      case "currency":
      case "pricecurrency":
        currency = value.toUpperCase();
        break;
      case "availability":
      case "stock":
        availability = /out|sold|0\b|unavailable/i.test(value) ? "https://schema.org/OutOfStock" : "https://schema.org/InStock";
        break;
      case "diet":
      case "dietary":
      case "suitablefordiet":
        out.suitableForDiet = value
          .split(/[,;]/)
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => `https://schema.org/${d.charAt(0).toUpperCase()}${d.slice(1).toLowerCase()}Diet`);
        break;
      case "phone":
      case "telephone":
        out.telephone = value;
        break;
      case "email":
        out.email = value;
        break;
      case "address":
        out.address = value;
        break;
      case "url":
      case "image":
      case "sku":
      case "category":
      case "brand":
      case "startdate":
      case "enddate":
      case "location":
      case "duration":
        out[rawKey.charAt(0).toLowerCase() + rawKey.slice(1).replace(/[\s_-]+(\w)/g, (_m, c: string) => c.toUpperCase())] = value;
        break;
      case "answer":
        out.acceptedAnswer = { "@type": "Answer", text: value };
        break;
      case "openinghours":
        out.openingHours = value;
        break;
      default:
        extra.push({ "@type": "PropertyValue", name: rawKey, value });
    }
  }
  if (price) {
    out.offers = { "@type": "Offer", price, priceCurrency: currency ?? "USD", ...(availability ? { availability } : {}) };
  }
  if (extra.length) out.additionalProperty = extra;
  return out;
}
