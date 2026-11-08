import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";

let sites: DemoSites;
let dir: string;
beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-mcp-"));
});
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("agenticweb mcp", () => {
  it("lets an MCP client create and inspect an agent branch", async () => {
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--dir", dir], env: { ...process.env, ANTHROPIC_API_KEY: "" } as Record<string, string> }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["agenticweb_init", "agenticweb_build", "agenticweb_actions", "agenticweb_deploy"]));
      expect(text(await client.callTool({ name: "agenticweb_init", arguments: { url: sites.restaurant } }))).toContain("Created agenticweb.config.json");
      expect(text(await client.callTool({ name: "agenticweb_build", arguments: { useClaude: false } }))).toContain("Bella Cucina (Restaurant)");
      expect(text(await client.callTool({ name: "agenticweb_actions", arguments: {} }))).toContain("request_booking");
      const bad = await client.callTool({ name: "agenticweb_actions", arguments: { change: "enable", name: "nope" } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
