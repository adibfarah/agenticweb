---
description: Review what your agent branch exposes and choose what agents may see and do
argument-hint: "[project-dir]"
---

Use the agentify-site skill's review step for the AgenticWeb project in ${ARGUMENTS:-the current folder}.

Run `agenticweb status` and `agenticweb actions`, read the generated `agent-branch/llms.txt` and a sample of `pages/` and `data/`, then give the user a short plain-language summary: what agents will see, which actions are drafts, and anything that looks private or wrong. Offer `hide`, `show` and `actions enable|disable` changes, and only make them when the user agrees. Rebuild afterwards.
