# AgenticWeb for Shopify

Shopify stores get first-class support through the `shopify` connector:

- the product catalog (all variants, prices and stock) comes straight from your store's public `/products.json`
- `check_stock` and `create_checkout_link` actions use Shopify cart permalinks, so the person reviews and pays on Shopify's own checkout

No Shopify API key is needed.

## Set up

```bash
npx agenticweb-cli init https://your-store.com
```

```bash
npx agenticweb-cli connect shopify store=https://your-store.myshopify.com
```

```bash
npx agenticweb-cli build
```

```bash
npx agenticweb-cli actions enable create_checkout_link
```

Then deploy (`npx agenticweb-cli deploy --target cloudflare-worker` or `docker`).

## Discovery tags in your theme

1. In **Online Store → Themes → Edit code**, add `snippets/agenticweb-head.liquid` from this folder.
2. In `layout/theme.liquid`, add `{% render 'agenticweb-head' %}` inside `<head>`.
3. Set your agent branch URL in the snippet (or add an `agenticweb_url` theme setting).

## Keep it fresh

Point a Shopify webhook at your agent branch so product and price changes show up right away:

1. Run the agent branch with a secret: set `AGENTICWEB_HOOK_SECRET` on the server (`agenticweb serve`, Node or Docker target).
2. In **Settings → Notifications → Webhooks**, add webhooks for **Product update**, **Product creation** and **Product deletion**, with the URL:

   ```
   https://agents.your-store.com/hooks/refresh?secret=<your secret>
   ```

Without a long-running server, schedule rebuilds instead: `npx agenticweb-cli ci --every 6` writes a GitHub Actions workflow.

## A full Shopify app?

A listed Shopify app (theme app extension + automatic webhooks + hosted agent branch) is on the roadmap. It needs a hosted AgenticWeb service, which this repo doesn't include yet.
