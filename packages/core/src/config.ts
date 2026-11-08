import { z } from "zod";
import { ActionBackend, ActionField, ActionKind, Confirmation } from "./schema.ts";

/** An owner's edit to one action. No defaults: anything not written stays as discovered. */
export const ActionOverride = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  confirmation: Confirmation.optional(),
  description: z.string().optional(),
  note: z.string().optional(),
  kind: ActionKind.optional(),
  input: z.array(ActionField).optional(),
  backend: ActionBackend.optional(),
  idempotency: z.enum(["required", "optional"]).optional(),
  limits: z.object({ perAgentPerHour: z.number().int().positive().optional(), perIpPerHour: z.number().int().positive().optional() }).optional(),
});
export type ActionOverride = z.infer<typeof ActionOverride>;

const crawlDefaults = { maxPages: 200, include: [], exclude: [], render: "fetch" as const, respectRobots: true, concurrency: 4 };
const llmDefaults = {
  enabled: true,
  classifyModel: "claude-opus-5-5",
  extractModel: "claude-opus-5-5",
  actionsModel: "claude-opus-5-5",
  askModel: "claude-opus-5-5",
};

const edgeDefaults = {
  prefix: "/.agent",
  rootPaths: ["/llms.txt", "/llms-full.txt", "/.well-known/agent-site.json", "/.well-known/agent-card.json", "/.well-known/ucp", "/.well-known/agent-site-key.json", "/.well-known/agent-site-proof.json"],
  markdown: true,
  injectLinks: true,
  robots: true,
  webmcp: true,
};

const testsDefaults = { model: "claude-opus-5-5", effort: "low", maxTurns: 12 };

const commerceDefaults = { ucp: true, acp: true, acpProvider: "stripe", sessionMinutes: 60, verifyAgentProfiles: true, paymentHandlers: {} };

