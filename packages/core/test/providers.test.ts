import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProjectConfig, extractJson, jsonSchemaOf, resolveLlm } from "../src/index.ts";

const llm = (over: Record<string, unknown>) => ProjectConfig.parse({ site: "https://x.test", llm: over }).llm;

/** A fake Chat Completions API: records requests and replies with the queued answers. */
function fakeApi(replies: string[]) {
  const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    const content = replies.shift() ?? "{}";
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }) as typeof fetch;
  return { f, requests };
}

describe("AI providers", () => {
  it("picks the provider, its key and a model", () => {
    expect(resolveLlm(llm({}), {})).toBeUndefined();
    expect(resolveLlm(llm({}), { ANTHROPIC_API_KEY: "k" })).toMatchObject({ provider: "anthropic", label: "Claude" });
    const ds = resolveLlm(llm({ provider: "deepseek" }), { DEEPSEEK_API_KEY: "k" })!;
    expect(ds).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com", jsonMode: "object" });
    // The per-step defaults name Claude models; other providers swap in their own.
    expect(ds.model("claude-opus-5-5")).toBe("deepseek-flash");
    expect(ds.model("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(resolveLlm(llm({ provider: "openai", model: "my-model" }), { OPENAI_API_KEY: "k" })!.model("claude-opus-5-5")).toBe("my-model");
    expect(resolveLlm(llm({ provider: "gemini", apiKeyEnv: "MY_GEMINI" }), { MY_GEMINI: "k" })!.apiKey).toBe("k");
    // A local OpenAI-compatible server needs no key, but needs an address and a model.
    const local = resolveLlm(llm({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" }), {})!;
    expect(local.apiKey).toBeUndefined();
    expect(() => local.model(undefined)).toThrow(/llm.model/);
    expect(resolveLlm(llm({ provider: "openai", enabled: false }), { OPENAI_API_KEY: "k" })).toBeUndefined();
  });

  it("makes JSON Schemas providers accept", () => {
    const js = jsonSchemaOf(z.object({ a: z.string(), b: z.string().nullable() })) as { $schema?: string; properties: Record<string, { type: string; nullable?: boolean }> };
    expect(js.$schema).toBeUndefined();
    expect(js.properties.b).toEqual({ type: "string", nullable: true });
  });

  const Schema = z.object({ found: z.boolean(), answer: z.string() });

  it("asks OpenAI for a JSON Schema reply with its own token limit name", async () => {
    const api = fakeApi(['{"found":true,"answer":"9pm"}']);
    const r = resolveLlm(llm({ provider: "openai" }), { OPENAI_API_KEY: "sk-test" })!;
    const out = await extractJson(r, { model: "claude-opus-5-5", system: "sys", content: "q", schema: Schema, maxTokens: 100 }, api.f);
    expect(out).toEqual({ found: true, answer: "9pm" });
    expect(api.requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(api.requests[0]!.auth).toBe("Bearer sk-test");
    expect(api.requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", max_completion_tokens: 100, response_format: { type: "json_schema" } });
  });

  it("puts the schema in the prompt for JSON-mode providers and retries a bad reply once", async () => {
    const api = fakeApi(["```json\n{\"found\":true}\n```", '{"found":false,"answer":"Not on the site."}']);
    const r = resolveLlm(llm({ provider: "deepseek" }), { DEEPSEEK_API_KEY: "k" })!;
    const out = await extractJson(r, { model: "claude-opus-5-5", system: "sys", content: "q", schema: Schema }, api.f);
    expect(out.answer).toBe("Not on the site.");
    expect(api.requests).toHaveLength(2);
    const first = api.requests[0]!.body as { response_format: unknown; max_tokens: number; messages: Array<{ content: string }> };
    expect(first.response_format).toEqual({ type: "json_object" });
    expect(first.messages[0]!.content).toContain("JSON Schema");
    expect((api.requests[1]!.body as { messages: Array<{ content: string }> }).messages.at(-1)!.content).toMatch(/doesn't match the schema/);
  });

  it("gives up with a clear error after two bad replies", async () => {
    const api = fakeApi(["nope", "still nope"]);
    const r = resolveLlm(llm({ provider: "gemini" }), { GEMINI_API_KEY: "k" })!;
    await expect(extractJson(r, { model: "m", system: "s", content: "c", schema: Schema }, api.f)).rejects.toThrow(/Gemini didn't return valid data/);
  });
});
