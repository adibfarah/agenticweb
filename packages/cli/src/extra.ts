import type { Project } from "./project.ts";
import { cmdDeploy } from "./deploy.ts";
import { cmdReview, cmdServe } from "./serve.ts";
import { cmdConnect } from "./connect.ts";
import "./actions-hook.ts";

/** Commands added by later phases (serve, review, deploy, connect, sync…). */
export type ExtraCommand = {
  name: string;
  usage: string;
  summary: string;
  run: (project: Project, args: string[], flags: Record<string, unknown>) => Promise<void>;
};

export const extraCommands: ExtraCommand[] = [
  {
    name: "serve",
    usage: "serve [--port 8787] [--edge [origin]] [--sync-every <min>] [--no-llm]",
    summary: "Run the agent branch locally (--edge: in front of your site)",
    run: async (p, _a, f) =>
      void (await cmdServe(p, { port: f.port ? Number(f.port) : undefined, noLlm: Boolean(f["no-llm"]), syncEveryMinutes: f["sync-every"] ? Number(f["sync-every"]) : undefined, edge: f.edge === undefined ? undefined : typeof f.edge === "string" && f.edge ? f.edge : true })),
  },
  {
    name: "sync",
    usage: "sync [--every <minutes>]",
    summary: "Rebuild from your live site and show what changed",
    run: async (p, _a, f) => {
      const { cmdSync, cmdSyncLoop } = await import("./sync.ts");
      const llm = f["no-llm"] ? (false as const) : undefined;
      if (f.every) await cmdSyncLoop(p, Number(f.every), { llm });
      else await cmdSync(p, { llm });
    },
  },
  {
    name: "activity",
    usage: "activity [--days 7]",
    summary: "What agents asked and did",
    run: async (p, _a, f) => (await import("./sync.ts")).cmdActivity(p, f.days ? Number(f.days) : 7),
  },
  {
    name: "ci",
    usage: "ci [--every <hours>] [--target <target>]",
    summary: "GitHub Actions workflow to sync and deploy on a schedule",
    run: async (p, _a, f) => (await import("./sync.ts")).cmdCi(p, { every: f.every as string | undefined, target: f.target as string | undefined }),
  },
  {
    name: "review",
    usage: "review [--port 0]",
    summary: "Open a local page to choose what agents can see and do",
    run: async (p, _a, f) => void (await cmdReview(p, { port: f.port ? Number(f.port) : undefined })),
  },
  {
    name: "test",
    usage: "test [--init] [--url <agent-branch>] [--min <score>] [--strict] [--no-llm]",
    summary: "Run real tasks as an agent and get an Agent Readiness score",
    run: async (p, _a, f) =>
      void (await (await import("./readiness.ts")).cmdTest(p, {
        init: Boolean(f.init),
        url: f.url as string | undefined,
        noLlm: Boolean(f["no-llm"]),
        min: f.min !== undefined ? Number(f.min) : undefined,
        strict: Boolean(f.strict),
        only: f.only as string | undefined,
      })),
  },
  {
    name: "parity",
    usage: "parity [--strict]",
    summary: "Re-check every fact against your live pages and re-sign",
    run: async (p, _a, f) => void (await (await import("./proof.ts")).cmdParity(p, { strict: Boolean(f.strict) })),
  },
  {
    name: "check",
    usage: "check <agent-branch-url> [--strict]",
    summary: "Verify anyone's agent branch: owner signature and same facts as the site",
    run: async (_p, a, f) => void (await (await import("./proof.ts")).cmdCheck(a[0] ?? "", { strict: Boolean(f.strict) })),
  },
  {
    name: "suggest",
    usage: "suggest [--days 30] [--no-llm]",
    summary: "Draft answers for questions agents asked that your site couldn't answer",
    run: async (p, _a, f) => void (await (await import("./suggest.ts")).cmdSuggest(p, { days: f.days ? Number(f.days) : undefined, llm: f["no-llm"] ? false : undefined })),
  },
  {
    name: "connect",
    usage: "connect <shopify|woocommerce|calcom|stripe|openapi> key=value…",
    summary: "Use your real systems for data and actions",
    run: (p, args) => cmdConnect(p, args),
  },
  {
    name: "mcp",
    usage: "mcp",
    summary: "Run AgenticWeb as an MCP server (stdio) for Claude Desktop and other clients",
    run: async (p) => (await import("./mcp-server.ts")).cmdMcp(p.dir),
  },
  {
    name: "deploy",
    usage: "deploy --target edge|cloudflare-worker|node|docker|static|cloudflare|netlify|vercel",
    summary: "Prepare the agent branch for hosting",
    run: (p, _a, f) => cmdDeploy(p, { target: f.target as string | undefined, outDir: f.out as string | undefined }),
  },
];
