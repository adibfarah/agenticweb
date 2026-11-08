import { validateInput, type ActionDef, type SiteGraph } from "@agenticweb-dev/core";
import type { ActionEngine, ActionResult, CallContext } from "@agenticweb-dev/runtime";
import type { ActionRecord, ActionStore } from "./store.ts";
import type { Notifier } from "./notify.ts";
import { ConnectorError, type Connector, type Env } from "./types.ts";
import type { PaymentAdapter } from "./payments.ts";

export type EngineOptions = {
  graph: SiteGraph;
  connectors: Record<string, Connector>;
  store: ActionStore;
  notifier: Notifier;
  env?: Env;
  fetch?: typeof fetch;
  ownerContact?: string;
  holdMinutes?: number;
  now?: () => Date;
  /** Called for every audit event (Phase 4 analytics). */
  onEvent?: (rec: ActionRecord, event: string) => void;
  /** Agentic payment protocol adapters, keyed by the name used in backend.config.paymentAdapter. */
  payments?: Record<string, PaymentAdapter>;
};

const randomId = (prefix: string, bytes = 12) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Hides most of an email or phone number in agent-facing messages. */
export function maskContact(c: string): string {
  if (c.includes("@")) {
    const [user, domain] = c.split("@");
    return `${user!.slice(0, 1)}***@${domain}`;
  }
  return c.length > 4 ? `***${c.slice(-4)}` : "***";
}

/**
 * Runs owner-approved actions safely:
 * input validation → idempotency → per-agent limits → pre-check → confirmation (guest/owner) or checkout link → backend.
 * Nothing that changes the real world happens before the configured confirmation.
 */
export class Engine implements ActionEngine {
  private o: Required<Pick<EngineOptions, "env" | "holdMinutes" | "now">> & EngineOptions;

  constructor(opts: EngineOptions) {
    this.o = { ...opts, env: opts.env ?? {}, holdMinutes: opts.holdMinutes ?? 15, now: opts.now ?? (() => new Date()) };
  }

  actions(): ActionDef[] {
    return this.o.graph.actions.filter((a) => a.enabled && this.o.connectors[a.backend.type]);
  }

  private get f() {
    return this.o.fetch ?? fetch;
  }

  private async record(rec: ActionRecord, event: string, detail?: string) {
    rec.updatedAt = this.o.now().toISOString();
    rec.history.push({ at: rec.updatedAt, event, ...(detail ? { detail } : {}) });
    await this.o.store.put(rec);
    this.o.onEvent?.(rec, event);
  }

