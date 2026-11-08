import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSites, type DemoSites } from "@agenticweb-dev/examples";
import { checkParity, signGraph, textHasFact, verifyProof, KEY_TXT_PREFIX } from "@agenticweb-dev/emitters";
import { createApp } from "@agenticweb-dev/runtime";
import type { SiteGraph } from "@agenticweb-dev/core";
import { Project, cmdBuild, cmdInit } from "../src/index.ts";
import { cmdCheck, fetchHumanPages, loadSigningKey } from "../src/proof.ts";

let sites: DemoSites;
let dir: string;
const out = { log: (_m: string) => {} };

beforeAll(async () => {
  sites = await startDemoSites();
  dir = await mkdtemp(path.join(tmpdir(), "agenticweb-proof-"));
  const project = new Project(dir);
  await cmdInit(project, sites.restaurant, {}, out);
  await cmdBuild(project, { llm: false }, out);
}, 60_000);
afterAll(async () => {
  await sites.close();
  await rm(dir, { recursive: true, force: true });
});

/** Serves an agent branch at https://agents.bella.test and passes everything else to the real network. */
const branchFetch = (graph: SiteGraph): typeof fetch => {
  const app = createApp({ graph });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    return new URL(req.url).hostname === "agents.bella.test" ? app.fetch(req) : fetch(req);
  }) as typeof fetch;
};

describe("fact matching", () => {
  it("finds prices, times, phones and names however the page writes them", () => {
    expect(textHasFact("Cacio e pepe $17", "price", "17.00")).toBe(true);
    expect(textHasFact("Cacio e pepe $117", "price", "17")).toBe(false);
    expect(textHasFact("Tiramisu 8.50", "price", "8.5")).toBe(true);
    expect(textHasFact("Sunday 12pm to 9 pm", "hours", "21:00")).toBe(true);
    expect(textHasFact("Sunday noon to 9:30 pm", "hours", "21:30")).toBe(true);
    expect(textHasFact("Open until 10pm", "hours", "21:00")).toBe(false);
    expect(textHasFact("Call (555) 555-0100", "phone", "+1 555-555-0100")).toBe(true);
    expect(textHasFact("Café Crème Brûlée", "name", "cafe creme brulee")).toBe(true);
  });
});

describe("parity proof", () => {
  it("checks every fact against the human pages and signs the result at build", async () => {
    const project = new Project(dir);
    const g = await project.requireGraph();
    expect(g.parity!.summary.facts).toBeGreaterThan(10);
    expect(g.parity!.summary.missing).toBe(0);
    expect(g.parity!.summary.score).toBe(100);
    expect(g.proof!.kid).toBeTruthy();
    expect((await verifyProof(g, g.proof!)).ok).toBe(true);
    // The key stays private and out of git.
    expect(existsSync(path.join(dir, ".agenticweb", "signing-key.json"))).toBe(true);
    expect(await readFile(path.join(dir, ".agenticweb", ".gitignore"), "utf8")).toContain("signing-key.json");
    expect(await readFile(path.join(dir, "agent-branch", ".well-known", "agent-site-key.json"), "utf8")).not.toContain('"d"');
    const md = await readFile(path.join(dir, "agent-branch", "parity.md"), "utf8");
    expect(md).toContain("Parity: **100%**");
    const manifest = JSON.parse(await readFile(path.join(dir, "agent-branch", ".well-known", "agent-site.json"), "utf8")) as { proof: { parity_score: number; signature: string } };
    expect(manifest.proof.parity_score).toBe(100);
    expect(manifest.proof.signature).toBe("/.well-known/agent-site-proof.json");
  });

  it("lists a fact the agent branch states but the page doesn't", async () => {
    const g = await new Project(dir).requireGraph();
    const changed = structuredClone(g);
    const item = changed.entities.find((e) => (e.data.offers as { price?: string } | undefined)?.price)!;
    (item.data.offers as { price: string }).price = "999";
    const r = checkParity(changed, await fetchHumanPages(changed));
    expect(r.summary.missing).toBe(1);
    expect(r.items.find((i) => i.status === "missing")).toMatchObject({ name: item.name, field: "price", value: "999" });
    // And the old signature no longer matches the changed facts.
    expect((await verifyProof(changed, g.proof!)).problems).toContain("The facts were changed after they were signed.");
  });

  it("lets anyone check a published branch: signature, key and live parity", async () => {
    const g = await new Project(dir).requireGraph();
    const txt = async () => [[`${KEY_TXT_PREFIX}${g.proof!.kid}`]];
    const ok = await cmdCheck("https://agents.bella.test", { fetchImpl: branchFetch(g), resolveTxt: txt }, out);
    expect(ok.signature.ok).toBe(true);
    expect(ok.key).toEqual({ anchored: true, how: expect.stringMatching(/DNS TXT/) });
    expect(ok.parity!.summary.missing).toBe(0);
    expect(ok.ok).toBe(true);

    // A key that the site doesn't name isn't trusted, even with a valid signature.
    const noTxt = await cmdCheck("https://agents.bella.test", { fetchImpl: branchFetch(g), resolveTxt: async () => [] }, out);
    expect(noTxt.signature.ok).toBe(true);
    expect(noTxt.key.anchored).toBe(false);
    expect(noTxt.ok).toBe(false);

    // Someone else re-signing changed facts with their own key: the signature checks out, the key doesn't.
    const forged = structuredClone(g);
    forged.site.contact.phone = "+1 555-000-0000";
    const { generateSigningKey } = await import("@agenticweb-dev/emitters");
    forged.proof = await signGraph(forged, await generateSigningKey());
    const bad = await cmdCheck("https://agents.bella.test", { fetchImpl: branchFetch(forged), resolveTxt: txt }, out);
    expect(bad.key.anchored).toBe(false);
    expect(bad.parity!.items.find((i) => i.value === "+1 555-000-0000")!.status).toBe("missing");
    await expect(cmdCheck("https://agents.bella.test", { fetchImpl: branchFetch(forged), resolveTxt: txt, strict: true }, out)).rejects.toThrow(/Check failed/);
  }, 60_000);

  it("uses the CI key from the environment", async () => {
    const project = new Project(dir);
    const { key } = await loadSigningKey(project);
    const fromEnv = await loadSigningKey(project, { AGENTICWEB_SIGNING_KEY: JSON.stringify(key) });
    expect(fromEnv.key.x).toBe(key.x);
    await expect(loadSigningKey(project, { AGENTICWEB_SIGNING_KEY: "nope" })).rejects.toThrow(/valid JSON/);
  });
});
