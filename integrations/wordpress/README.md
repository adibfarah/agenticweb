# AgenticWeb for WordPress

AgenticWeb doesn't need a WordPress plugin. Nothing runs inside WordPress: no PHP code, no new admin pages, and nothing extra to patch.

Instead, **edge mode** puts a small TypeScript service in front of your site on your own domain. It handles the agent parts and passes everything else to WordPress unchanged:

- `https://your-site.com/llms.txt` and `/.well-known/agent-site.json` are answered by AgenticWeb
- the full agent branch (Markdown pages, data, `/ask`, `/mcp`, actions) lives at `https://your-site.com/.agent/`
- an agent that asks for a page with `Accept: text/markdown` gets the clean Markdown version of that page
- every HTML page gets discovery `<link>` tags and a `Link` header, and `robots.txt` gets two comment lines

## Set up

```bash
npx agenticweb-cli init https://your-site.com
```

For WooCommerce stores, connect the store so products and checkout links come straight from WooCommerce:

```bash
npx agenticweb-cli connect woocommerce store=https://your-site.com
```

```bash
npx agenticweb-cli build
```

### Your domain is on Cloudflare

```bash
npx agenticweb-cli deploy --target edge
```

This writes `agent-edge/` with a Worker and a `wrangler.toml` that routes `your-site.com/*` through it. Publish it with `npx wrangler deploy` from that folder.

### Your domain isn't on Cloudflare

Run the Node or Docker target in front of WordPress, for example behind nginx or your load balancer, and set `EDGE_ORIGIN` to the address WordPress listens on:

```bash
npx agenticweb-cli deploy --target docker
```

```bash
docker run -p 8787:8787 -e EDGE_ORIGIN=http://wordpress:80 -e PUBLIC_URL=https://your-site.com your-site-agents
```

### Try it locally first

```bash
npx agenticweb-cli serve --edge https://your-site.com
```

Open `http://127.0.0.1:8787/` to see your site through the edge, and run `curl -H "Accept: text/markdown" http://127.0.0.1:8787/` to see what agents get.

## Keep it fresh

- WooCommerce has webhooks built in: **WooCommerce → Settings → Advanced → Webhooks**, topic "Product updated", delivery URL `https://your-site.com/.agent/hooks/refresh?secret=YOUR_SECRET` (needs the Node or Docker runtime with `AGENTICWEB_HOOK_SECRET` set).
- For posts and pages, schedule rebuilds with `npx agenticweb-cli ci --every 6`.

## Why there's no plugin anymore

Earlier versions shipped a small PHP plugin. Almost all WordPress security problems come from plugins, so we removed ours. Edge mode does the same jobs and works the same way for any CMS.
