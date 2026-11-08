/**
 * Web Bot Auth: tells which agent operator signed a request (IETF draft web-bot-auth, on HTTP Message Signatures,
 * RFC 9421). The agent sends Signature-Agent (where its keys live), Signature-Input and Signature. We fetch its
 * public keys from /.well-known/http-message-signatures-directory and check the Ed25519 signature.
 *
 * Runs on Web Crypto only, so it works in Node 22+, Cloudflare Workers and Deno.
 */

export const KEY_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const BOT_AUTH_TAG = "web-bot-auth";

export type BotAuthResult =
  | { ok: true; agent: string; signatureAgent: string; keyid: string }
  | { ok: false; reason: string }
  /** No signature on the request. */
  | undefined;

export type Jwk = { kty: string; crv?: string; x?: string; kid?: string; [k: string]: unknown };

export type BotAuthOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Seconds of clock difference allowed. */
  skewSeconds?: number;
  /** Longest signature lifetime accepted, in seconds. */
  maxLifetimeSeconds?: number;
  /** Who may host key directories. Defaults to public https addresses only. */
  allowDirectory?: (url: string) => boolean;
};

// ---------------------------------------------------------------------------------------------------------
// Structured field parsing (RFC 8941), just what Signature-Input and Signature need.

type Item = { value: string | number | boolean | Uint8Array; params: Record<string, string | number | boolean> };
type Member = { raw: string; inner?: Item[]; item?: Item; params: Record<string, string | number | boolean> };

class Parser {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  ws() {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }
  peek() {
    return this.s[this.i];
  }
  key(): string {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`bad key at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  bare(): string | number | boolean | Uint8Array {
    const c = this.peek();
    if (c === '"') {
      let out = "";
      this.i++;
      while (this.i < this.s.length) {
        const ch = this.s[this.i++]!;
        if (ch === "\\") out += this.s[this.i++];
        else if (ch === '"') return out;
        else out += ch;
      }
      throw new Error("unterminated string");
    }
    if (c === ":") {
      const end = this.s.indexOf(":", this.i + 1);
      if (end < 0) throw new Error("unterminated byte sequence");
      const b64 = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return Uint8Array.from(atob(b64), (x) => x.charCodeAt(0));
    }
    if (c === "?") {
      this.i += 2;
      return this.s[this.i - 1] === "1";
    }
    const num = /^-?\d+(\.\d+)?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const tok = /^[A-Za-z*][A-Za-z0-9:/!#$%&'*+\-.^_`|~]*/.exec(this.s.slice(this.i));
    if (tok) {
      this.i += tok[0].length;
      return tok[0];
    }
    throw new Error(`bad value at ${this.i}`);
  }
  params(): Record<string, string | number | boolean> {
    const p: Record<string, string | number | boolean> = {};
    while (this.peek() === ";") {
      this.i++;
      this.ws();
      const k = this.key();
      if (this.peek() === "=") {
        this.i++;
        const v = this.bare();
        p[k] = v instanceof Uint8Array ? "" : v;
      } else p[k] = true;
    }
    return p;
  }
  item(): Item {
    const value = this.bare();
    return { value, params: this.params() };
  }
  dictionary(): Record<string, Member> {
    const out: Record<string, Member> = {};
    this.ws();
    while (this.i < this.s.length) {
      const k = this.key();
      let m: Member;
      if (this.peek() === "=") {
        this.i++;
        const start = this.i;
        if (this.peek() === "(") {
          this.i++;
          const inner: Item[] = [];
          this.ws();
          while (this.peek() !== ")") {
            if (this.i >= this.s.length) throw new Error("unterminated inner list");
            inner.push(this.item());
            this.ws();
          }
          this.i++;
          const params = this.params();
          m = { raw: this.s.slice(start, this.i), inner, params };
        } else {
          const item = this.item();
          m = { raw: this.s.slice(start, this.i), item, params: item.params };
        }
      } else {
        const params = this.params();
        m = { raw: "?1", item: { value: true, params }, params };
      }
      out[k] = m;
      this.ws();
      if (this.i >= this.s.length) break;
      if (this.peek() !== ",") throw new Error(`expected , at ${this.i}`);
      this.i++;
      this.ws();
    }
    return out;
  }
}

export function parseDictionary(header: string): Record<string, Member> {
  return new Parser(header.trim()).dictionary();
}

// ---------------------------------------------------------------------------------------------------------
// Keys

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** RFC 7638 JWK thumbprint (SHA-256, base64url) of an Ed25519 key, as Web Bot Auth uses for keyid. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

function publicHttps(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
  return !(/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("["));
}

/** Where an agent's keys are: the Signature-Agent URL, or its well-known path when only an origin is given. */
export function directoryUrl(signatureAgent: string): string {
  const u = new URL(signatureAgent);
  if (u.pathname === "/" || u.pathname === "") u.pathname = KEY_DIRECTORY_PATH;
  return u.href;
}

