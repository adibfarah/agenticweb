---
description: Prepare and publish your agent branch to a host
argument-hint: "<static|cloudflare|netlify|vercel|node|docker|cloudflare-worker>"
---

Use the agentify-site skill's deploy step. Run `agenticweb deploy --target $ARGUMENTS` (ask which target if none was given, recommending `cloudflare-worker` when actions or `/ask` are enabled and `static` otherwise).

Show the publish command the CLI prints and run it only after the user confirms. Then run `agenticweb snippets --base-url <the deployed URL>` and explain where to paste the snippets on the human site.
