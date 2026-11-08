import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { Project, cmdActions, cmdBuild, cmdInit } from "../src/index.ts";
import { TASKS_FILE, cmdTest, readinessScore, starterTasks, type ClaudeClient } from "../src/readiness.ts";

let sites: DemoSites;
let dir: string;
const out = { log: (_m: string) => {} };

const tasks = (date: string) => ({
  tasks: [
    { id: "sunday-close", task: "What time does Bella Cucina close on Sunday?", expect: ["21:00"] },
    { id: "vegan-pizza", task: "Which pizza is vegan?", expect: ["Marinara"] },
    {
      id: "book",
      task: `Book a table for 4 on ${date} at 19:00 for Sam Lee, sam@example.com`,
      action: "request_booking",
      input: { date, time: "19:00", party_size: 4, name: "Sam Lee", email: "sam@example.com" },
    },
  ],
});

const inTwoWeeks = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-ready-"));
  const project = new Project(dir);
  await cmdInit(project, sites.restaurant, {}, out);
  await cmdBuild(project, { llm: false }, out);
  await cmdActions(project, "enable", "request_booking", out);
  await cmdBuild(project, { llm: false }, out);
}, 60_000);
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A scripted stand-in for Claude: on the first turn it calls one tool (ask, the booking action, or fetch_page),
 * then answers with what the tool returned. Enough to drive the real MCP server and the real loop.
 */
function scriptedClaude(date: string): ClaudeClient & { calls: number } {
  const c = {
    calls: 0,
    messages: {
      async create(params: Record<string, unknown>) {
        c.calls++;
        const msgs = params.messages as Array<{ role: string; content: unknown }>;
        const tools = (params.tools as Array<{ name: string; input_schema: { properties?: Record<string, unknown> } }>).map((t) => t);
        const usage = { input_tokens: 1000, output_tokens: 100 };
        const last = msgs.at(-1)!;
        if (typeof last.content === "string") {
          const task = last.content;
          if (tools.some((t) => t.name === "fetch_page")) return { content: [{ type: "tool_use", id: "t1", name: "fetch_page", input: { url: "/" } }], stop_reason: "tool_use", usage };
          if (/book a table/i.test(task)) {
            const booking = tools.find((t) => t.name === "request_booking")!;
            expect(booking.input_schema.properties).toHaveProperty("idempotency_key");
            return {
              content: [{ type: "tool_use", id: "t1", name: "request_booking", input: { date, time: "19:00", party_size: 4, name: "Sam Lee", email: "sam@example.com", idempotency_key: "k-1" } }],
              stop_reason: "tool_use",
              usage,
            };
          }
          return { content: [{ type: "tool_use", id: "t1", name: "ask", input: { query: task } }], stop_reason: "tool_use", usage };
        }
        const result = (last.content as Array<{ content: string }>)[0]!.content;
        return { content: [{ type: "text", text: `Here is what I found: ${result.slice(0, 3000)}` }], stop_reason: "end_turn", usage };
      },
    },
  };
  return c;
}