// ---------------------------------------------------------------------------------------------------------
// Signature base (RFC 9421 section 2.5)

type SignedMessage = { method: string; headers: Headers };

function componentValue(name: string, req: SignedMessage, url: URL): string | undefined {
  switch (name) {
    case "@method":
      return req.method.toUpperCase();
    case "@authority":
      return url.host.toLowerCase();
    case "@scheme":
      return url.protocol.replace(":", "").toLowerCase();
    case "@target-uri":
      return url.href;
    case "@path":
      return url.pathname || "/";
    case "@query":
      return url.search || "?";
    case "@request-target":
      return `${url.pathname}${url.search}`;
    default: {
      if (name.startsWith("@")) return undefined; // unsupported derived component
      const v = req.headers.get(name);
      return v === null ? undefined : v.trim();
    }
  }
}

export function signatureBase(req: SignedMessage, member: Member, url: URL): string {
  const lines: string[] = [];
  for (const c of member.inner ?? []) {
    const name = String(c.value).toLowerCase();
    const extra = Object.keys(c.params).filter((k) => k !== "key");
    if (extra.length) throw new Error(`component parameter ${extra[0]} isn't supported (${name})`);
    let v: string | undefined;
    let id = `"${name}"`;
    if (typeof c.params.key === "string") {
      // One member of a dictionary header, e.g. "signature-agent";key="sig1".
      const raw = req.headers.get(name);
      v = raw ? parseDictionary(raw)[c.params.key]?.raw : undefined;
      id += `;key="${c.params.key}"`;
    } else v = componentValue(name, req, url);
    if (v === undefined) throw new Error(`missing component ${name}`);
    lines.push(`${id}: ${v}`);
  }
  lines.push(`"@signature-params": ${member.raw}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// Verifier

/**
 * Checks Web Bot Auth signatures. Keeps fetched key directories for an hour and refuses a nonce it has seen
 * while the signature is still valid.
 */
export class BotAuthVerifier {
  private dirs = new Map<string, { keys: Jwk[]; at: number }>();
  private nonces = new Map<string, number>();
  private o: Required<Omit<BotAuthOptions, "fetch">> & { fetch?: typeof fetch };

  constructor(opts: BotAuthOptions = {}) {
    this.o = {
      fetch: opts.fetch,
      now: opts.now ?? (() => Date.now()),
      skewSeconds: opts.skewSeconds ?? 60,
      maxLifetimeSeconds: opts.maxLifetimeSeconds ?? 3600,
      allowDirectory: opts.allowDirectory ?? publicHttps,
    };
  }

  /** Puts keys in the cache, e.g. for agents the owner trusts without a fetch, or in tests. */
  addDirectory(signatureAgent: string, keys: Jwk[]) {
    this.dirs.set(directoryUrl(signatureAgent), { keys, at: Infinity });
  }

  private async keys(signatureAgent: string, exact = false): Promise<Jwk[]> {
    const url = exact ? new URL(signatureAgent).href : directoryUrl(signatureAgent);
    const hit = this.dirs.get(url);
    if (hit && this.o.now() - hit.at < 3_600_000) return hit.keys;
    if (!this.o.allowDirectory(url)) throw new Error("the key directory must be a public https URL");
    const f = this.o.fetch ?? fetch;
    const res = await f(url, { headers: { accept: "application/http-message-signatures-directory+json, application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!res.ok) throw new Error(`key directory returned HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = (body.keys ?? []).filter((k) => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
    this.dirs.set(url, { keys, at: this.o.now() });
    if (this.dirs.size > 500) this.dirs.delete(this.dirs.keys().next().value!);
    return keys;
  }

  /**
   * @param url The URL the agent signed. Pass it when a proxy changed the request URL (edge mode).
   */
  async verify(req: Request, url = new URL(req.url)): Promise<BotAuthResult> {
    const inputHeader = req.headers.get("signature-input");
    const sigHeader = req.headers.get("signature");
    if (!inputHeader || !sigHeader) return undefined;
    try {
      const inputs = parseDictionary(inputHeader);
      const sigs = parseDictionary(sigHeader);
      const label = Object.keys(inputs).find((l) => inputs[l]!.params.tag === BOT_AUTH_TAG);
      if (!label) return { ok: false, reason: `no signature with tag="${BOT_AUTH_TAG}"` };
      const input = inputs[label]!;
      const sigValue = sigs[label]?.item?.value;
      if (!(sigValue instanceof Uint8Array)) return { ok: false, reason: `no Signature for ${label}` };
      const p = input.params;
      if (p.alg !== undefined && p.alg !== "ed25519") return { ok: false, reason: `unsupported alg ${String(p.alg)}` };
      const created = Number(p.created);
      const expires = Number(p.expires);
      const now = Math.floor(this.o.now() / 1000);
      if (!Number.isFinite(created) || !Number.isFinite(expires)) return { ok: false, reason: "created and expires are required" };
      if (created > now + this.o.skewSeconds) return { ok: false, reason: "signature is from the future" };
      if (expires < now - this.o.skewSeconds) return { ok: false, reason: "signature has expired" };
      if (expires - created > this.o.maxLifetimeSeconds) return { ok: false, reason: "signature lifetime is too long" };
      const components = (input.inner ?? []).map((c) => String(c.value).toLowerCase());
      if (!components.includes("@authority") && !components.includes("@target-uri")) return { ok: false, reason: "the signature must cover @authority or @target-uri" };

      // Signature-Agent: a dictionary member per signature (sig1="https://..."), or the older quoted URL.
      const saRaw = req.headers.get("signature-agent");
      if (!saRaw) return { ok: false, reason: "Signature-Agent header is missing" };
      const saComponent = (input.inner ?? []).find((c) => String(c.value).toLowerCase() === "signature-agent");
      if (!saComponent) return { ok: false, reason: "the signature must cover signature-agent" };
      let signatureAgent: string;
      let discovery = "directory";
      const t = saRaw.trim();
      if (t.startsWith('"')) signatureAgent = String(new Parser(t).bare());
      else {
        const d = parseDictionary(t);
        const memberKey = typeof saComponent.params.key === "string" ? saComponent.params.key : label;
        const m = d[memberKey] ?? (Object.keys(d).length === 1 ? Object.values(d)[0] : undefined);
        if (typeof m?.item?.value !== "string") return { ok: false, reason: "Signature-Agent has no URL for this signature" };
        signatureAgent = m.item.value;
        if (typeof m.params.type === "string") discovery = m.params.type;
      }
      if (!signatureAgent.startsWith("https://")) return { ok: false, reason: "Signature-Agent must be an https URL" };
      if (discovery !== "directory" && discovery !== "jwks_uri") return { ok: false, reason: `Signature-Agent type ${discovery} isn't supported` };

      const keyid = String(p.keyid ?? "");
      if (!keyid) return { ok: false, reason: "keyid is required" };
      const keys = await this.keys(signatureAgent, discovery === "jwks_uri");
      let key: Jwk | undefined;
      for (const k of keys) if ((await jwkThumbprint(k)) === keyid || k.kid === keyid) key = k;
      if (!key) return { ok: false, reason: "keyid isn't in the agent's key directory" };

      const base = signatureBase({ method: req.method, headers: req.headers }, input, url);
      const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.x }, { name: "Ed25519" }, false, ["verify"]);
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, sigValue as Uint8Array<ArrayBuffer>, new TextEncoder().encode(base));
      if (!ok) return { ok: false, reason: "signature doesn't match" };

      if (typeof p.nonce === "string") {
        this.prune(now);
        const k = `${keyid}:${p.nonce}`;
        if (this.nonces.has(k)) return { ok: false, reason: "nonce was already used" };
        this.nonces.set(k, expires);
      }
      return { ok: true, agent: new URL(signatureAgent).hostname.replace(/^www\./, ""), signatureAgent, keyid };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  private prune(now: number) {
    if (this.nonces.size < 5000) return;
    for (const [k, exp] of this.nonces) if (exp < now - this.o.skewSeconds) this.nonces.delete(k);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Signing, for agents (and tests): what an agent operator would do.

export async function signRequest(
  req: Request,
  opts: {
    privateKey: CryptoKey;
    jwk: Jwk;
    signatureAgent: string;
    /** "dictionary" (current draft: sig1="https://...", covered as "signature-agent";key="sig1") or "string" (older form). */
    agentHeader?: "dictionary" | "string";
    components?: string[];
    created?: number;
    expires?: number;
    nonce?: string;
    label?: string;
  },
): Promise<Request> {
  const headers = new Headers(req.headers);
  const label = opts.label ?? "sig1";
  const dict = (opts.agentHeader ?? "dictionary") === "dictionary";
  headers.set("signature-agent", dict ? `${label}="${opts.signatureAgent}"` : `"${opts.signatureAgent}"`);
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const expires = opts.expires ?? created + 60;
  const comps = opts.components ?? ["@authority", "signature-agent"];
  const keyid = await jwkThumbprint(opts.jwk);
  const nonce = opts.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(64)));
  const inner: Item[] = comps.map((c): Item => (c === "signature-agent" && dict ? { value: c, params: { key: label } } : { value: c, params: {} }));
  const raw = `(${inner.map((c) => `"${String(c.value)}"${c.params.key ? `;key="${String(c.params.key)}"` : ""}`).join(" ")});created=${created};expires=${expires};keyid="${keyid}";alg="ed25519";nonce="${nonce}";tag="${BOT_AUTH_TAG}"`;
  headers.set("signature-input", `${label}=${raw}`);
  const base = signatureBase({ method: req.method, headers }, { raw, inner, params: {} }, new URL(req.url));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, opts.privateKey, new TextEncoder().encode(base));
  headers.set("signature", `${label}=:${btoa(String.fromCharCode(...new Uint8Array(sig)))}:`);
  return new Request(req, { headers });
}
