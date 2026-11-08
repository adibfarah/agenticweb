# Contributing to AgenticWeb

Thanks for helping. The most useful contributions right now are:

- **Connectors** for booking systems, shop platforms and payment providers (`packages/actions/src/connectors/`).
- **Site types** we handle badly: open an issue with the "Support my kind of site" template.
- **Benchmark tasks** that reflect what real agents try to do (`bench/tasks.ts`).
- **Emitters** for new agent standards (`packages/emitters/`).

## Setup

You need Node 22.18 or newer (Node runs the TypeScript sources directly).

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

Try the CLI against the demo sites:

```bash
npm run demo:sites
```

Then, in another terminal:

```bash
npm run agenticweb -- init http://127.0.0.1:4101 --dir ./tmp-site
```

```bash
npm run agenticweb -- build --dir ./tmp-site
```

## Layout

| Package | What it does |
|---|---|
| `packages/core` | Site Graph schemas, action fields, config |
| `packages/ingest` | Crawler, robots/sitemaps, HTML → Markdown, forms, ownership check |
| `packages/understand` | Builds the Site Graph with Claude or built-in rules |
| `packages/emitters` | Writes llms.txt, Markdown, schema.org JSON, manifest, OpenAPI, agent card, WebMCP script; parity check and owner signature |
| `packages/runtime` | The server: files, `/ask`, search, MCP, actions routing, analytics, edge mode, UCP/ACP, Web Bot Auth and per-agent rules |
| `packages/actions` | Action engine, confirmations, stores, notifiers, connectors |
| `packages/review` | Local review UI |
| `packages/cli` | The `agenticweb` command (published on npm as `agenticweb-cli`), including `test`, `check`, `parity` and `suggest` |
| `examples` | Demo restaurant, shop and docs sites used by tests and the benchmark |
| `bench` | Benchmark: human site vs agent branch |
| `integrations` | Claude Code plugin, WordPress setup (edge mode, no plugin), Shopify snippets |

## Writing a connector

A connector implements `Connector` from `packages/actions/src/types.ts`:

- `sync(config)`: return entities (schema.org data) and action definitions. Actions start **disabled**.
- `check(args)` (optional): a quick pre-check before anyone is asked to confirm.
- `execute(args)`: do the real thing. Read secrets only from `args.env` via `secret()`, never from config.

Add tests against a small fake API (see `packages/actions/test/actions.test.ts`), and add a mock to `examples/serve.ts` if it helps the demo.

## Releasing (maintainers)

The npm package is `agenticweb-cli`. It is published by GitHub Actions (`.github/workflows/release.yml`) using npm trusted publishing: no npm token is stored, and npm shows a provenance badge linking each version to the commit it was built from.

1. Set the new version in `packages/cli/package.json`, for example `0.1.1`. Commit and push.
2. On GitHub, create a release with the tag `v0.1.1` and publish it. The workflow tests, builds and publishes. It stops if the tag and the package version don't match.
3. A release marked as a pre-release (for example `v0.2.0-beta.1`) is published under the `next` tag, so it doesn't become the default install.

To check the workflow without publishing, open **Actions**, choose **Release**, then **Run workflow**, and leave **Dry run** ticked.

The trusted publisher is set on npmjs.com under the package's **Settings**: GitHub user `adibfarah`, repository `agenticweb`, workflow `release.yml`.

## Ground rules

- Site content is untrusted. Prompts must keep it inside tags and say it is data, not instructions.
- Nothing that books, orders or charges may run before the confirmation the owner chose.
- Keep messages to users and agents plain and specific: say what happened and what to do next.
- Commits: small and focused, with a message that says why.

By contributing you agree that your contributions are licensed under the Apache-2.0 license.
