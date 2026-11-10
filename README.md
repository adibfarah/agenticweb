# AgenticWeb

**Make your website easy for AI agents to read and use.**

AI agents now shop, compare and book for people. But websites are built for eyes, so agents get lost in menus, scripts and pop-ups, read far more than they need, and can't safely press "Book" or "Buy".

AgenticWeb reads a website you own and builds an **agent version** of it next to the real one: the same content, in clean formats agents understand, with safe tools for actions like booking a table or starting a checkout. Your site for people stays exactly as it is.

https://github.com/user-attachments/assets/800ed286-fa7c-4ea2-8629-28ea9f93d51d

## How much it helps

We gave agents 18 tasks on three demo sites (a restaurant, a shop and a docs site), such as "What time do you close on Sunday?", "Is there a vegan pizza?" and "Put a blue hoodie, size M, in the cart".

| | Tasks done | Requests | Text read |
|---|---|---|---|
| Normal website | 17 of 18 | 47 | about 29,300 tokens |
| **With AgenticWeb** | **18 of 18** | **19** | **about 4,800 tokens** |

Agents read **84% less** and made **60% fewer requests**, and only the agent version could put items in a cart. That's against a best-case reader that stops the moment it sees the answer; real agents usually do worse.

The demo sites were built alongside AgenticWeb, so treat this as a demonstration until it's repeated on real sites. Full results are in [bench/results-heuristic.md](bench/results-heuristic.md), and you can rerun them with `npm run bench`.

## Get started

You need Node 22.18 or newer. The npm package is called `agenticweb-cli`; if you install it (`npm install -g agenticweb-cli`), the command is just `agenticweb`.

```bash
npx agenticweb-cli init https://mysite.com
```

```bash
npx agenticweb-cli build
```

```bash
npx agenticweb-cli review
```

```bash
npx agenticweb-cli serve --edge
```

- **init** starts a project and asks you to prove you own the site (a DNS record or a small file).
- **build** reads your site and pulls out what matters: pages, products, menus, hours, FAQs and policies.
- **review** opens a page where you choose what agents can see and which actions they can use. Everything starts off.
- **serve --edge** shows your site with the agent version added, at `http://127.0.0.1:8787`.

## Do I need an AI key?

**No.** AgenticWeb works fully without one. The benchmark above was run with no AI key at all.

**What an AI provider is for:** it's the AI that AgenticWeb can call on for a few optional extras. The core work never depends on it: building the agent version, the safety checks, bookings and checkout all run on AgenticWeb's own rules.

| | Without a key | With a key |
|---|---|---|
| Reading your site | Built-in rules, good for well-built sites | Smarter on messy pages (and PDFs, with Claude) |
| Answering agents' questions | The matching facts, with sources | A short written answer, with sources |
| Testing your site as an agent | Quick checks with set answers | A real AI agent tries each task |
| Questions your site can't answer yet | The question, for you to answer | A draft answer from your site's own facts |

**Pick any provider:** Claude (the default), OpenAI, DeepSeek, Gemini, or a free model running on your own computer (Ollama or LM Studio). It's one line in the config, and the [guide](docs/GUIDE.md#choosing-an-ai-provider) shows how. Your key stays on your computer or server, and requests go straight to the provider you chose, never to us.

## Put it on your site

**Recommended: edge mode.** AgenticWeb runs in front of your site on your own domain. Nothing gets installed on your site, so it works with WordPress, Shopify themes, Webflow, custom code or anything else.

```bash
npx agenticweb-cli deploy --target edge
```

This prepares a Cloudflare Worker for your domain. Not on Cloudflare? Use `--target docker` or `--target node` and run it in front of your site. You can also host the agent version on its own address, like `agents.mysite.com`. The [guide](docs/GUIDE.md#6-run-and-deploy) covers every option.

## What agents get

| | What it is |
|---|---|
| `/llms.txt` | A short summary of your site for AI models |
| Markdown pages | Any page, as clean text, when an agent asks for it |
| Product and business data | Prices, stock, hours and FAQs in the standard schema.org format |
| `/.agent/ask` | Ask a question in plain words and get an answer with sources |
| MCP server | Your site as tools for ChatGPT, Claude, Gemini, Cursor and other AI apps |
| WebMCP | The same tools for AI agents built into browsers |
| UCP and ACP checkout | The checkout protocols shopping agents use, for any store, not only Shopify |

## Check that it works

- **Test it like an agent.** `npx agenticweb-cli test` tries your real tasks, like "book a table for 4 on Friday", on both your site and the agent version (with an AI key, a real AI agent does them). You get an **Agent Readiness score**, a badge, and a warning when a task that used to work breaks.
- **Prove it's the same story.** Every build checks each fact (prices, hours, contact details) against your live pages and signs the result with your key. Anyone can check it with `npx agenticweb-cli check <agent-branch-url>`.
- **Fill the gaps.** `npx agenticweb-cli suggest` lists questions agents asked that your site couldn't answer, with a draft answer for each if you have an AI key. You approve them and add them to your site, and agents pick them up from there.

## Works with

Shopify, WooCommerce, Stripe, Cal.com, any API with an OpenAPI description, any HTTP endpoint, and plain HTML forms (opt-in).

## Safe by default

- **Only the owner can build it.** You have to prove you own the site first.
- **Same facts for people and agents.** The agent version is a different format of the same content, never a different story. A signed parity report lists any fact that doesn't match your pages. Agents get Markdown only when they ask for it.
- **You decide who can do what.** Agents that sign their requests (Web Bot Auth) or use a key you gave them are verified. You can let verified agents book while others only read.
- **Actions are off until you turn them on.** Nothing final happens without the check you chose: the customer confirms by email, you approve, or the customer pays on your own checkout.
- **No card numbers, ever.** Payments go through your checkout or your payment provider.
- **Your data stays yours.** AgenticWeb sends nothing to us. What your servers log, such as IP addresses and booking details, is listed in the [privacy section](docs/GUIDE.md#13-privacy) of the guide so you can cover it in your privacy policy.
- **Website text is treated as data, not instructions.** AgenticWeb never follows text it reads on a page, and it tells agents not to either.

More in [SECURITY.md](SECURITY.md).

## Use it from your AI assistant

- **Any coding assistant** (Claude Code, Codex, Cursor, Gemini CLI and others) can run the `npx agenticweb-cli` commands for you.
- **Any MCP app** (ChatGPT, Claude Desktop, Cursor, VS Code and others): add an MCP server with the command `npx` and the arguments `["agenticweb-cli@latest", "mcp"]`.
- **Claude Code plugin:** run `/plugin marketplace add adibfarah/agenticweb`, then `/agentify https://mysite.com` for a guided walkthrough.

## Learn more

- [Guide](docs/GUIDE.md): every command and setting
- [Format spec](docs/SPEC.md): the files and endpoints, so any tool can read or produce them
- [WordPress](integrations/wordpress) and [Shopify](integrations/shopify) setup
- [Contributing](CONTRIBUTING.md) and the [original plan](docs/PLAN.md)

## License

[Apache 2.0](LICENSE). The npm package bundles open-source libraries under their own licenses (MIT, BSD, ISC, Apache 2.0 and Unlicense), listed with their full texts in `THIRD_PARTY_NOTICES.md` inside the package.
