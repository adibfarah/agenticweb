import type { ActionDef } from "@agenticweb-dev/core";
import type { ActionEngine, ActionResult, CallContext } from "./engine.ts";

/**
 * Per-agent permissions. Reading the site is always open (it is public content); rules decide which actions a
 * caller may use and how fast it may call.
 *
 * Rule keys, most specific first:
 * - an agent's signing domain from Web Bot Auth (e.g. "chatgpt.com"; "openai.com" also covers "x.openai.com"),
 *   or an agent name from an owner-issued API key. Only verified callers match these.
 * - "verified": any caller with a valid Web Bot Auth signature or API key.
 * - "unverified": everyone else. A user agent string alone never counts as verified.
 */
export type AgentRule = {
  /** "all" enabled actions, only "read" actions, "none", or a list of action names. */
  actions?: "all" | "read" | "none" | string[];
  /** Requests per minute for this kind of caller (verified callers are counted per agent, others per IP). */
  requestsPerMinute?: number;
};
export type AgentRules = Record<string, AgentRule>;

export type Caller = { agent: string; verifiedBy?: "web-bot-auth" | "api-key" };

export function ruleFor(rules: AgentRules | undefined, caller: Caller): { key: string; rule: AgentRule } | undefined {
  if (!rules || !Object.keys(rules).length) return undefined;
  if (caller.verifiedBy) {
    const parts = caller.agent.toLowerCase().split(".");
    for (let i = 0; i < Math.max(1, parts.length - 1); i++) {
      const k = parts.slice(i).join(".");
      if (k !== "verified" && k !== "unverified" && rules[k]) return { key: k, rule: rules[k]! };
    }
    if (rules.verified) return { key: "verified", rule: rules.verified };
  }
  if (rules.unverified) return { key: "unverified", rule: rules.unverified };
  return undefined;
}

export function allows(rule: AgentRule | undefined, action: ActionDef): boolean {
  const a = rule?.actions ?? "all";
  if (a === "all") return true;
  if (a === "none") return false;
  if (a === "read") return action.kind === "read";
  return a.includes(action.name);
}

/** Who can use an action, in words, for the refusal message and the manifest. */
export function whoMay(rules: AgentRules | undefined, action: ActionDef): string[] {
  if (!rules || !Object.keys(rules).length) return ["everyone"];
  const out = Object.entries(rules)
    .filter(([, r]) => allows(r, action))
    .map(([k]) => (k === "verified" ? "verified agents" : k === "unverified" ? "everyone" : k));
  if (!rules.unverified && !out.includes("everyone")) {
    // No rule for unverified callers means they keep the default (all actions).
    out.push("everyone");
  }
  return out;
}

/** An engine that applies the rules: callers only see and use the actions they're allowed. */
export function policyEngine(engine: ActionEngine, rules: AgentRules | undefined) {
  const callerOf = (ctx: CallContext): Caller => ({ agent: ctx.agent, verifiedBy: ctx.agentVerifiedBy });
  const actionsFor = (ctx: CallContext) => {
    const r = ruleFor(rules, callerOf(ctx))?.rule;
    return engine.actions().filter((a) => allows(r, a));
  };
  const wrapped: ActionEngine & { actionsFor: typeof actionsFor; forCaller: (ctx: CallContext) => ActionEngine } = {
    actions: () => engine.actions(),
    actionsFor,
    status: (id) => engine.status(id),
    confirm: (t, d) => engine.confirm(t, d),
    describe: (t) => engine.describe(t),
    async call(name, input, ctx): Promise<ActionResult> {
      const a = engine.actions().find((x) => x.name === name);
      if (a && !allows(ruleFor(rules, callerOf(ctx))?.rule, a)) {
        const who = whoMay(rules, a).filter((w) => w !== "everyone");
        return {
          status: "rejected",
          final: true,
          message: `This agent isn't allowed to use ${name} on this site.${who.length ? ` It's open to: ${who.join(", ")}. Sign your requests with Web Bot Auth, or ask the site owner for an API key.` : ""}`,
        };
      }
      return engine.call(name, input, ctx);
    },
    forCaller: (ctx) => ({ ...wrapped, actions: () => actionsFor(ctx) }),
  };
  return wrapped;
}