describe("agent readiness tests", () => {
  it("writes starter tasks from the build", async () => {
    const project = new Project(dir);
    const g = await project.requireGraph();
    const starters = starterTasks(g);
    expect(starters.some((t) => t.action === "request_booking")).toBe(true);
    expect(starters.every((t) => t.expect.length || t.action)).toBe(true);
    await cmdTest(project, { init: true }, out);
    expect(existsSync(path.join(dir, TASKS_FILE))).toBe(true);
    await expect(cmdTest(project, { init: true }, out)).rejects.toThrow(/already exists/);
  });

  it("runs tasks in built-in mode, scores them and writes a report and badge", async () => {
    const date = inTwoWeeks();
    await writeFile(path.join(dir, TASKS_FILE), JSON.stringify(tasks(date)));
    const r = (await cmdTest(new Project(dir), { noLlm: true }, out))!;
    expect(r.mode).toBe("built-in");
    const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(byId["sunday-close"]!.agent.success).toBe(true);
    expect(byId["sunday-close"]!.human!.success).toBe(true);
    // The menu is a link away from the home page.
    expect(byId["vegan-pizza"]!.human!.requests).toBeGreaterThan(1);
    // The booking waits for the guest; the confirmation email stays in a local outbox.
    expect(byId.book!.agent.success, byId.book!.agent.note).toBe(true);
    expect(byId.book!.agent.note).toMatch(/guest to confirm/);
    expect(byId.book!.human!.ran).toBe(false);
    expect(r.checks.find((c) => c.id === "mcp")!.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "llms-txt")!.ok).toBe(true);
    // The demo site doesn't link to an agent branch yet.
    expect(r.checks.find((c) => c.id === "discovery")!.ok).toBe(false);
    expect(r.score).toBe(readinessScore(r.tasks, r.checks));
    expect(r.score).toBeGreaterThan(80);
    expect(r.totals.agentTokens).toBeLessThan(r.totals.humanTokens);
    const md = await readFile(path.join(dir, "agent-readiness", "report.md"), "utf8");
    expect(md).toContain(`# Agent Readiness: ${r.score}/100`);
    expect(await readFile(path.join(dir, "agent-readiness", "badge.svg"), "utf8")).toContain(`agent readiness: ${r.score}`);
    expect(JSON.parse(await readFile(path.join(dir, "agent-readiness", "badge.json"), "utf8")).message).toBe(String(r.score));
  }, 60_000);

  it("flags tasks that passed last time and fail now, and enforces --min", async () => {
    const file = path.join(dir, TASKS_FILE);
    const t = tasks(inTwoWeeks());
    t.tasks[0]!.expect = ["closed all day"];
    await writeFile(file, JSON.stringify(t));
    await expect(cmdTest(new Project(dir), { noLlm: true, strict: true }, out)).rejects.toThrow(/sunday-close/);
    await expect(cmdTest(new Project(dir), { noLlm: true, min: 101 }, out)).rejects.toThrow(/below --min 101/);
  }, 60_000);

  it("drives a Claude agent through the real MCP server and the human site", async () => {
    const date = inTwoWeeks();
    await writeFile(path.join(dir, TASKS_FILE), JSON.stringify(tasks(date)));
    const client = scriptedClaude(date);
    const r = (await cmdTest(new Project(dir), { client }, out))!;
    expect(r.mode).toBe("claude");
    const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(byId["vegan-pizza"]!.agent.calls).toEqual(["ask"]);
    expect(byId["vegan-pizza"]!.agent.success).toBe(true);
    expect(byId.book!.agent.calls).toEqual(["request_booking"]);
    expect(byId.book!.agent.success, byId.book!.agent.note).toBe(true);
    // The scripted agent only reads the home page: the hours are there, the menu isn't.
    expect(byId["sunday-close"]!.human!.calls).toEqual(["fetch_page"]);
    expect(byId["sunday-close"]!.human!.success).toBe(true);
    expect(byId["vegan-pizza"]!.human!.success).toBe(false);
    expect(byId["sunday-close"]!.agent.tokens).toBe(2200);
    expect(r.totals.costUsd).toBeGreaterThan(0);
  }, 60_000);

  it("never runs actions that would take effect right away", async () => {
    const { localAgentBranch } = await import("../src/readiness.ts");
    const project = new Project(dir);
    const g = await project.requireGraph();
    const graph = { ...g, actions: g.actions.map((a) => (a.name === "request_booking" ? { ...a, confirmation: "none" as const } : a)) };
    const branch = await localAgentBranch(graph, await project.config());
    const res = await branch.fetcher(
      new Request(`${branch.baseUrl}/api/request_booking`, {
        method: "POST",
        headers: { "idempotency-key": "x" },
        body: JSON.stringify({ date: inTwoWeeks(), time: "19:00", party_size: 2, name: "A", email: "a@example.com" }),
      }),
    );
    const body = (await res.json()) as { data?: { simulated?: boolean } };
    expect(body.data?.simulated).toBe(true);
    expect(branch.outbox.sent).toHaveLength(0);
  });
});
