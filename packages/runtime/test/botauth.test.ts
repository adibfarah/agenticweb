import { describe, expect, it } from "vitest";
import { SiteGraph, type ActionDef } from "@agenticweb-dev/core";
import {
  BotAuthVerifier,
  KEY_DIRECTORY_PATH,
  createApp,
  createEdge,
  jwkThumbprint,
  parseDictionary,
  ruleFor,
  signRequest,
  type ActionEngine,
  type ActionResult,
  type CallContext,
  type Jwk,
} from "../src/index.ts";

async function agentKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  return { privateKey: pair.privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as Jwk };
}

const AGENT = "https://agent.example-bot.com";

/** A fetch that serves the agent's key directory, and counts calls. */
function directoryFetch(keys: Jwk[]) {
  const f = async (url: string | URL | Request) => {
    f.calls.push(String(url));
    if (String(url) === `${AGENT}${KEY_DIRECTORY_PATH}`) return new Response(JSON.stringify({ keys }), { headers: { "content-type": "application/http-message-signatures-directory+json" } });
    return new Response("not found", { status: 404 });
  };
  f.calls = [] as string[];
  return f as typeof f & typeof fetch;
}

describe("Web Bot Auth", () => {
  it("parses structured-field dictionaries the way RFC 9421 needs them", () => {
    const d = parseDictionary('sig1=("@authority" "signature-agent";key="sig1");created=1;keyid="abc";tag="web-bot-auth", sig2=:AAEC:');
    expect(d.sig1!.inner!.map((i) => i.value)).toEqual(["@authority", "signature-agent"]);
    expect(d.sig1!.inner![1]!.params.key).toBe("sig1");
    expect(d.sig1!.params).toMatchObject({ created: 1, keyid: "abc", tag: "web-bot-auth" });
    expect(d.sig1!.raw).toBe('("@authority" "signature-agent";key="sig1");created=1;keyid="abc";tag="web-bot-auth"');
    expect([...(d.sig2!.item!.value as Uint8Array)]).toEqual([0, 1, 2]);
  });

  it("computes the RFC 8037 thumbprint", async () => {
    // RFC 8037 appendix A.3.
    expect(await jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  for (const form of ["dictionary", "string"] as const) {
    it(`accepts a valid signature (${form} Signature-Agent)`, async () => {
      const k = await agentKeys();
      const f = directoryFetch([k.jwk]);
      const v = new BotAuthVerifier({ fetch: f });
      const req = await signRequest(new Request("https://shop.test/ask?q=hi"), { ...k, signatureAgent: AGENT, agentHeader: form });
      const r = await v.verify(req);
      expect(r).toMatchObject({ ok: true, agent: "agent.example-bot.com" });
      // The key directory is cached.
      await v.verify(await signRequest(new Request("https://shop.test/"), { ...k, signatureAgent: AGENT, agentHeader: form }));
      expect(f.calls).toHaveLength(1);
    });
  }

  it("rejects tampering, expiry, replays, unknown keys and private directories", async () => {
    const k = await agentKeys();
    const v = new BotAuthVerifier({ fetch: directoryFetch([k.jwk]) });
    const signed = await signRequest(new Request("https://shop.test/"), { ...k, signatureAgent: AGENT });

    const moved = new Request("https://other.test/", { headers: signed.headers });
    expect(await v.verify(moved)).toMatchObject({ ok: false, reason: "signature doesn't match" });

    expect(await v.verify(signed)).toMatchObject({ ok: true });
    expect(await v.verify(signed)).toMatchObject({ ok: false, reason: "nonce was already used" });

    const old = await signRequest(new Request("https://shop.test/"), { ...k, signatureAgent: AGENT, created: 1000, expires: 1060 });
    expect(await v.verify(old)).toMatchObject({ ok: false, reason: "signature has expired" });

    const other = await agentKeys();
    const stranger = await signRequest(new Request("https://shop.test/"), { ...other, signatureAgent: AGENT });
    expect(await v.verify(stranger)).toMatchObject({ ok: false, reason: expect.stringMatching(/keyid/) });

    const local = await signRequest(new Request("https://shop.test/"), { ...k, signatureAgent: "https://127.0.0.1" });
    expect(await v.verify(local)).toMatchObject({ ok: false, reason: expect.stringMatching(/public https/) });

    const noAgent = await signRequest(new Request("https://shop.test/"), { ...k, signatureAgent: AGENT, components: ["@authority"] });
    expect(await v.verify(noAgent)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature-agent/) });

    expect(await v.verify(new Request("https://shop.test/"))).toBeUndefined();
  });
});

describe("per-agent permissions", () => {
  it("matches the most specific rule, and only for verified callers", () => {
    const rules = { "example-bot.com": { actions: "all" as const }, verified: { actions: "read" as const }, unverified: { actions: "none" as const } };
    expect(ruleFor(rules, { agent: "agent.example-bot.com", verifiedBy: "web-bot-auth" })?.key).toBe("example-bot.com");
    expect(ruleFor(rules, { agent: "other.com", verifiedBy: "web-bot-auth" })?.key).toBe("verified");
    // A user agent claiming to be the bot is not verified.
    expect(ruleFor(rules, { agent: "example-bot.com" })?.key).toBe("unverified");
    expect(ruleFor({}, { agent: "x" })).toBeUndefined();
  });

  const graph = SiteGraph.parse({
    version: "agent-site/0.1",
    generatedAt: "2026-11-08T00:00:00Z",
    site: { name: "Bella", url: "https://bella.test" },
    ownership: { verified: true },
    pages: [{ slug: "home", url: "https://bella.test/", title: "Home", markdown: "Hello", hash: "h", updated: "2026-11-08T00:00:00Z", source: { via: "crawl", seen: "2026-11-08T00:00:00Z" } }],
    entities: [],
    actions: [],
    policies: {},
  });
  const booking = {
    name: "request_booking",
    description: "Book a table",
    kind: "write",
    confirmation: "guest_email",
    enabled: true,
    idempotency: "optional",
    input: [{ name: "name", type: "string", description: "", required: true }],
    backend: { type: "test", operation: "book", config: {} },
    limits: {},
    source: { via: "owner", seen: "2026-11-08T00:00:00Z" },
  } as unknown as ActionDef;
  const calls: CallContext[] = [];
  const engine: ActionEngine = {
    actions: () => [booking],
    async call(_n, _i, ctx): Promise<ActionResult> {
      calls.push(ctx);
      return { id: "act_1", status: "pending_confirmation", final: false, message: "Check your email." };
    },
    status: async () => undefined,
    confirm: async () => ({ ok: false, message: "" }),
    describe: async () => undefined,
  };

  it("lets verified agents book and keeps unverified ones to reading", async () => {
    const k = await agentKeys();
    const verifier = new BotAuthVerifier({ fetch: directoryFetch([k.jwk]) });
    const app = createApp({ graph, engine, agents: { webBotAuth: verifier, rules: { verified: { actions: "all" }, unverified: { actions: "read", requestsPerMinute: 2 } } } });
    const post = () => new Request("https://bella.test/api/request_booking", { method: "POST", body: JSON.stringify({ name: "Sam" }), headers: { "user-agent": "ClaudeBot" } });

    const anon = await app.fetch(post());
    expect(anon.status).toBe(409);
    expect(((await anon.json()) as { message: string }).message).toMatch(/verified agents/);
    expect(anon.headers.get("x-agent-identity")).toBe("unverified");

    const signed = await app.fetch(await signRequest(post(), { ...k, signatureAgent: AGENT }));
    expect(signed.status).toBe(202);
    expect(signed.headers.get("x-agent-identity")).toBe("agent.example-bot.com; verified=web-bot-auth");
    expect(calls.at(-1)).toMatchObject({ agent: "agent.example-bot.com", agentVerifiedBy: "web-bot-auth" });

    // A bad signature is reported and treated as unverified.
    const forged = await signRequest(post(), { ...k, signatureAgent: AGENT });
    const h = new Headers(forged.headers);
    h.set("signature", "sig1=:AAAA:");
    const bad = await app.fetch(new Request(forged.url, { method: "POST", headers: h, body: JSON.stringify({ name: "Sam" }) }));
    expect(bad.status).toBe(409);
    expect(bad.headers.get("x-agent-identity")).toMatch(/^unverified; reason=/);

    // The unverified rule has its own, lower rate limit.
    const third = await app.fetch(post());
    expect(third.status).toBe(429);

    // MCP shows each caller only the actions it may use; the manifest says who may use what.
    const app2 = createApp({ graph, engine, agents: { webBotAuth: verifier, rules: { verified: { actions: "all" }, unverified: { actions: "read" } } } });
    const list = async (req: Request) => ((await (await app2.fetch(req)).json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    const mcpReq = () =>
      new Request("https://bella.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(await list(mcpReq())).not.toContain("request_booking");
    const signedTools = ((await (await app2.fetch(await signRequest(mcpReq(), { ...k, signatureAgent: AGENT }))).json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(signedTools).toContain("request_booking");
    const manifest = (await (await app2.fetch(new Request("https://bella.test/.well-known/agent-site.json"))).json()) as { actions: Array<{ allowed?: string[] }>; auth: { actions: string[] } };
    expect(manifest.actions[0]!.allowed).toEqual(["verified agents"]);
    expect(manifest.auth.actions).toContain("web_bot_auth");
  });

  it("verifies the public URL the agent signed in edge mode", async () => {
    const k = await agentKeys();
    const verifier = new BotAuthVerifier({ fetch: directoryFetch([k.jwk]) });
    const edge = createEdge(
      { graph, engine, agents: { webBotAuth: verifier, rules: { verified: { actions: "all" }, unverified: { actions: "none" } } } },
      { fetchOrigin: async () => new Response("<html><head></head><body>hi</body></html>", { headers: { "content-type": "text/html" } }), publicUrl: "https://bella.test" },
    );
    const req = await signRequest(new Request("https://bella.test/.agent/api/request_booking", { method: "POST", body: JSON.stringify({ name: "Sam" }) }), {
      ...k,
      signatureAgent: AGENT,
      components: ["@authority", "@path", "signature-agent"],
    });
    const res = await edge.fetch(req);
    expect(res.status, await res.clone().text()).toBe(202);
    // A client can't pick the URL that gets checked.
    const spoof = await signRequest(new Request("https://bella.test/somewhere-else", { method: "POST" }), { ...k, signatureAgent: AGENT, components: ["@authority", "@path", "signature-agent"] });
    const h = new Headers(spoof.headers);
    h.set("x-agenticweb-signed-url", "https://bella.test/somewhere-else");
    const res2 = await edge.fetch(new Request("https://bella.test/.agent/api/request_booking", { method: "POST", headers: h, body: JSON.stringify({ name: "Sam" }) }));
    expect(res2.status).toBe(409);
  });
});
