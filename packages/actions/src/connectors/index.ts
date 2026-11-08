import type { Connector } from "../types.ts";
import { calcom } from "./calcom.ts";
import { shopify } from "./shopify.ts";
import { woocommerce } from "./woocommerce.ts";
import { stripe } from "./stripe.ts";
import { http } from "./http.ts";
import { formBridge } from "./form-bridge.ts";
import { openapi } from "./openapi.ts";

export { calcom, shopify, woocommerce, stripe, http, formBridge, openapi };

/** All built-in connectors, keyed by backend type. */
export const builtinConnectors: Record<string, Connector> = {
  calcom,
  shopify,
  woocommerce,
  stripe,
  http,
  "form-bridge": formBridge,
  openapi,
};
