# AgenticWeb: Project Plan

> **Status (2026-11-07):** all phases (0–5) are built and tested. See the [guide](GUIDE.md) for usage. Differences from this plan: npm workspaces instead of pnpm/Turborepo; every Claude step defaults to `claude-opus-5-5` with effort `low` (owners can choose other models in `agenticweb.config.json`); a listed Shopify app and a hosted service are still future work. Added after the plan: edge mode (`deploy --target edge`), which replaced the PHP WordPress plugin so the whole project is TypeScript. Also added (2026-11-08): WebMCP output, UCP/ACP checkout, Agent Readiness tests (`agenticweb test`), Web Bot Auth with per-agent rules, a signed parity report (`agenticweb check`), and drafted answers for unanswered questions (`agenticweb suggest`).

This document covers the problem, the product, the architecture, how it is built, the release phases, and how to launch it on GitHub.

---

## 1. The problem

AI agents (Claude, ChatGPT agents, Perplexity, Gemini, custom agents built on MCP) are becoming a real source of website traffic. They don't read sites the way people do:

| What a human sees | What an agent gets |
|---|---|
| A clean product card with price and "Add to cart" | 300 KB of HTML, inline scripts, tracking pixels, a cookie banner, and a price that only appears after JavaScript runs |
| A booking calendar | An iframe from a third-party widget that the agent can't see inside |
| A menu as a nice image | Nothing. The text is inside a JPEG. |
| An FAQ accordion | Collapsed content the agent has to click open one item at a time |

The result is high token cost, wrong answers, slow multi-step browsing, and very few completed actions. Site owners have no simple way to fix this without hiring developers to build APIs and MCP servers by hand.

## 2. The idea in one sentence

**AgenticWeb turns any website you own into an agent branch, a machine-first copy of your site that agents can read in one or two requests and act on through safe, owner-approved tools.**

## 3. Who it is for

| User | Their need | What they get |
|---|---|---|
| Small businesses (restaurants, clinics, salons, hotels) | "Agents should be able to book with me." | Booking actions connected to their existing booking tool |
| Online stores | "Agents should find my products and send me buyers." | Product catalog, live stock and price, cart/checkout handoff |
| SaaS and docs sites | "Agents should answer questions about my product correctly." | Clean docs in Markdown, `/ask` with sources, `llms.txt` |
| Agencies and developers | "I want to do this for many clients quickly." | CLI, config as code, CI deploys |

## 4. How it fits with existing standards

The agent ecosystem already has several partial standards. AgenticWeb's job is to **generate all of them from one source** instead of competing with them.

| Standard | What it does | AgenticWeb's role |
|---|---|---|
| `llms.txt` | Markdown index of a site for LLMs | Generated automatically |
| schema.org / JSON-LD | Typed data (Product, Event, LocalBusiness, FAQPage…) | Extracted and emitted as JSON, and optionally injected back into the human site |
| MCP (Model Context Protocol) | Standard way to give agents tools | Generated MCP server with read and action tools |
| OpenAPI | REST API description | Generated for the same actions |
| NLWeb-style `/ask` | Natural-language query endpoint for a site | Provided by the runtime |
| A2A agent card (`/.well-known/agent-card.json`) | Lets one agent discover another | Optional: expose the site as an agent |
| Agentic commerce protocols (e.g. ACP, AP2, UCP) | Agent-initiated checkout and payments | Phase 3+ adapters, behind owner opt-in |
| Web Bot Auth / signed agent requests | Verifying who an agent is | Used for allow-lists and rate limits |
| `robots.txt`, content signals | Crawl permissions | Respected when crawling; updated to point to the agent branch |

These standards move fast, so check each one's current version before implementing it. The design keeps every format as a separate plug-in **emitter**, so adding or changing one doesn't touch the rest.

**What makes AgenticWeb different:** existing tools each cover one layer. `llms.txt` generators are read-only, MCP servers are hand-built by developers, and platform features only work on one platform. AgenticWeb covers **discovery + content + query + actions + sync** in one command, for any site.

## 5. Product experience

### 5.1 The flow

```
 ┌──────────┐   ┌────────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
 │  Ingest  │──▶│ Understand │──▶│  Review  │──▶│ Generate │──▶│  Deploy  │──▶│   Sync   │
 │ URL/data │   │  (Claude)  │   │ (owner)  │   │ emitters │   │ anywhere │   │ + observe│
 └──────────┘   └────────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
                                       ▲                                           │
                                       └──────────── changes need review ──────────┘
```

### 5.2 Example session in Claude Code

