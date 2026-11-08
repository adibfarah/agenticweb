import type { z } from "zod";
import { extractJson, resolveLlm, type LlmSettings } from "@agenticweb-dev/core";
import type { AskLlm } from "./ask.ts";

/**
 * Claude for /ask answers. Loaded lazily so the runtime works without the Anthropic SDK installed.
 * Uses structured outputs and the server-side refusal fallback, like the build pipeline.
 */
export async function createClaudeAsker(opts: { apiKey?: string } = {}): Promise<AskLlm> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { betaZodOutputFormat } = await import("@anthropic-ai/sdk/helpers/beta/zod");
  // Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
  const client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
  return {
    async extract<T extends z.ZodType>(args: { model: string; system: string; content: string; schema: T; maxTokens?: number }) {
      const r = await client.beta.messages.parse({
        model: args.model,
        max_tokens: args.maxTokens ?? 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: args.content }],
        output_config: { effort: "low", format: betaZodOutputFormat(args.schema) },
      });
      if (r.stop_reason === "refusal" || r.parsed_output == null) throw new Error(`No answer (stop_reason: ${r.stop_reason})`);
      return r.parsed_output as z.infer<T>;
    },
  };
}

/**
 * The /ask writer for the configured AI provider, or undefined when AI is off or no key is set (then /ask
 * answers from search). Claude uses the Anthropic SDK; other providers use Chat Completions over fetch.
 */
export async function askerFor(s: LlmSettings, env: Record<string, string | undefined>, f?: typeof fetch): Promise<(AskLlm & { label: string }) | undefined> {
  const r = resolveLlm(s, env);
  if (!r) return undefined;
  if (r.provider === "anthropic") {
    const claude = await createClaudeAsker({ apiKey: r.apiKey });
    return { label: r.label, extract: (a) => claude.extract({ ...a, model: r.model(a.model) }) };
  }
  return { label: r.label, extract: (a) => extractJson(r, a, f) };
}
