import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Project, UserError } from "./project.ts";
import { cmdActions, cmdBuild, cmdInit, cmdStatus, cmdVerify, cmdVisibility, cmdSnippets } from "./commands.ts";
import { cmdDeploy } from "./deploy.ts";
import { cmdConnect } from "./connect.ts";

/** Runs a CLI command and returns everything it printed as the tool result. */
async function run(fn: (out: { log: (m: string) => void }) => Promise<unknown>) {
  const lines: string[] = [];
  try {
    await fn({ log: (m) => lines.push(m) });
    return { content: [{ type: "text" as const, text: lines.join("\n") || "Done." }] };
  } catch (err) {
    const msg = err instanceof UserError ? err.message : `Error: ${(err as Error).message}`;
    return { content: [{ type: "text" as const, text: [...lines, msg].join("\n") }], isError: true };
  }
}

/**
 * AgenticWeb as an MCP server (stdio), so Claude Desktop or any MCP client can create and manage agent branches.
 * Add to an MCP client config:  { "command": "npx", "args": ["agenticweb-cli@latest", "mcp"] }
 */
export async function cmdMcp(defaultDir: string) {
  const server = new McpServer(
    { name: "agenticweb", version: "0.1.0" },
    {
      instructions:
        "Creates agent branches of websites the user owns. Always use a project folder (dir). Ownership must be verified for public sites. Never enable actions or deploy without the user's explicit agreement.",
    },
  );
  const dir = { dir: z.string().optional().describe(`Project folder (default: ${defaultDir})`) };
  const project = (d?: string) => new Project(path.resolve(d ?? defaultDir));

  server.registerTool(
    "agenticweb_init",
    { title: "Start a project", description: "Start an AgenticWeb project for a website the user owns. Prints ownership-verification steps for public sites.", inputSchema: { url: z.string().url(), name: z.string().optional(), ...dir } },
    async ({ url, name, dir: d }) => run((out) => cmdInit(project(d), url, { name }, out)),
  );
  server.registerTool(
    "agenticweb_verify",
    { title: "Verify ownership", description: "Check the DNS TXT record or verification file for the project's site.", inputSchema: { ...dir } },
    async ({ dir: d }) => run((out) => cmdVerify(project(d), out)),
  );
  server.registerTool(
    "agenticweb_connect",
    {
      title: "Connect a data source",
      description: "Connect Shopify, WooCommerce, Cal.com, Stripe or an OpenAPI spec. Options are key=value strings; secrets must be environment variables.",
      inputSchema: { type: z.enum(["shopify", "woocommerce", "calcom", "stripe", "openapi"]), options: z.array(z.string()).default([]), ...dir },
    },
    async ({ type, options, dir: d }) => run((out) => cmdConnect(project(d), [type, ...options], out)),
  );
  server.registerTool(
    "agenticweb_build",
    { title: "Build the agent branch", description: "Crawl the site, extract its data and generate the agent branch.", inputSchema: { useClaude: z.boolean().default(true).describe("Use Claude for extraction when credentials exist"), ...dir } },
    async ({ useClaude, dir: d }) => run((out) => cmdBuild(project(d), { llm: useClaude ? undefined : false }, out)),
  );
  server.registerTool(
    "agenticweb_status",
    { title: "Show status", description: "Summary of pages, data and actions in the agent branch.", inputSchema: { ...dir }, annotations: { readOnlyHint: true } },
    async ({ dir: d }) => run((out) => cmdStatus(project(d), out)),
  );
  server.registerTool(
    "agenticweb_actions",
    { title: "List or change actions", description: "List actions, or enable/disable one. Only enable an action when the user explicitly agrees.", inputSchema: { change: z.enum(["list", "enable", "disable"]).default("list"), name: z.string().optional(), ...dir } },
    async ({ change, name, dir: d }) => run((out) => cmdActions(project(d), change, name, out)),
  );
  server.registerTool(
    "agenticweb_visibility",
    { title: "Hide or show content", description: "Hide or show a page (by slug) or a data item (by id or name) from agents.", inputSchema: { hide: z.boolean(), target: z.string(), ...dir } },
    async ({ hide, target, dir: d }) => run((out) => cmdVisibility(project(d), hide, target, out)),
  );
  server.registerTool(
    "agenticweb_deploy",
    {
      title: "Prepare a deploy",
      description: "Prepare files for a host and return the publish commands. Doesn't publish anything itself.",
      inputSchema: { target: z.enum(["static", "cloudflare", "netlify", "vercel", "node", "docker", "cloudflare-worker"]), ...dir },
    },
    async ({ target, dir: d }) => run((out) => cmdDeploy(project(d), { target }, out)),
  );
  server.registerTool(
    "agenticweb_snippets",
    { title: "Discovery snippets", description: "HTML <link> tags and robots.txt lines to add to the human site.", inputSchema: { baseUrl: z.string().url(), ...dir }, annotations: { readOnlyHint: true } },
    async ({ baseUrl, dir: d }) => run((out) => cmdSnippets(project(d), baseUrl, out)),
  );

  await server.connect(new StdioServerTransport());
}
