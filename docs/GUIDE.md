# AgenticWeb guide

This guide covers everything from a first build to a production agent branch with actions.

## 1. Start a project

```bash
npx agenticweb-cli init https://mysite.com --name "My Business"
```

This creates `agenticweb.config.json` (commit it) and `.agenticweb/` (local state; don't commit it).

### Prove you own the site

Public sites need one of:

- a DNS TXT record on your domain: `agenticweb-verify=<token>`
- a file at `https://mysite.com/.well-known/agenticweb-verify.txt` containing `<token>`

`init` prints your token. When the record or file is in place:

```bash
npx agenticweb-cli verify
```

Local development sites (`localhost`, `127.0.0.1`, `*.test`, `*.localhost`) skip this step.

## 2. Build

```bash
npx agenticweb-cli build
```

- With an AI key set, the AI classifies pages, extracts products, menus, services and policies, and names actions. Claude also reads PDFs. Without a key, built-in rules do the job. See [Choosing an AI provider](#choosing-an-ai-provider).

### Choosing an AI provider

Claude is the default. OpenAI, DeepSeek, Gemini, or any OpenAI-compatible API (including local ones such as Ollama or LM Studio) work too. Set `llm.provider` in `agenticweb.config.json` and put the key in the matching environment variable:

| `llm.provider` | Key variable | Default model |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-6.1-sol` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| `gemini` | `GEMINI_API_KEY` | `gemini-3-flash-preview` |
| `openai-compatible` | `LLM_API_KEY` (optional for local servers) | none: set `llm.model` |

```json
"llm": { "provider": "deepseek" }
```

```json
"llm": { "provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "model": "llama4" }
```

- `llm.model` sets one model for every step. Providers release new models often, so set it if the default above is out of date.
- `llm.apiKeyEnv` uses a different variable name for the key.
- The provider is used everywhere AgenticWeb uses AI: reading the site, written `/ask` answers (locally and when deployed), `agenticweb test`, and `agenticweb suggest`.
- Only Claude reads PDFs. Other providers skip them, like the built-in rules do.
- Cost estimates in test reports are only shown for Claude models.
- Without credentials, built-in rules extract JSON-LD, opening hours, FAQs, price lists and forms.
- Rebuilds reuse the analysis of unchanged pages.

The result is in `agent-branch/`. Check `agenticweb status` for a summary.

### Crawl settings

```json
{
  "crawl": {
    "maxPages": 200,
    "include": ["/menu*", "/products/*"],
    "exclude": ["/admin/*"],
    "render": "browser"
  }
}
```

`render: "browser"` uses Playwright for sites that need JavaScript (`npm install playwright`, then `npx playwright install chromium`).

## 3. Review what agents can see and do

```bash
npx agenticweb-cli review
```

This opens a local page with five tabs: Actions, Data, Pages, Activity and Changes. You can also use the CLI:

```bash
npx agenticweb-cli hide privacy
```

```bash
npx agenticweb-cli actions
```

```bash
npx agenticweb-cli actions enable request_booking
```

Your choices are saved in `agenticweb.config.json` under `actions`, so they survive rebuilds. Only the fields you write change. For example, `{ "name": "request_booking", "enabled": true }` leaves the inputs and confirmation level as discovered.

### Confirmation levels

| Level | What happens |
|---|---|
| `none` | Runs straight away. Use only for read-only lookups. |
| `guest` | The person the agent acts for gets an email link and must confirm within `runtime.holdMinutes` (15 by default). |
| `owner` | You get an approval link (`notifications.ownerEmail`). |
| `checkout_link` | The agent gets a pre-filled checkout URL to hand back; the person reviews and pays on your checkout. |
| `payment_protocol` | Delegates to a payment-protocol adapter you register (see `packages/actions/src/payments.ts`). |

### Your own actions

Add a complete action to the config and it's created on the next build:

```json
{
  "actions": [
    {
      "name": "request_quote",
      "description": "Ask for a catering quote.",
      "kind": "write",
      "confirmation": "owner",
      "enabled": true,
      "input": [
        { "name": "event_date", "type": "date" },
        { "name": "guests", "type": "integer", "min": 10, "max": 300 },
        { "name": "email", "type": "email" }
      ],
      "backend": { "type": "http", "operation": "quote", "config": { "url": "https://api.mysite.com/quotes", "headers": { "x-api-key": "env:QUOTES_API_KEY" } } }
    }
  ]
}
```

## 4. Connect your systems

| Source | Command | Secrets (environment variables) |
|---|---|---|
| Shopify | `agenticweb connect shopify store=https://x.myshopify.com` | none |
| WooCommerce | `agenticweb connect woocommerce store=https://shop.example.com` | none |
| Cal.com | `agenticweb connect calcom eventTypeId=123 timeZone=Europe/London` | `CALCOM_API_KEY` |
| Stripe | `agenticweb connect stripe` | `STRIPE_SECRET_KEY` (a restricted key) |
| OpenAPI | `agenticweb connect openapi spec=https://api.x.com/openapi.json operations=createBooking` | per `auth.env` |

Connector data wins over crawled data, and connector actions replace form-based drafts with the same name.

### Agent checkout (UCP and ACP)

Shopping agents increasingly speak two checkout protocols: [UCP](https://ucp.dev) (Universal Commerce Protocol) and [ACP](https://developers.openai.com/commerce/specs/checkout) (Agentic Commerce Protocol). AgenticWeb speaks both for any store, not just Shopify:

| You have | What agents get |
|---|---|
| A checkout-link action turned on (Shopify, WooCommerce or Stripe connector) | **UCP.** The business profile is at `/.well-known/ucp` and checkout sessions are at `/ucp/v1/checkout-sessions`. Each session ends in `requires_escalation` with a `continue_url`: your own checkout, pre-filled, where the buyer reviews and pays. |
| An agent-payment action (`confirmation: "payment_protocol"`) with a payment adapter | **UCP and ACP.** Sessions are paid through your adapter with the delegated token the agent presents. ACP sessions are at `/acp/checkout_sessions`. |

- Item ids are the product SKUs in your data (`offers.sku`), and prices come from your connector.
- Totals cover item prices only. Tax and shipping are added on your checkout or by your payment adapter, and sessions say so.
- **ACP needs an API key.** Issue one to the agent platform through `AGENTICWEB_API_KEYS` (for example `key123:OpenAI`); calls without it get 401.
- **UCP checks who is calling.** Every request must carry a `UCP-Agent` header, and AgenticWeb fetches that platform profile (public https addresses only), as the spec requires.
- Repeated requests with the same `Idempotency-Key` get the first response, and a reused key with a different body is refused.
- In edge mode, `/.well-known/ucp` is served at the root of your domain, where UCP platforms look for it.
- WooCommerce checkout links use shareable checkout URLs (WooCommerce 10+), so one link can hold several products. On older stores, set `"checkoutLinks": "add-to-cart"` in the connector config (one product per link).

Settings in `agenticweb.config.json` (these are the defaults):

```json
{
  "commerce": { "ucp": true, "acp": true, "acpProvider": "stripe", "sessionMinutes": 60, "verifyAgentProfiles": true, "paymentHandlers": {} }
}
```

Checkout sessions are kept in the `AGENTICWEB_KV` namespace on Cloudflare and in memory on Node.

## 5. Notifications

Guest and owner confirmations need a way to reach people:

```json
{
  "notifications": {
    "email": "resend",
    "from": "Bella Cucina <bookings@bellacucina.example>",
    "ownerEmail": "owner@bellacucina.example",
    "webhookUrl": "https://hooks.zapier.com/..."
  }
}
```

- `email: "resend"` sends through [Resend](https://resend.com) using `RESEND_API_KEY`.
- `webhookUrl` receives every message as JSON (route it to SMS, Slack or a CRM).
- `email: "outbox"` (the default) writes messages to `.agenticweb/outbox.log` for local testing.

## 6. Run and deploy

There are two ways to run the agent branch:

- **Edge mode (recommended):** AgenticWeb sits in front of your site on your own domain. Nothing is installed on your site. See [Edge mode](#edge-mode) below.
- **Separate address:** the agent branch runs on its own subdomain, like `agents.mysite.com`, and you add discovery tags to your site yourself.

Locally:

```bash
npx agenticweb-cli serve
```

To production:

```bash
npx agenticweb-cli deploy --target cloudflare-worker
```

| Target | What you get |
|---|---|
| `static`, `cloudflare`, `netlify`, `vercel` | Files only: manifest, llms.txt, pages, data. No `/ask`, `/mcp` or actions. |
| `node` | `agent-server/server.mjs` with your data, for any server with Node 22+. |
| `docker` | The same plus a `Dockerfile`. Actions are stored in `/data`. |
| `cloudflare-worker` | `agent-worker/` with `wrangler.toml`. Bind a KV namespace `AGENTICWEB_KV` for confirmations. |
| `edge` | `agent-edge/`: a Worker on a route in front of your site (edge mode). |

Each runtime target writes a `.env.example` listing the variables it needs (`PUBLIC_URL`, connector keys, `RESEND_API_KEY`…).

Then tell agents where to look:

```bash
npx agenticweb-cli snippets --base-url https://agents.mysite.com
```

Paste the `<link>` tags into your site's `<head>` and the lines into `robots.txt`. (Edge mode does this for you.)

### Edge mode

Edge mode runs in front of your human site, on the same domain:

| Request | Answered by |
|---|---|
| `/llms.txt`, `/llms-full.txt`, `/.well-known/agent-site.json` | AgenticWeb |
| `/.agent/*` (pages, data, `/ask`, `/mcp`, actions) | AgenticWeb |
| Any page with `Accept: text/markdown` | AgenticWeb: the page's Markdown version |
| Everything else | Your site, unchanged, plus discovery `<link>` tags and a `Link` header |

Agents get Markdown only when they ask for it in the `Accept` header. AgenticWeb never decides by user agent, so anyone who asks for the same format gets the same content.

Try it locally:

```bash
npx agenticweb-cli serve --edge https://mysite.com
```

```bash
curl -H "Accept: text/markdown" http://127.0.0.1:8787/
```

Deploy it:

- **Domain on Cloudflare:** `npx agenticweb-cli deploy --target edge`, then `npx wrangler deploy` in `agent-edge/`. The route `mysite.com/*` is already in `wrangler.toml`. If the site is hosted somewhere the route can't reach, set `ORIGIN_URL`.
- **Any other host:** use the `node` or `docker` target and set `EDGE_ORIGIN` to your site's internal address (for example `http://localhost:8080`). Put it where your web server or load balancer sends traffic.

Settings in `agenticweb.config.json`:

```json
{
  "edge": {
    "prefix": "/.agent",
    "rootPaths": ["/llms.txt", "/llms-full.txt", "/.well-known/agent-site.json", "/.well-known/agent-card.json"],
    "markdown": true,
    "injectLinks": true,
    "robots": true
  }
}
```

Add `"/mcp"` to `rootPaths` if you want the MCP server at the root of your domain as well.

### Tools for browser agents (WebMCP)

Every build includes `webmcp.js`. When a page loads it, the AI agent in a visitor's browser (where the browser supports [WebMCP](https://webmachinelearning.github.io/webmcp/)) gets the same tools as your MCP server: site info, pages, items, search, ask and your enabled actions. Every call still goes through the agent branch, with the same checks and confirmations.

- Edge mode adds the script to every page for you (`"edge": { "webmcp": false }` turns it off).
- Otherwise, `agenticweb snippets` includes the `<script>` tag to paste into your `<head>`.
- WebMCP is still a draft and browser support is early. The script does nothing in browsers that don't support it.

## 7. Keep it fresh

- `agenticweb sync` rebuilds from the live site and prints what changed. Reports are kept in `.agenticweb/changes.jsonl` and shown in the review UI.
- `agenticweb sync --every 60` repeats it every hour.
- `agenticweb serve --sync-every 60` refreshes a running server in place.
- Set `AGENTICWEB_HOOK_SECRET` and call `POST /hooks/refresh` (header `x-agenticweb-secret`) from Shopify or WooCommerce webhooks.
- `agenticweb ci --every 6` writes a GitHub Actions workflow that rebuilds and deploys on a schedule.

## 8. See what agents do

```bash
npx agenticweb-cli activity --days 7
```

This shows requests by agent, top questions, **questions your site couldn't answer**, searches, and action completion rates. Local servers log to `.agenticweb/traffic.jsonl`; deployed servers print one JSON line per request.

### Turn unanswered questions into answers

```bash
npx agenticweb-cli suggest
```

This takes the questions agents asked that your site couldn't answer (from `/ask` and the MCP `ask` tool), plus any failed `agenticweb test` tasks, and drafts an FAQ answer for each one.

- **With an AI key**, a draft uses only facts already on your site. Anything it can't find is marked `[[fill in: …]]`, so it never guesses a price or a policy.
- **Without one**, you get the question and an empty answer to fill in.
- Open `agenticweb review` and go to the **Suggestions** tab to edit, approve or dismiss each one. You can't approve a draft that still has blanks.
- Each approved answer comes with HTML to paste into the right page: the visible FAQ entry plus matching schema.org `FAQPage` data.
- The next `build` or `sync` reads it from your site, and the suggestion shows as **live**.

Answers reach the agent branch only through your site, so people and agents always see the same thing.

## 9. Test it like an agent (Agent Readiness)

```bash
npx agenticweb-cli test --init
```

```bash
npx agenticweb-cli test
```

`--init` writes `agenticweb.tests.json` with starter tasks from what the build found. Replace them with what your customers really ask:

```json
{
  "tasks": [
    { "id": "sunday", "task": "What time do you close on Sunday?", "expect": ["21:00"] },
    { "id": "book", "task": "Book a table for 4 next Friday at 7pm for Sam Lee, sam@example.com", "action": "request_booking" }
  ]
}
```

- `expect` lists words or numbers the answer must contain. `action` names the action that finishes the task.
- **With an AI key** (any provider above), the AI does each task twice:
  - on the agent branch, using its MCP tools;
  - on your human site, reading pages.
  You get success, requests, tokens and cost for both. The model is set in `tests.model` in the config.
- **Without a key**, lookups go to `/ask`, and actions run if the task gives an `input`.
- Tests never change anything:
  - Actions that would take effect at once, or take payment, are simulated.
  - Confirmation emails stay in a local outbox.
  - With `--url <your deployed agent branch>`, only reads and checkout links are sent.
- **Score:** 80% from tasks done and 20% from the basics: llms.txt, the manifest, Markdown pages, structured data, MCP, confirmations on every action that changes something, and your site pointing agents to the agent branch.
- **Report and badge:** the report goes to `agent-readiness/report.md`. There is also a badge (`badge.svg`) and a shields.io endpoint file (`badge.json`).
- **Failing CI:** `--min 80` fails below a score. `--strict` fails when a task that passed last time fails now. The `agenticweb ci` workflow runs `test --strict` before every deploy.

## 10. Verified agents and who can do what

Agents can prove who they are by signing requests with [Web Bot Auth](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/) (HTTP Message Signatures with Ed25519). AgenticWeb checks the signature, fetches the agent's public keys from its `/.well-known/http-message-signatures-directory`, and from then on knows which operator is calling. An API key you issue (`AGENTICWEB_API_KEYS`) also counts as verified. A user agent string alone never does.

Reading is always open. Rules decide which actions each kind of caller may use, and how fast:

```json
"agents": {
  "rules": {
    "verified": { "actions": "all", "requestsPerMinute": 120 },
    "unverified": { "actions": "read", "requestsPerMinute": 20 },
    "partner-app": { "actions": ["create_checkout_link"] }
  }
}
```

- **Rule keys:**
  - an agent's signing domain (`chatgpt.com` also covers its subdomains), or an API-key agent name;
  - `verified` for any verified caller;
  - `unverified` for everyone else.
- **Actions:** `all`, `read`, `none`, or a list of action names.
- **With no rules,** everyone can use the actions you turned on.
- **Agents see only what they may use.** MCP lists only the actions a caller may use. A refused call says who the action is open to. The manifest lists `allowed` for each restricted action.
- **The audit trail records who acted.** Each action record has the agent and how it was identified. Every response has an `x-agent-identity` header, for example `chatgpt.com; verified=web-bot-auth`.

## 11. Prove agents see the same facts

Every build checks each fact in the agent branch against the live page it came from, as people get it. Facts are names, prices, opening times, phone, email, address, and the numbers in FAQ answers. Each fact is either:

- on the page as written;
- only in the page's structured data;
- not found.

The result is published as `parity.md` and `parity.json`, and the manifest shows the score.

The build then signs the facts and the report with your key:

- **Your key:** made on the first build in `.agenticweb/signing-key.json`. It is git-ignored; keep it private. In CI, put its contents in the `AGENTICWEB_SIGNING_KEY` secret.
- **What gets published:** the signature at `/.well-known/agent-site-proof.json` and your public key at `/.well-known/agent-site-key.json`.
- **Tie the key to your domain:** edge mode serves the key on your domain automatically. If the agent branch is on another host, add a DNS TXT record `agenticweb-key=<kid>` (the `kid` is in the proof file).

Anyone can check a published agent branch:

```bash
npx agenticweb-cli check https://agents.mysite.com
```

It verifies:

- the owner's signature;
- that the facts haven't changed since they were signed;
- that the key belongs to the site;
- a fresh parity check against your live pages.

`agenticweb parity` re-runs the check against your live site and re-signs without a full rebuild.

## 12. Use from Claude

- Claude Code: `/plugin marketplace add adibfarah/agenticweb`, then `/agentify https://mysite.com`.
- Claude Desktop or any MCP client: add an MCP server with command `npx` and args `["agenticweb-cli@latest", "mcp"]`.
- Agents using your agent branch: point them at `https://agents.mysite.com/mcp` (Streamable HTTP).

## 13. Privacy

AgenticWeb sends nothing to us. There is no telemetry. What it keeps stays on your machine or on the servers you deploy.

| What | Where | What it holds |
|---|---|---|
| Traffic log | `.agenticweb/traffic.jsonl` locally, one JSON line per request in your server's logs when deployed | Time, path, agent name, user agent, the question asked, and the caller's IP address (used for rate limits) |
| Action records | `.agenticweb/actions.json` locally, your KV store or server memory when deployed | What each agent asked for, including the guest's name, email or phone for bookings, and how the agent was identified |
| Outbox | `.agenticweb/outbox.log` (local testing only) | Copies of confirmation emails |
| Suggestions | `.agenticweb/suggestions.json` | Questions agents asked and your drafted answers |

- **Before you go live:** say in your privacy policy that AI agents can make requests for your customers, that you keep the details they send (name and email for a booking), and that request logs include IP addresses.
- **Retention:** set it in your hosting or log tool. Pending actions expire after `runtime.holdMinutes`.
- **AI provider:** if you set an AI key, your site's public content and agents' questions are sent to that provider (Anthropic, OpenAI, DeepSeek, Google, or your own server) to write answers. Guest details from actions are never sent.
- **Payments:** card details never pass through AgenticWeb.

