# Decisions

Org-level engineering decisions, reverse chronological, with the reasoning or a link to it.

- **2026-09-19** — One kit per organization. `@aspiralabs/ui`, `@aspiralabs/config`, `@aspiralabs/kit`, lockstep versions. Split on runtime peers, not per config. The kit repo is the org repo.
- **2026-09-19** — Component docs ship inside `@aspiralabs/ui` and are served by an MCP server inside the package, so an agent gets the docs for the version installed.
- **2026-09-19** — Constraints live at user scope (imported into every project) with the reviewer as the guardrail behind them. Guides live behind an MCP lookup. Write-back goes to the layer the lesson belongs to: product facts to the product, org lessons to this repo by ratified PR.
