import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import type { Ownership } from "@agenticweb-dev/core";

export const VERIFY_PREFIX = "agenticweb-verify=";
export const VERIFY_PATH = "/.well-known/agenticweb-verify.txt";

export const newVerifyToken = (): string => randomBytes(12).toString("hex");

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost|.+\.test)$/i;

export function isLocalHost(url: string): boolean {
  return LOCAL.test(new URL(url).hostname);
}

export type VerifyDeps = {
  resolveTxt?: (host: string) => Promise<string[][]>;
  fetchImpl?: typeof fetch;
};

/**
 * Checks that the person running AgenticWeb controls the site.
 * Accepts a DNS TXT record `agenticweb-verify=<token>` or a file at /.well-known/agenticweb-verify.txt.
 * Local development hosts are allowed without verification.
 */
export async function verifyOwnership(siteUrl: string, token: string, deps: VerifyDeps = {}): Promise<Ownership & { instructions?: string }> {
  const u = new URL(siteUrl);
  if (isLocalHost(siteUrl)) return { verified: true, method: "skipped-local", token, verifiedAt: new Date().toISOString() };

  const resolver = deps.resolveTxt ?? resolveTxt;
  for (const host of [u.hostname, u.hostname.replace(/^www\./, "")]) {
    try {
      const records = (await resolver(host)).map((r) => r.join(""));
      if (records.includes(VERIFY_PREFIX + token)) return { verified: true, method: "dns-txt", token, verifiedAt: new Date().toISOString() };
    } catch {
      // No TXT records; try the file method.
    }
  }
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${u.origin}${VERIFY_PATH}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok && (await res.text()).trim() === token) return { verified: true, method: "well-known-file", token, verifiedAt: new Date().toISOString() };
  } catch {
    // Not reachable.
  }
  return {
    verified: false,
    token,
    instructions: `Prove you own ${u.hostname} with one of:\n  1. DNS TXT record on ${u.hostname}:  ${VERIFY_PREFIX}${token}\n  2. A file at ${u.origin}${VERIFY_PATH} containing:  ${token}`,
  };
}
