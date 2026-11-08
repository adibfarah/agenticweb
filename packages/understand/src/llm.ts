import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { PROVIDERS, extractJson, resolveLlm, type LlmSettings, type ResolvedLlm } from "@agenticweb-dev/core";

/** The one thing the pipeline needs from a language model: structured extraction. */
export interface Llm {
  extract<T extends z.ZodType>(args: {
    model: string;
    system: string;
    /** Untrusted page content goes here, never in `system`. */
    content: string;
    schema: T;
    maxTokens?: number;
  }): Promise<z.infer<T>>;
  /** Optional: read a PDF (menus, price lists, brochures). */
  readDocument?<T extends z.ZodType>(args: { model: string; system: string; pdfBase64: string; instruction: string; schema: T }): Promise<z.infer<T>>;
}

export class RefusalError extends Error {}

/**
 * Claude-backed extractor.
 * - Structured outputs so every answer matches a Zod schema.
 * - Server-side refusal fallback ("default") so a policy decline is retried on the
 *   server-chosen fallback model instead of failing the build.
 * - The system prompt is cached; it is identical across pages.
 */
export class ClaudeLlm implements Llm {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
    this.client = client ?? new Anthropic();
  }

  async extract<T extends z.ZodType>(args: { model: string; system: string; content: string; schema: T; maxTokens?: number }): Promise<z.infer<T>> {
    const response = await this.client.beta.messages.parse({
      model: args.model,
      max_tokens: args.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: args.content }],
      output_config: { effort: "low", format: betaZodOutputFormat(args.schema) },
    });
    if (response.stop_reason === "refusal") {
      throw new RefusalError(`Claude declined to process this content (${response.stop_details?.category ?? "unspecified"}).`);
    }
    if (response.parsed_output == null) throw new Error(`Claude returned no parseable output (stop_reason: ${response.stop_reason}).`);
    return response.parsed_output as z.infer<T>;
  }

  async readDocument<T extends z.ZodType>(args: { model: string; system: string; pdfBase64: string; instruction: string; schema: T }): Promise<z.infer<T>> {
    // Long documents can produce long transcriptions, so stream and wait for the final message.
    const stream = this.client.beta.messages.stream({
      model: args.model,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: args.pdfBase64 } },
            { type: "text", text: args.instruction },
          ],
        },
      ],
      output_config: { effort: "low", format: betaZodOutputFormat(args.schema) },
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new RefusalError("Claude declined to read this document.");
    if (message.parsed_output == null) throw new Error(`Claude returned no parseable output (stop_reason: ${message.stop_reason}).`);
    return message.parsed_output as z.infer<T>;
  }
}

/** True when some Anthropic credential source is likely configured. */
export function hasClaudeCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}

/** OpenAI, DeepSeek, Gemini or any OpenAI-compatible API, through Chat Completions. PDFs aren't read with these. */
export class ChatCompletionsLlm implements Llm {
  readonly r: ResolvedLlm;
  private f?: typeof fetch;
  constructor(r: ResolvedLlm, f?: typeof fetch) {
    this.r = r;
    this.f = f;
  }

  extract<T extends z.ZodType>(args: { model: string; system: string; content: string; schema: T; maxTokens?: number }): Promise<z.infer<T>> {
    return extractJson(this.r, args, this.f);
  }
}

/**
 * The AI the config asks for, if its key is set: Claude through the Anthropic SDK, anything else through
 * Chat Completions. Undefined means "use the built-in rules".
 */
export function llmFromSettings(s: LlmSettings, env: Record<string, string | undefined> = process.env, f?: typeof fetch): { llm: Llm; label: string; resolved: ResolvedLlm } | undefined {
  const r = resolveLlm(s, env);
  if (!r) return undefined;
  if (r.provider === "anthropic") {
    const claude = new ClaudeLlm(r.apiKey ? new Anthropic({ apiKey: r.apiKey }) : undefined);
    // Map the step's model like other providers do, so llm.model applies to Claude too.
    const llm: Llm = {
      extract: (a) => claude.extract({ ...a, model: r.model(a.model) }),
      readDocument: (a) => claude.readDocument({ ...a, model: r.model(a.model) }),
    };
    return { llm, label: r.label, resolved: r };
  }
  return { llm: new ChatCompletionsLlm(r, f), label: r.label, resolved: r };
}

/** The env var an owner should set for the configured provider. */
export const apiKeyEnvFor = (s: Pick<LlmSettings, "provider" | "apiKeyEnv">) => s.apiKeyEnv ?? PROVIDERS[s.provider].apiKeyEnv;
