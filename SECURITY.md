# Security policy

AgenticWeb sits between AI agents and real businesses, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting instead: the repository's **Security** tab, then **Report a vulnerability**. Include steps to reproduce and the impact you see. We aim to reply within 3 working days.

## Design rules we hold ourselves to

- **Owner-only.** Public sites must pass domain verification before a build.
- **Nothing irreversible without confirmation.** Write actions need a guest confirmation, owner approval or a checkout link, as the owner configures. Pending requests expire.
- **No card data.** Payments go through checkout links or provider-managed payment protocols.
- **Secrets stay in the environment.** Config files reference environment variable names only; the CLI refuses secret-looking values.
- **Content is data.** Crawled content is wrapped and labelled as untrusted in every prompt, and the runtime tells agents to treat it as data.
- **Duplicate protection.** Write actions require an `Idempotency-Key`; per-agent limits and rate limits apply.
- **Local tools stay local.** The review UI binds to 127.0.0.1 and needs a per-session token.
- **Identity is proven, not claimed.** Only a valid Web Bot Auth signature or an owner-issued API key counts as a verified agent. Key directories are fetched from public https addresses only, signatures expire, and nonces can't be replayed.
- **The signing key stays private.** It lives in `.agenticweb/signing-key.json` (git-ignored) or the `AGENTICWEB_SIGNING_KEY` environment variable and is never published; only the public key is.
- **Same facts for everyone.** Suggested answers reach the agent branch only after they appear on the human site, and the parity report lists any fact that doesn't match.
- **Tests can't act.** `agenticweb test` simulates actions that would take effect at once or take payment, and keeps confirmation messages local.

## In scope

Bypassing ownership verification, confirmations or per-agent rules, forging a verified agent identity or an owner signature, leaking secrets or the verification token, prompt injection that makes the runtime take actions, cross-site attacks on the review UI, and denial of service with small requests.
