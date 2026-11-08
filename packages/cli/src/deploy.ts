import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Project, UserError } from "./project.ts";

const HEADERS = `/*
  Access-Control-Allow-Origin: *
  X-Robots-Tag: noindex
/*.md
  Content-Type: text/markdown; charset=utf-8
/llms.txt
  Content-Type: text/plain; charset=utf-8
/llms-full.txt
  Content-Type: text/plain; charset=utf-8
/.well-known/*
  Content-Type: application/json; charset=utf-8
/webmcp.js
  Content-Type: text/javascript; charset=utf-8
`;

export type DeployOptions = { target?: string; outDir?: string };

/**
 * Prepares the built agent branch for a hosting target and prints the command to publish it.
 * Static targets serve files only. Runtime targets (node, docker, cloudflare-worker) also serve /ask, /mcp and actions.
 */
export async function cmdDeploy(project: Project, opts: DeployOptions, out = { log: (m: string) => console.log(m) }) {
  const config = await project.config();
  const target = opts.target ?? config.deploy.target;
  const dir = path.resolve(project.dir, opts.outDir ?? "agent-branch");
  if (!existsSync(path.join(dir, ".well-known", "agent-site.json"))) throw new UserError("Build first: agenticweb build");
  const rel = path.relative(process.cwd(), dir) || ".";

  switch (target) {
    case "static":
      // GitHub Pages hides folders starting with "." unless Jekyll is turned off.
      await writeFile(path.join(dir, ".nojekyll"), "");
      out.log(`Static files are ready in ${rel}. Upload them to any static host (GitHub Pages, S3, your web server).`);
      out.log("Serve them at your agent branch address, e.g. https://agents.mysite.com/ or https://mysite.com/.agent/");
      return;
    case "cloudflare":
      await writeFile(path.join(dir, "_headers"), HEADERS);
      out.log(`Ready for Cloudflare Pages. Publish with:\n\n  npx wrangler pages deploy ${rel} --project-name ${slug(config.name ?? new URL(config.site).hostname)}-agents\n`);
      out.log("For /ask, /mcp and actions, use --target cloudflare-worker instead.");
      return;
    case "netlify":
      await writeFile(path.join(dir, "_headers"), HEADERS);
      out.log(`Ready for Netlify. Publish with:\n\n  npx netlify deploy --prod --dir ${rel}\n`);
      return;
    case "vercel":
      await writeFile(
        path.join(dir, "vercel.json"),
        JSON.stringify(
          {
            headers: [
              { source: "/(.*)", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] },
              { source: "/(.*).md", headers: [{ key: "Content-Type", value: "text/markdown; charset=utf-8" }] },
            ],
          },
          null,
          2,
        ),
      );
      out.log(`Ready for Vercel. Publish with:\n\n  npx vercel deploy ${rel} --prod\n`);
      return;
    default: {
      const runtime = await import("./deploy-runtime.ts").catch(() => undefined);
      if (runtime && runtime.runtimeTargets.includes(target)) return runtime.deployRuntime(project, target, dir, out);
      throw new UserError(`Unknown target "${target}". Use: edge, cloudflare-worker, node, docker, static, cloudflare, netlify, vercel`);
    }
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
