import type { z } from "zod";
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