  async call(name: string, rawInput: unknown, ctx: CallContext): Promise<ActionResult> {
    const action = this.actions().find((a) => a.name === name);
    if (!action) return { status: "rejected", final: true, message: `Action "${name}" is not available.` };
    const connector = this.o.connectors[action.backend.type]!;

    const v = validateInput(action.input, rawInput);
    if (!v.ok) return { status: "rejected", final: true, message: "The input needs fixing.", errors: v.errors };
    const input = v.value;

    const changes = action.kind !== "read";
    if (changes && action.idempotency === "required" && !ctx.idempotencyKey) {
      return { status: "rejected", final: true, message: "Send an Idempotency-Key header (a unique value per attempt) so retries can't create duplicates.", errors: ["Idempotency-Key header is required"] };
    }
    if (changes && ctx.idempotencyKey) {
      const prev = await this.o.store.byIdempotency(name, ctx.idempotencyKey);
      if (prev) return { ...prev.result, message: `${prev.result.message} (repeat of an earlier request)` };
    }
    if (action.limits.perAgentPerHour) {
      const since = new Date(this.o.now().getTime() - 3_600_000).toISOString();
      if ((await this.o.store.countSince(name, ctx.agent, since)) >= action.limits.perAgentPerHour) {
        return { status: "rejected", final: true, message: "Too many requests for this action. Try again later." };
      }
    }

    const now = this.o.now();
    const rec: ActionRecord = {
      id: randomId("act_"),
      action: name,
      input,
      agent: ctx.agent,
      ...(ctx.agentVerifiedBy ? { agentVerifiedBy: ctx.agentVerifiedBy } : {}),
      ip: ctx.ip,
      idempotencyKey: ctx.idempotencyKey,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      result: { status: "pending_confirmation", final: false, message: "" },
      history: [],
    };
    const args = { operation: action.backend.operation, input, config: action.backend.config, env: this.o.env, fetch: this.f };

    // Reads, no-confirmation actions and checkout links run straight away: they don't commit anyone to anything
    // (a checkout link still needs the person to pay).
    if (!changes || action.confirmation === "none" || action.confirmation === "checkout_link") {
      rec.result = await this.execute(connector, args, rec.id);
      await this.record(rec, `executed:${rec.result.status}`);
      return rec.result;
    }

    if (action.confirmation === "payment_protocol") {
      const adapter = this.o.payments?.[String(action.backend.config.paymentAdapter ?? "")];
      if (!adapter) {
        rec.result = { id: rec.id, status: "failed", final: true, message: "Agent payments aren't set up for this action yet. Ask the site owner to switch it to a checkout link." };
        await this.record(rec, "unsupported:payment_protocol");
        return rec.result;
      }
      try {
        const r = await adapter.pay({ action: name, input, credential: ctx.paymentCredential, agent: ctx.agent, idempotencyKey: ctx.idempotencyKey });
        rec.result = { id: rec.id, final: true, ...r };
      } catch (err) {
        rec.result = { id: rec.id, status: "failed", final: true, message: friendly(err) };
      }
      await this.record(rec, `payment:${adapter.id}:${rec.result.status}`);
      return rec.result;
    }

    // Guest or owner confirmation.
    if (connector.check) {
      try {
        const c = await connector.check(args);
        if (!c.ok) {
          rec.result = { id: rec.id, status: "rejected", final: true, message: c.message ?? "Not possible right now." };
          await this.record(rec, "precheck:rejected", c.message);
          return rec.result;
        }
      } catch (err) {
        rec.result = { id: rec.id, status: "failed", final: true, message: friendly(err) };
        await this.record(rec, "precheck:failed", friendly(err));
        return rec.result;
      }
    }

    const who = action.confirmation === "owner" ? "owner" : "guest";
    const contact = who === "owner" ? this.o.ownerContact : contactFrom(action, input);
    if (!contact) {
      rec.result = {
        id: rec.id,
        status: "rejected",
        final: true,
        message: who === "guest" ? "Include the guest's email address (or phone) so they can confirm." : "The site owner hasn't set up where approvals go.",
        errors: who === "guest" ? ["email is required for confirmation"] : undefined,
      };
      await this.record(rec, "missing_contact");
      return rec.result;
    }

    const expires = new Date(now.getTime() + this.o.holdMinutes * 60_000);
    rec.confirmToken = randomId("", 24);
    rec.confirmBy = who;
    rec.contact = contact;
    rec.expiresAt = expires.toISOString();
    const link = `${ctx.baseUrl.replace(/\/$/, "")}/confirm/${rec.confirmToken}`;
    rec.result = {
      id: rec.id,
      status: who === "owner" ? "pending_owner" : "pending_confirmation",
      final: false,
      expires_at: rec.expiresAt,
      message:
        who === "owner"
          ? `Sent to ${this.o.graph.site.name} for approval. Check back with get_action_status.`
          : `A confirmation link was sent to ${maskContact(contact)}. Nothing is final until they confirm (within ${this.o.holdMinutes} minutes).`,
    };
    await this.record(rec, `awaiting:${who}`);
    try {
      await this.o.notifier.send({
        to: contact,
        kind: who === "owner" ? "confirm_owner" : "confirm_guest",
        subject: `${who === "owner" ? "Approve" : "Confirm"}: ${describeAction(action)} at ${this.o.graph.site.name}`,
        text: [
          `An AI agent asked to ${describeAction(action)} at ${this.o.graph.site.name}${who === "guest" ? " for you" : ""}.`,
          ...Object.entries(input).map(([k, val]) => `${label(action, k)}: ${fmt(val)}`),
          `Please confirm within ${this.o.holdMinutes} minutes:`,
          link,
          who === "guest" ? "If you didn't ask for this, ignore this message and nothing will happen." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        link,
        data: { action: name, id: rec.id },
      });
    } catch (err) {
      rec.result = { id: rec.id, status: "failed", final: true, message: "Couldn't send the confirmation message. Try again later." };
      await this.record(rec, "notify:failed", friendly(err));
    }
    return rec.result;
  }

  private async execute(connector: Connector, args: Parameters<Connector["execute"]>[0], id: string): Promise<ActionResult> {
    try {
      const r = await connector.execute(args);
      return {
        id,
        status: r.status,
        final: true,
        message: r.message,
        ...(r.checkout_url ? { checkout_url: r.checkout_url } : {}),
        ...(r.data ? { data: r.data } : {}),
      };
    } catch (err) {
      return { id, status: "failed", final: true, message: friendly(err) };
    }
  }

  async status(id: string): Promise<ActionResult | undefined> {
    const rec = await this.o.store.get(id);
    if (!rec) return undefined;
    await this.expireIfNeeded(rec);
    return rec.result;
  }

  private async expireIfNeeded(rec: ActionRecord) {
    if (!rec.result.final && rec.expiresAt && rec.expiresAt < this.o.now().toISOString()) {
      rec.result = { id: rec.id, status: "expired", final: true, message: "Nobody confirmed in time, so nothing happened." };
      await this.record(rec, "expired");
    }
  }

  async describe(token: string): Promise<{ title: string; details: Array<[string, string]>; who: "guest" | "owner" } | undefined> {
    const rec = await this.o.store.byToken(token);
    if (!rec || rec.result.final) return undefined;
    await this.expireIfNeeded(rec);
    if (rec.result.final) return undefined;
    const action = this.o.graph.actions.find((a) => a.name === rec.action);
    return {
      title: `${rec.confirmBy === "owner" ? "Approve" : "Confirm"}: ${action ? describeAction(action) : rec.action}`,
      details: [["Business", this.o.graph.site.name] as [string, string], ...Object.entries(rec.input).map(([k, v]) => [action ? label(action, k) : k, fmt(v)] as [string, string]), ["Requested by", `AI agent (${rec.agent})`]],
      who: rec.confirmBy ?? "guest",
    };
  }

  async confirm(token: string, decision: "confirm" | "reject") {
    const rec = await this.o.store.byToken(token);
    if (!rec) return { ok: false, message: "This link isn't valid." };
    await this.expireIfNeeded(rec);
    if (rec.result.final) return { ok: false, message: `This request is already ${rec.result.status.replace(/_/g, " ")}.`, result: rec.result };
    if (decision === "reject") {
      rec.result = { id: rec.id, status: "rejected", final: true, message: `${rec.confirmBy === "owner" ? "The business" : "The guest"} declined.` };
      await this.record(rec, "declined");
      return { ok: true, message: "Declined. Nothing was booked or ordered.", result: rec.result };
    }
    const action = this.o.graph.actions.find((a) => a.name === rec.action);
    const connector = action ? this.o.connectors[action.backend.type] : undefined;
    if (!action || !connector) {
      rec.result = { id: rec.id, status: "failed", final: true, message: "This action is no longer available." };
      await this.record(rec, "confirm:unavailable");
      return { ok: false, message: rec.result.message, result: rec.result };
    }
    await this.record(rec, `confirmed:${rec.confirmBy}`);
    rec.result = await this.execute(connector, { operation: action.backend.operation, input: rec.input, config: action.backend.config, env: this.o.env, fetch: this.f }, rec.id);
    await this.record(rec, `executed:${rec.result.status}`);
    if (rec.confirmBy === "owner") {
      const guest = contactFrom(action, rec.input);
      if (guest) await this.o.notifier.send({ to: guest, kind: "result", subject: `${this.o.graph.site.name}: ${rec.result.status === "done" ? "confirmed" : "update"}`, text: rec.result.message }).catch(() => {});
    }
    return { ok: rec.result.status === "done" || rec.result.status === "checkout_link", message: rec.result.message, result: rec.result };
  }
}

function contactFrom(action: ActionDef, input: Record<string, unknown>): string | undefined {
  const email = action.input.find((f) => f.type === "email" && typeof input[f.name] === "string");
  if (email) return input[email.name] as string;
  const phone = action.input.find((f) => f.type === "phone" && typeof input[f.name] === "string");
  return phone ? (input[phone.name] as string) : undefined;
}

const describeAction = (a: ActionDef) => a.name.replace(/_/g, " ");
const label = (a: ActionDef, key: string) => {
  const f = a.input.find((x) => x.name === key);
  const d = f?.description?.split("(")[0]?.trim();
  return d && d.length < 40 ? d : key.replace(/_/g, " ");
};
const fmt = (v: unknown): string => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? Object.values(x as object).join(" × ") : String(x))).join(", ") : String(v));
const friendly = (err: unknown) => (err instanceof ConnectorError ? err.message : `The booking/ordering system didn't respond as expected (${(err as Error).message}).`);