```text
> /agentify https://bellacucina.example

Verifying ownership… add this TXT record to bellacucina.example:
  agenticweb-verify=7f3a…   ✔ verified

Crawling… 42 pages, 3 PDFs (menu, allergens, catering)
Understanding…
  • Business: Restaurant (LocalBusiness/Restaurant)
  • Menu: 64 dishes with prices, 11 allergen tags (extracted from PDF + image OCR)
  • Hours: 7 rules, 2 holiday exceptions
  • Actions found: table booking (OpenTable widget), catering enquiry (contact form)

Which actions should agents be allowed to use?
  [x] check_table_availability   (read-only)
  [x] request_booking            (needs guest confirmation by SMS/email)
  [ ] submit_catering_enquiry    (form fallback, off by default)

Generated agent branch → ./agent-branch  (12 files, 38 KB total)
Deploy to Cloudflare Workers at agents.bellacucina.example? (y/N)
```

### 5.3 What an agent experiences

Before: open homepage → close cookie banner → find "Menu" → open PDF → OCR → find "Book" → load OpenTable iframe → guess the form. About 25 steps, more than 150k tokens, fragile.

After:

```http
GET https://agents.bellacucina.example/.well-known/agent-site.json   # what's here, what I can do
POST https://agents.bellacucina.example/mcp  tools/call check_table_availability {date, time, party_size}
POST https://agents.bellacucina.example/mcp  tools/call request_booking {…}  → "confirmation sent to guest"
```

Three requests and a few thousand tokens. The phase 5 benchmark measures this properly (section 11).

## 6. Architecture

### 6.1 The core idea: a Site Graph

Everything is built around one intermediate model, the **Site Graph**. Ingestion fills it, the owner reviews it, and every output format is generated from it. This is what lets one tool target many standards.

```
            INGEST                       SITE GRAPH                         EMITTERS
 ┌───────────────────────┐        ┌──────────────────────┐        ┌─────────────────────────┐
 │ Crawler (Playwright)  │        │ site: identity, owner │        │ llms.txt                │
 │ Sitemap / RSS         │──┐     │ pages: markdown, meta │   ┌──▶│ pages/*.md              │
 │ PDFs, images (OCR)    │  │     │ entities: typed JSON  │   │   │ data/*.json (schema.org)│
 ├───────────────────────┤  ├────▶│ actions: tools + auth │───┼──▶│ agent-site.json         │
 │ Connectors:           │  │     │ policies: rules, ToS  │   │   │ MCP server              │
 │ Shopify, WooCommerce, │──┘     │ provenance: source URL│   │   │ OpenAPI                 │
 │ WordPress, Cal.com,   │        │   + timestamp per fact│   │   │ /ask index (embeddings) │
 │ Stripe, DB, CSV, API  │        └──────────────────────┘   └──▶│ JSON-LD for human site  │
 └───────────────────────┘                  ▲                     └─────────────────────────┘
                                            │
                                  Understand (Claude):
                                  classify, extract, map actions
```

Every fact in the Site Graph keeps its **provenance** (source URL, when it was seen, and how it was obtained: crawled, connector, or owner-edited). This makes answers citable and lets sync detect what changed.

### 6.2 Runtime (what's deployed)

