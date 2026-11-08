import { z } from "zod";

/**
 * AI providers AgenticWeb can use for its optional AI features (reading the site, written /ask answers,
 * readiness tests, drafted answers). Claude goes through the Anthropic SDK; everything else through the
 * OpenAI-style Chat Completions API, which OpenAI, DeepSeek, Gemini and many local servers speak.
 * Plain fetch only, so it runs in Node, Cloudflare Workers and Deno.
 */

export const PROVIDER_IDS = ["anthropic", "openai", "deepseek", "gemini", "openai-compatible"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderInfo = {
  label: string;
  baseUrl?: string;
  apiKeyEnv: string;
  /** Used when the config still names a Claude model (the defaults) or no model. Override with llm.model. */
  defaultModel: string;
  /** "schema": the API accepts a JSON Schema for the reply. "object": it only promises JSON, so the schema goes in the prompt. */
  jsonMode: "schema" | "object";
  /** Name of the reply-length limit the API expects. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
};

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: { label: "Claude", apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5-5", jsonMode: "schema", maxTokensParam: "max_tokens" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-6.1-sol", jsonMode: "schema", maxTokensParam: "max_completion_tokens" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-flash", jsonMode: "object", maxTokensParam: "max_tokens" },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3-flash-preview",
    jsonMode: "schema",
    maxTokensParam: "max_tokens",
  },
  "openai-compatible": { label: "OpenAI-compatible API", apiKeyEnv: "LLM_API_KEY", defaultModel: "", jsonMode: "object", maxTokensParam: "max_tokens" },
};

/** The llm section of agenticweb.config.json, as far as providers are concerned. */
export type LlmSettings = {
  enabled: boolean;
  provider: ProviderId;
  /** For openai-compatible (or to route a known provider through a gateway). */
  baseUrl?: string;
  /** Env var holding the API key; defaults to the provider's usual name. */
  apiKeyEnv?: string;
  /** One model for every step, overriding the per-step models. */
  model?: string;
};

export type ResolvedLlm = {
  provider: ProviderId;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  jsonMode: "schema" | "object";
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** The model to send for a step, given the model the config names for that step. */
  model: (configured?: string) => string;
};

/**
 * Picks the provider from the config and finds its key. Returns undefined when AI is off or no key is set,
 * so callers fall back to the built-in rules.
 */
export function resolveLlm(s: LlmSettings, env: Record<string, string | undefined>): ResolvedLlm | undefined {
  if (!s.enabled) return undefined;
  const info = PROVIDERS[s.provider];
  const keyEnv = s.apiKeyEnv ?? info.apiKeyEnv;
  const apiKey = env[keyEnv] || undefined;
  if (s.provider === "anthropic") {
    // The SDK also accepts an auth token or an `ant auth login` profile.
    if (!apiKey && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_PROFILE) return undefined;
  } else if (!apiKey && !(s.provider === "openai-compatible" && s.baseUrl)) {
    // A local OpenAI-compatible server (Ollama, LM Studio, vLLM) may not need a key.
    return undefined;
  }
  const baseUrl = s.baseUrl ?? info.baseUrl;
  if (s.provider === "openai-compatible" && !baseUrl) throw new Error('llm.provider is "openai-compatible": set llm.baseUrl, e.g. "http://localhost:11434/v1".');
  return {
    provider: s.provider,
    label: info.label,
    apiKey,
    baseUrl,
    jsonMode: info.jsonMode,
    maxTokensParam: info.maxTokensParam,
    model: (configured) => {
      if (s.model) return s.model;
      if (s.provider === "anthropic") return configured || info.defaultModel;
      // The per-step defaults name Claude models; other providers use their own unless the owner chose one.
      if (configured && !configured.startsWith("claude-")) return configured;
      if (!info.defaultModel) throw new Error(`Set llm.model to a model your ${info.label} serves.`);
      return info.defaultModel;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Chat Completions

export type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ChatResponse = {
  choices: Array<{ message: { content: string | null; tool_calls?: ChatToolCall[]; refusal?: string | null }; finish_reason: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function chatCompletion(r: ResolvedLlm, body: Record<string, unknown>, f: typeof fetch = fetch): Promise<ChatResponse> {
  if (!r.baseUrl) throw new Error(`${r.label} has no API address.`);
  const res = await f(`${r.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(r.apiKey ? { authorization: `Bearer ${r.apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${r.label} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as ChatResponse;
}

export const maxTokens = (r: ResolvedLlm, n: number) => ({ [r.maxTokensParam]: n });

/** A JSON Schema for a Zod schema, without the parts some providers reject ($schema, type lists). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "$schema") continue;
      if (k === "type" && Array.isArray(val)) {
        // ["string", "null"] → "string" plus nullable, which Gemini and OpenAI both understand.
        const types = val.filter((t) => t !== "null");
        out.type = types[0] ?? "string";
        if (types.length < val.length) out.nullable = true;
        continue;
      }
      out[k] = clean(val);
    }
    return out;
  };
  return clean(z.toJSONSchema(schema, { unrepresentable: "any" })) as Record<string, unknown>;
}

const parseJson = (text: string): unknown => JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));

/** Structured extraction: asks for JSON matching the schema, checks it, and asks once more if it doesn't match. */
export async function extractJson<T extends z.ZodType>(
  r: ResolvedLlm,
  args: { model: string; system: string; content: string; schema: T; maxTokens?: number },
  f: typeof fetch = fetch,
): Promise<z.infer<T>> {
  const schemaJson = jsonSchemaOf(args.schema);
  const system =
    r.jsonMode === "schema" ? args.system : `${args.system}\n\nReply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(schemaJson)}`;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: args.content },
  ];
  const format = r.jsonMode === "schema" ? { type: "json_schema", json_schema: { name: "result", schema: schemaJson, strict: false } } : { type: "json_object" };
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chatCompletion(r, { model: r.model(args.model), messages, response_format: format, ...maxTokens(r, args.maxTokens ?? 8000) }, f);
    const choice = res.choices[0];
    if (!choice) throw new Error(`${r.label} returned no answer.`);
    if (choice.message.refusal || choice.finish_reason === "content_filter") throw new Error(`${r.label} declined to process this content.`);
    const text = choice.message.content ?? "";
    let value: unknown;
    try {
      value = parseJson(text);
    } catch {
      problem = "The reply wasn't valid JSON.";
      messages.push({ role: "assistant", content: text }, { role: "user", content: `${problem} Reply with the JSON object only.` });
      continue;
    }
    const parsed = args.schema.safeParse(value);
    if (parsed.success) return parsed.data as z.infer<T>;
    problem = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    messages.push({ role: "assistant", content: text }, { role: "user", content: `That JSON doesn't match the schema (${problem}). Reply with corrected JSON only.` });
  }
  throw new Error(`${r.label} didn't return valid data: ${problem}`);
}
