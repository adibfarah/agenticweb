export type Notice = {
  to: string;
  kind: "confirm_guest" | "confirm_owner" | "result" | "event";
  subject: string;
  /** Plain-text body. Links are included as plain URLs. */
  text: string;
  link?: string;
  data?: Record<string, unknown>;
};

export interface Notifier {
  send(n: Notice): Promise<void>;
}

/** Collects notices in memory (tests) and optionally hands each one to a callback (e.g. append to a file). */
export class OutboxNotifier implements Notifier {
  readonly sent: Notice[] = [];
  private sink?: (n: Notice) => Promise<void> | void;
  constructor(sink?: (n: Notice) => Promise<void> | void) {
    this.sink = sink;
  }
  async send(n: Notice) {
    this.sent.push(n);
    await this.sink?.(n);
  }
}

/** Sends email through Resend (https://resend.com). Needs an API key and a verified sender. */
export class ResendNotifier implements Notifier {
  private apiKey: string;
  private from: string;
  private f: typeof fetch;
  constructor(apiKey: string, from: string, f: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.from = from;
    this.f = f;
  }
  async send(n: Notice) {
    if (!n.to.includes("@")) return; // Email only; phone numbers go through the webhook.
    const html = `<div style="font:15px/1.5 system-ui,sans-serif">${n.text
      .split("\n")
      .map((l) => (/^https?:\/\//.test(l) ? `<p><a href="${l}" style="background:#1f5eff;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open</a></p>` : `<p>${l.replace(/</g, "&lt;")}</p>`))
      .join("")}</div>`;
    const res = await this.f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [n.to], subject: n.subject, text: n.text, html }),
    });
    if (!res.ok) throw new Error(`Email failed (${res.status}): ${await res.text()}`);
  }
}

/** POSTs every notice as JSON, so owners can route it to Slack, SMS, a CRM, or Zapier. */
export class WebhookNotifier implements Notifier {
  private url: string;
  private f: typeof fetch;
  constructor(url: string, f: typeof fetch = fetch) {
    this.url = url;
    this.f = f;
  }
  async send(n: Notice) {
    await this.f(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "agenticweb", ...n }) });
  }
}

export class MultiNotifier implements Notifier {
  private list: Notifier[];
  constructor(list: Notifier[]) {
    this.list = list;
  }
  async send(n: Notice) {
    const results = await Promise.allSettled(this.list.map((x) => x.send(n)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length && failed.length) throw (failed[0] as PromiseRejectedResult).reason;
  }
}