A small server (TypeScript, [Hono](https://hono.dev)) that runs on Cloudflare Workers, Vercel, Netlify, Deno, Bun or Node/Docker:

```
agents.mysite.com
 ├─ static:   /.well-known/agent-site.json, /llms.txt, /pages/*, /data/*, /openapi.json
 ├─ /ask      natural-language query → retrieval over Site Graph → answer + citations
 ├─ /mcp      MCP server (Streamable HTTP): read tools + action tools
 ├─ /api/*    REST version of the same actions
 └─ middleware: agent identification, rate limits, auth, idempotency, audit log
```

Without actions, the agent branch can be **100% static** (free hosting on GitHub Pages / Cloudflare Pages). Actions and `/ask` need the small runtime.

### 6.3 Actions: how agents interact safely

Actions are the hardest and most valuable part. Each one is defined in the Site Graph like this:

```yaml
- name: request_booking
  description: Request a table reservation.
  kind: write              # read | write | payment
  input:  { date: date, time: time, party_size: int(1..12), name: string, contact: email|phone }
  backend: cal.com         # or shopify, stripe, http, form-bridge
  confirmation: guest      # none | guest | owner | checkout_link | payment_protocol
  limits: { per_agent_per_hour: 10 }
  idempotency: required
```

**Backends, from best to worst:**

1. **Native connector:** call the platform API (Shopify Storefront/Cart API, WooCommerce REST, Cal.com/Calendly, Square, Stripe Payment Links). Reliable and fully supported.
2. **Owner's own API:** the owner gives an OpenAPI spec or endpoint and Claude maps it to actions.
3. **Form bridge (fallback, off by default):** submit the site's real HTML form from the server. It breaks easily and can be abused, so it needs explicit opt-in and strict limits.

**Confirmation levels** (the owner picks one per action):

| Level | What happens | Typical use |
|---|---|---|
| `none` | Runs immediately | Read tools, availability checks |
| `guest` | The end customer confirms by email/SMS link | Bookings, enquiries |
| `owner` | Goes into a queue for the business to accept | Catering, custom orders |
| `checkout_link` | Agent gets a pre-filled cart/checkout URL to hand back to its human | Most purchases in v1 |
| `payment_protocol` | Agentic payment via a supported protocol (ACP / AP2 / UCP adapters) | Phase 3+, owner opt-in |

**AgenticWeb never stores card numbers.** Payments always go through the owner's payment provider.

### 6.4 Using Claude inside the pipeline

| Task | Approach | Model (current lineup) |
|---|---|---|
| Page classification (product, article, contact, policy…) | High volume, effort `low` | Claude Opus 5.5 (configurable) |
| Entity extraction to schema.org types | Structured outputs with Zod schemas | Claude Opus 5.5 (configurable) |
| PDFs (menus, price lists) | Document input, streamed | Claude Opus 5.5 (configurable) |
| Action discovery and mapping (forms, widgets, APIs → tools) | Hard reasoning, low volume | Claude Opus 5.5 (configurable) |
| `/ask` answers at runtime | Retrieval + short grounded answer with citations | Claude Opus 5.5 (configurable) |

Cost controls: prompt caching for the shared extraction instructions, Batch API for large initial crawls, and content hashing so unchanged pages are never re-processed.

### 6.5 Distribution: how users get it

1. **Claude Code plugin:** a skill (`agentify-site`) + slash commands (`/agentify`, `/agent-review`, `/agent-deploy`). Claude runs the CLI and explains every step. This is the "Claude tool" experience.
2. **MCP server for any Claude client:** tools like `agentify_site`, `preview_agent_branch`, `deploy_agent_branch`, so it works in Claude Desktop and other MCP clients too.
3. **CLI (`npx agenticweb-cli`):** for developers and CI pipelines.
4. **Later:** WordPress plugin, Shopify app, and a hosted web dashboard for non-technical owners.

## 7. Tech stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 22+) | Best MCP SDK support, runs on edge platforms, one language end to end |
| Monorepo | npm workspaces, Node runs the TypeScript directly | No build step in development |
| Schemas | Zod → JSON Schema | One definition for validation, Claude structured outputs, and OpenAPI |
| Crawling | Playwright + sitemap parser + Readability/Turndown for HTML → Markdown | Handles JavaScript-heavy sites |
| LLM | Anthropic TypeScript SDK | Structured outputs, vision, caching, batches |
| Runtime server | Hono | Same code on Workers, Vercel, Node, Bun, Deno |
| MCP | Official `@modelcontextprotocol/sdk`, Streamable HTTP | Standard transport |
| Search for `/ask` | SQLite + FTS5 locally; Cloudflare Vectorize / pgvector optional | Works with zero setup, scales when needed |
| Tests | Vitest + recorded fixture sites | Repeatable pipeline tests |
| Docs site | Astro Starlight | Easy, good-looking docs |

## 8. Repository structure

```
agenticweb/
├── README.md
├── LICENSE                         # Apache-2.0 recommended
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md                     # how to report vulnerabilities
├── docs/
│   ├── PLAN.md                     # this file
│   ├── SPEC.md                     # agent-branch format spec
│   └── adr/                        # architecture decision records
├── packages/
│   ├── core/                       # Site Graph types, Zod schemas, provenance
│   ├── ingest/                     # crawler, sitemap, PDF/OCR, HTML → Markdown
│   ├── connectors/                 # shopify/, woocommerce/, wordpress/, calcom/, stripe/, openapi/, csv/
│   ├── understand/                 # Claude prompts + extraction pipeline
│   ├── emitters/                   # llms-txt/, markdown/, schema-org/, manifest/, mcp/, openapi/, a2a/
│   ├── runtime/                    # Hono server: /ask, /mcp, /api, middleware
│   ├── deploy/                     # cloudflare/, vercel/, netlify/, docker/, static/
│   ├── cli/                        # `agenticweb` command
│   └── review-ui/                  # local web UI for reviewing the Site Graph
├── integrations/
│   ├── claude-code-plugin/         # skill + slash commands
│   └── mcp-server/                 # AgenticWeb as an MCP server
├── examples/
│   ├── restaurant/                 # demo site + generated agent branch
│   ├── shop/
│   └── docs-site/
├── bench/                          # agent task benchmark (human site vs agent branch)
└── .github/
    ├── workflows/ci.yml
    ├── ISSUE_TEMPLATE/
    └── PULL_REQUEST_TEMPLATE.md
```

## 9. Phased roadmap

Timings assume one main developer working with Claude Code. Each phase ends with something usable and demo-able.

### Phase 0: Foundations (week 1)
- [ ] Repo, license, CI, issue templates
- [ ] `docs/SPEC.md` v0.1 (manifest format, file layout, action definitions)
- [ ] Site Graph Zod schemas in `packages/core`
- [ ] Three small demo sites in `examples/` (restaurant, shop, docs) to test against
- **Done when:** the spec and the schemas match, and the demo sites run locally.

### Phase 1: Read-only MVP (weeks 2–4)
- [ ] Crawler: sitemap + Playwright, respects robots.txt, page limit, content hashing
- [ ] HTML → clean Markdown; PDF text; image OCR via Claude vision
- [ ] Page classification + entity extraction (Product, LocalBusiness, Menu, Event, FAQPage, Article, Offer)
- [ ] Emitters: `llms.txt`, `pages/*.md`, `data/*.json`, `agent-site.json`
- [ ] Domain verification (DNS TXT or `/.well-known/agenticweb-verify.txt`)
- [ ] `agenticweb init`, `agenticweb build`, `agenticweb deploy --target static|cloudflare`
- [ ] Claude Code plugin with `/agentify`
- **Done when:** `/agentify https://demo-restaurant.local` produces a deployable read-only agent branch.
- **First public release (v0.1).** Launch on GitHub here; don't wait for actions.

### Phase 2: Ask and search (weeks 5–6)
- [ ] Runtime server (Hono) with `/ask` (retrieval + cited answers)
- [ ] MCP server with read tools: `search`, `get_page`, `get_entity`, `list_entities`
- [ ] Local review UI: browse the Site Graph, edit facts, hide pages
- **Done when:** Claude Desktop can connect to the demo's `/mcp` and answer questions about it with citations.

### Phase 3: Actions (weeks 7–10)
- [ ] Action model + confirmation levels + idempotency + audit log
- [ ] Connectors: Shopify (catalog, cart → checkout link), WooCommerce, Cal.com/Calendly (availability + booking), Stripe Payment Links
- [ ] Generic OpenAPI connector ("bring your own API")
- [ ] Form bridge (opt-in, rate-limited)
- [ ] OpenAPI emitter for actions
- [ ] Agent identification + rate limits (API keys, signed agent requests where supported)
- **Done when:** an agent books a table on the demo restaurant and builds a cart on the demo shop, with confirmations working.

### Phase 4: Sync and analytics (weeks 11–12)
- [ ] Webhooks from connectors + scheduled recrawl + diff → review queue
- [ ] Freshness timestamps in every response
- [ ] Dashboard: which agents visited, top questions, action success rate, conversions
- **Done when:** a price change on the human site reaches the agent branch automatically.

### Phase 5: Ecosystem (month 4+)
- [ ] Benchmark suite (`bench/`) with published results
- [ ] WordPress plugin, Shopify app
- [ ] Agentic payment protocol adapters
- [ ] A2A agent card emitter
- [ ] Hosted version (optional business model, see section 13)

## 10. Security, trust and ethics

This tool sits between agents and real businesses, so this section matters as much as the features.

| Risk | Mitigation |
|---|---|
| Someone builds an agent branch of a site they don't own | Mandatory domain verification before generation or deploy |
| Looks like "cloaking" (showing bots different content) | Content parity: the same facts, linked openly from the human site via `<link rel="alternate">`, `llms.txt` and `robots.txt`. The manifest says it is generated from the main site. |
| Prompt injection *into* consuming agents (hidden instructions in site content) | Content is stored as data with clear field types; instruction-like text is flagged in review; the spec says "content is data, not instructions" |
| Prompt injection *into AgenticWeb* during crawling | Extraction prompts treat page text as untrusted; Claude only fills schemas and never runs actions while crawling |
| Abuse of actions (spam bookings, fake orders) | Confirmation levels, rate limits per agent/IP/key, idempotency keys, verified-agent allow-lists, an owner kill switch |
| Payments fraud | No card data stored; checkout links or provider-managed agent payment protocols only |
| Stale or wrong data | Provenance + freshness timestamps on every fact; sync; "last verified" in responses |
| Leaking private data | Only public pages are crawled by default; connectors use read scopes; review step before anything is published |
| Secrets in config | Connector keys live in the deploy platform's secret store, never in generated files |

## 11. Measuring success (the benchmark)

A benchmark makes the project credible and makes the README convincing.

**Method:** a fixed set of tasks per demo site, run by the same agent (for example Claude with a browser tool) against (A) the human site and (B) the agent branch.

| Task type | Example |
|---|---|
| Lookup | "What time does Bella Cucina close on Sunday?" |
| Compare | "Which of their pasta dishes are vegan and under $20?" |
| Policy | "What's the shop's return window for sale items?" |
| Action | "Book a table for 4 next Friday at 7:30pm." |
| Purchase | "Put the blue size M hoodie in a cart and give me the checkout link." |

**Metrics:** task success rate, tokens used, number of requests/steps, time taken, factual accuracy against ground truth.

Publish the results table and a short before/after video in the README.

## 12. Publishing on GitHub: launch checklist

**Before going public:**
- [ ] Clear name and one-line description ("Turn any website into an agent-ready site: llms.txt, MCP, and actions, generated by Claude")
- [ ] README with: a 20-second GIF of `/agentify`, a before/after token comparison, a 3-command quickstart, an architecture diagram
- [ ] `LICENSE` (Apache-2.0: permissive with a patent grant, a good fit for a tool businesses will build on)
- [ ] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`
- [ ] Issue templates: bug, feature, **"support my site type"**, **"connector request"**
- [ ] `good first issue` labels (new emitters and connectors are good starter tasks)
- [ ] CI: lint, type-check, tests, build the example agent branches
- [ ] GitHub topics: `ai-agents`, `mcp`, `llms-txt`, `claude`, `agentic-commerce`, `schema-org`, `seo`
- [ ] Deployed live demo: `agents.demo-restaurant.<your-domain>` that anyone can connect Claude to

**Launch:**
- [ ] Publish `agenticweb` on npm; submit the MCP server to the MCP registry; submit the Claude Code plugin to a plugin marketplace
- [ ] Posts: Show HN, r/ClaudeAI, r/webdev, r/LocalLLaMA, X/LinkedIn with the demo video, dev.to write-up "Why agents can't use your website"
- [ ] Ask 3–5 real small businesses to try it first, and use their results as case studies

**After launch:**
- [ ] Respond to issues quickly in the first two weeks
- [ ] A public roadmap (GitHub Projects board)
- [ ] Monthly release notes

## 13. Possible business model (optional)

Keep the core open source. If it takes off:
- **Hosted AgenticWeb:** sign-up, verify domain, done. Managed sync, hosting, and analytics. Monthly plans.
- **Agent analytics:** which agents bring customers, what they ask, where tasks fail.
- **Premium connectors:** POS systems, hotel booking engines, ERPs.
- **Agency plan:** many sites, white label.

## 14. Main risks to the project

| Risk | Response |
|---|---|
| Big platforms (Shopify, WordPress, Cloudflare) build this in | Be the cross-platform, open, standards-neutral option; integrate with them instead of competing |
| Standards change or a single one wins | The emitter architecture means adding or dropping a format is a small change |
| Agents don't discover agent branches | Emit every discovery hint (`llms.txt`, `robots.txt`, `<link rel>`, well-known files, MCP registry) and measure discovery in analytics |
| LLM extraction makes mistakes | Owner review, provenance, connectors as the source of truth where available |
| Scope creep | Ship read-only v0.1 first; actions come only after people are using it |

## 15. Open questions to decide early

1. **Subdomain or subpath by default?** (`agents.mysite.com` is easier to deploy; `mysite.com/.agent/` is easier to discover.) Suggested: support both, default to subpath when the host allows it.
2. **The name.** "AgenticWeb" is descriptive; check npm/GitHub/domain availability before launch.
3. **How much should run without an Anthropic API key?** Suggested: crawling and emitters work without one; understanding uses the key, or uses Claude through the Claude Code plugin.
4. **Which first connector?** Suggested: Shopify (largest market, good APIs) and Cal.com (open source, easy booking demo).

## 16. Immediate next steps

1. Create the GitHub repo and push these docs.
2. Write `packages/core` (Site Graph schemas) to match `docs/SPEC.md`.
3. Build the demo restaurant site in `examples/restaurant`.
4. Build the crawler + Markdown emitter + `llms.txt` emitter: the first end-to-end slice.
5. Wrap it in the Claude Code `/agentify` skill and record the first demo GIF.
