import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig, SiteGraph } from "@agenticweb-dev/core";
import { UserError, type Project } from "./project.ts";
import type { RuntimeKind } from "./bundle.ts";

/** Targets that run the AgenticWeb runtime (/ask, /mcp, actions). */
export const runtimeTargets = ["node", "docker", "cloudflare-worker", "edge"];

type Out = { log: (m: string) => void };

/** Environment variables the deployed runtime will need, based on what's enabled. */
export function requiredEnv(graph: SiteGraph, config: ProjectConfig, target = "node"): Array<[string, string]> {
  const env = new Map<string, string>();
  if (target === "edge") env.set("PUBLIC_URL", "Public URL of your site (e.g. https://mysite.com); the agent branch is served under " + config.edge.prefix);
  else env.set("PUBLIC_URL", "Public URL of this agent branch, used in confirmation links (e.g. https://agents.mysite.com)");
  if (target === "node" || target === "docker") env.set("EDGE_ORIGIN", "Optional edge mode: your site's internal address (e.g. http://localhost:8080). This server then sits in front of it");
  for (const a of graph.actions.filter((x) => x.enabled)) {
    const c = a.backend.config as Record<string, unknown>;
    if (a.backend.type === "calcom") env.set(String(c.apiKeyEnv ?? "CALCOM_API_KEY"), "Cal.com API key (bookings)");
    if (a.backend.type === "stripe") env.set(String(c.apiKeyEnv ?? "STRIPE_SECRET_KEY"), "Stripe restricted key (Payment Links write, Prices read)");
    const auth = c.auth as { env?: string } | undefined;
    if (auth?.env) env.set(auth.env, `Token for ${a.name}`);
    for (const v of Object.values((c.headers as Record<string, string>) ?? {})) if (v.startsWith("env:")) env.set(v.slice(4), `Header value for ${a.name}`);
  }
  if (config.notifications.email === "resend") env.set(config.notifications.apiKeyEnv, "Resend API key (confirmation emails)");
  env.set("ANTHROPIC_API_KEY", "Optional: written answers on /ask");
  env.set(config.runtime.apiKeysEnv, 'Optional: agent API keys as "key:agent-name,key2:other"');
  return [...env];
}

/**
 * The pre-built runtime file. Published installs ship it in dist/runtime/; in the repo it is built on demand
 * (cached in .agenticweb/build) with esbuild.
 */
async function prebuilt(project: Project, kind: RuntimeKind): Promise<{ file: string; notices: string }> {
  const file = kind === "server" ? "server.mjs" : `${kind}.js`;
  const shipped = fileURLToPath(new URL(`./runtime/${file}`, import.meta.url));
  if (existsSync(shipped)) return { file: shipped, notices: fileURLToPath(new URL("./runtime/THIRD_PARTY_NOTICES.md", import.meta.url)) };
  const cached = path.join(project.dataDir, "build", file);
  try {
    const { bundleRuntimeEntry, noticesPathFor, thirdPartyNotices } = await import("./bundle.ts");
    const deps = await bundleRuntimeEntry(kind, cached);
    await writeFile(noticesPathFor(cached), thirdPartyNotices(deps, "The AgenticWeb runtime"));
    return { file: cached, notices: noticesPathFor(cached) };
  } catch (err) {
    throw new UserError(`Couldn't build the runtime: ${(err as Error).message}`);
  }
}

/** Copies the runtime and writes the site's data into a folder ready to run or upload. */
export async function bundleRuntime(project: Project, target: string, outDir: string): Promise<{ graph: SiteGraph; config: ProjectConfig }> {
  const graph = await project.requireGraph();
  const config = await project.config();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Never ship the verification token.
  const shipGraph = { ...graph, ownership: { verified: graph.ownership.verified, method: graph.ownership.method, verifiedAt: graph.ownership.verifiedAt } };
  const shipConfig = { ...config, sources: config.sources.map((s) => ({ type: s.type, config: s.config })) };

  if (target === "cloudflare-worker" || target === "edge") {
    const built = await prebuilt(project, target === "edge" ? "edge-worker" : "worker");
    await copyFile(built.file, path.join(outDir, "worker.js"));
    await copyFile(built.notices, path.join(outDir, "THIRD_PARTY_NOTICES.md"));
    await writeFile(path.join(outDir, "site-data.js"), `export const graph = ${JSON.stringify(shipGraph)};\nexport const config = ${JSON.stringify(shipConfig)};\n`);
  } else {
    const built = await prebuilt(project, "server");
    await copyFile(built.file, path.join(outDir, "server.mjs"));
    await copyFile(built.notices, path.join(outDir, "THIRD_PARTY_NOTICES.md"));
    await writeFile(path.join(outDir, "site-graph.json"), JSON.stringify(shipGraph));
    await writeFile(path.join(outDir, "config.json"), JSON.stringify(shipConfig, null, 2));
  }
  return { graph, config };
}

