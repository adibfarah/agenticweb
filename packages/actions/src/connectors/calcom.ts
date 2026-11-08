import type { ActionDef } from "@agenticweb-dev/core";
import { ConnectorError, provenance, secret, type Connector, type ExecuteArgs } from "../types.ts";

/**
 * Cal.com bookings (API v2). Config:
 *   { eventTypeId: number, timeZone: "America/Los_Angeles", baseUrl?: "https://api.cal.com", apiKeyEnv?: "CALCOM_API_KEY",
 *     partySizeField?: "guests" }   // optional booking question that holds the party size
 * Availability is public; bookings need the API key.
 * Check request/response shapes against the current Cal.com v2 docs if you see errors.
 */
type Slot = { start: string };

function base(config: Record<string, unknown>) {
  return String(config.baseUrl ?? "https://api.cal.com").replace(/\/$/, "");
}

async function slotsFor(a: ExecuteArgs, date: string): Promise<Slot[]> {
  const url = new URL(`${base(a.config)}/v2/slots`);
  url.searchParams.set("eventTypeId", String(a.config.eventTypeId));
  url.searchParams.set("start", date);
  url.searchParams.set("end", date);
  if (a.config.timeZone) url.searchParams.set("timeZone", String(a.config.timeZone));
  const res = await a.fetch(url, { headers: { "cal-api-version": "2024-09-04" } });
  if (!res.ok) throw new ConnectorError(`Couldn't read availability from the booking system (HTTP ${res.status}).`);
  const body = (await res.json()) as { data?: Record<string, Slot[]> };
  return body.data?.[date] ?? [];
}

/** "2026-12-04T19:30:00.000-08:00" → "19:30" (time in the event's own time zone). */
const localTime = (iso: string) => iso.slice(11, 16);

async function findSlot(a: ExecuteArgs): Promise<{ slot?: Slot; available: string[] }> {
  const date = String(a.input.date);
  const time = String(a.input.time);
  const slots = await slotsFor(a, date);
  return { slot: slots.find((s) => localTime(s.start) === time), available: slots.map((s) => localTime(s.start)) };
}

export const calcom: Connector = {
  id: "calcom",

  async sync(config, { siteUrl }) {
    const common = { backend: { type: "calcom", config, operation: "" }, limits: { perAgentPerHour: 30 }, enabled: false, source: provenance(siteUrl) };
    const actions: ActionDef[] = [
      {
        ...common,
        name: "check_availability",
        description: "List the free booking times on a date.",
        kind: "read",
        input: [{ name: "date", type: "date", description: "Date (YYYY-MM-DD)", required: true }],
        backend: { ...common.backend, operation: "check_availability" },
        confirmation: "none",
      },
      {
        ...common,
        name: "request_booking",
        description: "Book a time slot. The guest confirms by email before the booking is made.",
        kind: "write",
        input: [
          { name: "date", type: "date", description: "Date (YYYY-MM-DD)", required: true },
          { name: "time", type: "time", description: "Start time (HH:MM, local time)", required: true },
          { name: "party_size", type: "integer", description: "Number of people", required: false, min: 1, max: Number(config.maxPartySize ?? 12) },
          { name: "name", type: "string", description: "Guest name", required: true },
          { name: "email", type: "email", description: "Guest email (for confirmation)", required: true },
          { name: "phone", type: "phone", description: "Guest phone", required: false },
          { name: "notes", type: "string", description: "Notes for the business", required: false, max: 500 },
        ],
        backend: { ...common.backend, operation: "create_booking" },
        confirmation: "guest",
        idempotency: "required",
        limits: { perAgentPerHour: 10 },
      },
    ];
    return { entities: [], actions };
  },

  async check(a) {
    if (a.operation !== "create_booking") return { ok: true };
    const { slot, available } = await findSlot(a);
    if (slot) return { ok: true };
    return { ok: false, message: available.length ? `${a.input.time} isn't available on ${a.input.date}. Free times: ${available.join(", ")}.` : `Nothing is available on ${a.input.date}.` };
  },

  async execute(a) {
    if (a.operation === "check_availability") {
      const slots = await slotsFor(a, String(a.input.date));
      const times = slots.map((s) => localTime(s.start));
      return { status: "done", message: times.length ? `Free times on ${a.input.date}: ${times.join(", ")}.` : `Nothing is available on ${a.input.date}.`, data: { date: a.input.date, times } };
    }
    if (a.operation !== "create_booking") throw new ConnectorError(`Unknown Cal.com operation ${a.operation}`);
    const key = secret(a.env, a.config.apiKeyEnv ?? "CALCOM_API_KEY", "Cal.com");
    const { slot, available } = await findSlot(a);
    if (!slot) return { status: "rejected", message: `That time was just taken. Free times: ${available.join(", ") || "none"}.` };
    const responses: Record<string, unknown> = {};
    if (a.config.partySizeField && a.input.party_size) responses[String(a.config.partySizeField)] = a.input.party_size;
    if (a.input.notes) responses.notes = a.input.notes;
    const res = await a.fetch(`${base(a.config)}/v2/bookings`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "cal-api-version": "2024-08-13", "content-type": "application/json" },
      body: JSON.stringify({
        start: new Date(slot.start).toISOString(),
        eventTypeId: Number(a.config.eventTypeId),
        attendee: { name: a.input.name, email: a.input.email, timeZone: a.config.timeZone ?? "UTC", ...(a.input.phone ? { phoneNumber: a.input.phone } : {}) },
        ...(Object.keys(responses).length ? { bookingFieldsResponses: responses } : {}),
        metadata: { source: "agenticweb", ...(a.input.party_size ? { party_size: String(a.input.party_size) } : {}) },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { uid?: string }; error?: { message?: string } };
    if (!res.ok) return { status: res.status === 409 ? "rejected" : "failed", message: `The booking system said: ${body.error?.message ?? `HTTP ${res.status}`}` };
    return { status: "done", message: `Booked for ${a.input.date} at ${a.input.time}${a.input.party_size ? ` for ${a.input.party_size}` : ""}.`, data: { booking_id: body.data?.uid } };
  },
};