/** Project config file: agenticweb.config.json */
export const ProjectConfig = z.object({
  site: z.string().url().describe("Main URL of the human site"),
  name: z.string().optional(),
  crawl: z
    .object({
      maxPages: z.number().int().positive().default(crawlDefaults.maxPages),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      /** "fetch" is fast; "browser" uses Playwright for JavaScript-heavy sites. */
      render: z.enum(["fetch", "browser"]).default("fetch"),
      respectRobots: z.boolean().default(true),
      concurrency: z.number().int().min(1).max(16).default(4),
    })
    .default(crawlDefaults),
  /** Data sources read directly instead of (or as well as) crawling. */
  sources: z
    .array(
      z.object({
        type: z.string(),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
  /**
   * Owner choices for actions, merged over the ones AgenticWeb discovers. Only the fields written here change.
   * A complete entry (description, kind, backend) that matches no discovered action is added as a new action.
   */
  actions: z.array(ActionOverride).default([]),
  llm: z
    .object({
      enabled: z.boolean().default(true),
      classifyModel: z.string().default(llmDefaults.classifyModel),
      extractModel: z.string().default(llmDefaults.extractModel),
      actionsModel: z.string().default(llmDefaults.actionsModel),
      askModel: z.string().default(llmDefaults.askModel),
    })
    .default(llmDefaults),
  deploy: z
    .object({
      target: z.enum(["static", "node", "cloudflare", "vercel", "netlify", "docker", "cloudflare-worker", "edge"]).default("static"),
      /** Public base URL of the agent branch, e.g. https://agents.example.com */
      baseUrl: z.string().optional(),
    })
    .default({ target: "static" }),
  /** How confirmation links and action notices are delivered. */
  notifications: z
    .object({
      /** Where "owner" confirmations and new-action notices go. */
      ownerEmail: z.string().optional(),
      /** POST every action event as JSON here (Slack/Zapier/your backend). */
      webhookUrl: z.string().url().optional(),
      /** "outbox" writes messages to .agenticweb/outbox.log for local testing. */
      email: z.enum(["outbox", "resend", "none"]).default("outbox"),
      from: z.string().optional(),
      /** Name of the env var holding the email provider key. */
      apiKeyEnv: z.string().default("RESEND_API_KEY"),
    })
    .default({ email: "outbox", apiKeyEnv: "RESEND_API_KEY" }),
  runtime: z
    .object({
      /** Minutes a pending action waits for confirmation before it expires. */
      holdMinutes: z.number().int().positive().default(15),
      requestsPerMinute: z.number().int().positive().default(60),
      /** Env var holding agent API keys as "key1:agent-name,key2:other". Optional. */
      apiKeysEnv: z.string().default("AGENTICWEB_API_KEYS"),
    })
    .default({ holdMinutes: 15, requestsPerMinute: 60, apiKeysEnv: "AGENTICWEB_API_KEYS" }),
  /**
   * Edge mode: run in front of the human site on the same domain (deploy --target edge).
   * Nothing is installed on the site itself.
   */
  edge: z
    .object({
      /** Path the agent branch is served under. */
      prefix: z.string().default(edgeDefaults.prefix),
      /** Where the human site really lives. Leave it out on a Cloudflare route in front of the site. */
      origin: z.string().url().optional(),
      /** Agent-branch files also served at the root of the domain. */
      rootPaths: z.array(z.string()).default(edgeDefaults.rootPaths),
      /** Answer Accept: text/markdown with the page's Markdown version. */
      markdown: z.boolean().default(true),
      /** Add discovery <link> tags to HTML pages as they pass through. */
      injectLinks: z.boolean().default(true),
      /** Add agent-branch lines to robots.txt. */
      robots: z.boolean().default(true),
      /** Load the WebMCP script on HTML pages so browser agents get the site's tools. */
      webmcp: z.boolean().default(true),
    })
    .default(edgeDefaults),
  /**
   * Agent checkout protocols. UCP is offered when a checkout-link or payment action is enabled; ACP only when
   * an agent-payment action (confirmation "payment_protocol") is enabled, because ACP always takes payment.
   */
  commerce: z
    .object({
      ucp: z.boolean().default(true),
      acp: z.boolean().default(true),
      /** ACP payment_provider: whose delegated payment tokens your payment adapter accepts. */
      acpProvider: z.string().default("stripe"),
      sessionMinutes: z.number().int().positive().default(60),
      /** UCP: fetch and check the platform profile named in the UCP-Agent header. */
      verifyAgentProfiles: z.boolean().default(true),
      /** UCP payment_handlers for /.well-known/ucp, as your payment adapter documents them. */
      paymentHandlers: z.record(z.string(), z.unknown()).default({}),
    })
    .default(commerceDefaults),
  /**
   * Agent identity and permissions. Reading is always open. Rules decide which actions each kind of caller may use.
   * Keys: an agent's signing domain (e.g. "chatgpt.com") or API-key agent name, "verified", or "unverified".
   * Example: { "verified": { "actions": "all" }, "unverified": { "actions": "read", "requestsPerMinute": 20 } }
   */
  agents: z
    .object({
      /** Check Web Bot Auth signatures (IETF webbotauth) to know which agent operator is calling. */
      webBotAuth: z.boolean().default(true),
      rules: z
        .record(
          z.string(),
          z.object({
            actions: z.union([z.enum(["all", "read", "none"]), z.array(z.string())]).default("all"),
            requestsPerMinute: z.number().int().positive().optional(),
          }),
        )
        .default({}),
    })
    .default({ webBotAuth: true, rules: {} }),
  /** Agent Readiness tests (agenticweb test). Tasks live in agenticweb.tests.json. */
  tests: z
    .object({
      /** The model that plays the agent. */
      model: z.string().default(testsDefaults.model),
      effort: z.enum(["low", "medium", "high"]).default("low"),
      /** Most model turns per task before it counts as a failure. */
      maxTurns: z.number().int().min(1).max(50).default(testsDefaults.maxTurns),
    })
    .default(testsDefaults as { model: string; effort: "low"; maxTurns: number }),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type ProjectConfigInput = z.input<typeof ProjectConfig>;