export async function deployRuntime(project: Project, target: string, _staticDir: string, out: Out): Promise<void> {
  const folder = target === "edge" ? "agent-edge" : target === "cloudflare-worker" ? "agent-worker" : "agent-server";
  const outDir = path.join(project.dir, folder);
  out.log(`Preparing the runtime for ${target}…`);
  const { graph, config } = await bundleRuntime(project, target, outDir);
  const env = requiredEnv(graph, config, target);
  await writeFile(path.join(outDir, ".env.example"), env.map(([k, d]) => `# ${d}\n${k}=`).join("\n\n") + "\n");
  const slug = (config.name ?? graph.site.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site";
  const confirmActions = graph.actions.filter((a) => a.enabled && (a.confirmation === "guest" || a.confirmation === "owner"));

  if (target === "edge") {
    const host = new URL(config.site).hostname;
    const zone = host.split(".").slice(-2).join(".");
    await writeFile(
      path.join(outDir, "wrangler.toml"),
      [
        `name = "${slug}-edge"`,
        `main = "worker.js"`,
        `compatibility_date = "2026-10-01"`,
        `compatibility_flags = ["nodejs_compat"]`,
        "",
        "# Runs in front of your site on its own domain. Requests the agent branch doesn't handle go to your site unchanged.",
        "# The domain must be on Cloudflare (proxied, orange cloud). Check zone_name is your domain.",
        `routes = [{ pattern = "${host}/*", zone_name = "${zone}" }]`,
        "",
        "# Keeps pending confirmations and the audit trail. Create it with:",
        "#   npx wrangler kv namespace create AGENTICWEB_KV",
        "# then paste the id below and uncomment.",
        "# [[kv_namespaces]]",
        `# binding = "AGENTICWEB_KV"`,
        `# id = ""`,
        "",
        "[vars]",
        `PUBLIC_URL = "${new URL(config.site).origin}"`,
        "# Only if your site is hosted somewhere this route can't reach directly:",
        `# ORIGIN_URL = "https://origin.${zone}"`,
        "",
      ].join("\n"),
    );
    out.log(`\nReady in ${folder}/. It runs on ${host}/* in front of your site. To publish:\n`);
    out.log(`  cd ${folder}`);
    if (confirmActions.length) out.log("  npx wrangler kv namespace create AGENTICWEB_KV   # then paste the id into wrangler.toml");
    for (const [k] of env.filter(([k]) => k !== "PUBLIC_URL" && k !== "EDGE_ORIGIN")) out.log(`  npx wrangler secret put ${k}`);
    out.log("  npx wrangler deploy\n");
    out.log(`Then check: curl -H "Accept: text/markdown" ${new URL(config.site).origin}/   and   ${new URL(config.site).origin}/llms.txt`);
    out.log("Not on Cloudflare? Use --target node or docker and set EDGE_ORIGIN to your site's internal address.");
  } else if (target === "cloudflare-worker") {
    await writeFile(
      path.join(outDir, "wrangler.toml"),
      `name = "${slug}-agents"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\ncompatibility_flags = ["nodejs_compat"]\n\n# Keeps pending confirmations and the audit trail. Create it with:\n#   npx wrangler kv namespace create AGENTICWEB_KV\n# then paste the id below and uncomment.\n# [[kv_namespaces]]\n# binding = "AGENTICWEB_KV"\n# id = ""\n\n[vars]\nPUBLIC_URL = "${config.deploy.baseUrl ?? ""}"\n`,
    );
    out.log(`\nReady in ${folder}/. To publish:\n`);
    out.log(`  cd ${folder}`);
    if (confirmActions.length) out.log("  npx wrangler kv namespace create AGENTICWEB_KV   # then paste the id into wrangler.toml");
    for (const [k] of env.filter(([k]) => k !== "PUBLIC_URL" && k !== "EDGE_ORIGIN")) out.log(`  npx wrangler secret put ${k}`);
    out.log("  npx wrangler deploy\n");
  } else if (target === "docker") {
    await writeFile(
      path.join(outDir, "Dockerfile"),
      `FROM node:24-alpine\nWORKDIR /app\nCOPY server.mjs site-graph.json config.json ./\nENV PORT=8787 DATA_DIR=/data NODE_ENV=production\nRUN mkdir -p /data && chown node /data\nVOLUME /data\nEXPOSE 8787\nUSER node\nCMD ["node", "server.mjs"]\n`,
    );
    out.log(`\nReady in ${folder}/. To run:\n\n  docker build -t ${slug}-agents ${folder}\n  docker run -p 8787:8787 --env-file ${folder}/.env -v ${slug}-data:/data ${slug}-agents\n`);
  } else {
    out.log(`\nReady in ${folder}/. To run on any server with Node 22+:\n\n  cp ${folder}/.env.example ${folder}/.env   # fill in values\n  node --env-file=${folder}/.env ${folder}/server.mjs\n`);
  }
  if (confirmActions.length && config.notifications.email === "outbox" && !config.notifications.webhookUrl) {
    out.log(`Warning: ${confirmActions.map((a) => a.name).join(", ")} need confirmation messages, but notifications go to the local outbox only.`);
    out.log('Set "notifications": { "email": "resend", "from": "Name <you@yourdomain>" } or a webhookUrl in agenticweb.config.json.');
  }
}
