import { builtinConnectors } from "@agenticweb-dev/actions";
import { Project, UserError } from "./project.ts";

const EXAMPLES: Record<string, string> = {
  shopify: "agenticweb connect shopify store=https://your-store.myshopify.com",
  woocommerce: "agenticweb connect woocommerce store=https://shop.example.com",
  calcom: "agenticweb connect calcom eventTypeId=123456 timeZone=America/Los_Angeles   (bookings need CALCOM_API_KEY)",
  stripe: "agenticweb connect stripe   (needs STRIPE_SECRET_KEY, a restricted key)",
  openapi: "agenticweb connect openapi spec=https://api.example.com/openapi.json operations=createBooking,getQuote",
};

/** Adds a data source / connector to agenticweb.config.json. Values are key=value pairs; secrets stay in env vars. */
export async function cmdConnect(project: Project, args: string[], out = { log: (m: string) => console.log(m) }) {
  const [type, ...pairs] = args;
  if (!type || type === "--help") {
    out.log(`Connect a data source so actions use your real systems:\n\n${Object.values(EXAMPLES).map((e) => `  ${e}`).join("\n")}`);
    return;
  }
  if (!builtinConnectors[type]?.sync) throw new UserError(`Unknown source "${type}". Available: ${Object.keys(EXAMPLES).join(", ")}`);
  const cfg: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) throw new UserError(`Expected key=value, got "${p}". Example: ${EXAMPLES[type]}`);
    const key = p.slice(0, i);
    const raw = p.slice(i + 1);
    if (/key|secret|token|password/i.test(key) && !/env$/i.test(key)) {
      throw new UserError(`Don't put secrets in the config file. Set an environment variable instead (e.g. ${key.toUpperCase()}).`);
    }
    cfg[key] = key === "operations" ? raw.split(",") : /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  const config = await project.config();
  config.sources = config.sources.filter((s) => s.type !== type);
  config.sources.push({ type, config: cfg });
  await project.saveConfig(config);
  out.log(`Added ${type}. Run \`agenticweb build\` to pull its data, then \`agenticweb actions\` to enable what agents may do.`);
}
