---
'@aspiralabs/ui': minor
'@aspiralabs/config': minor
'@aspiralabs/ai': minor
---

Aspira Labs now publishes three packages: `@aspiralabs/ui`, `@aspiralabs/config` and `@aspiralabs/ai`. `@aspiralabs/ai` holds everything AI-related in one package: the eleven `/aspira-*` skills, the agents behind them (groomer, spec-writer, planner, implementor, code-analyzer, pr-reviewer, build-feature, visual-verify) and the `kit` command. It replaces the former `@aspiralabs/kit`, `@aspiralabs/agents` and the per-agent packages, which stop receiving releases (their history stays in this changelog).

Install it globally per engineer (`pnpm add -g @aspiralabs/ai`) and as a devDependency of each project; inside a project the project's copy runs, and `kit init` copies the skills pinned to that version. `kit` and the session-start hook now check once a day whether a newer version exists and print the upgrade commands, staying silent when offline. The engineer setup guide and the 0.15 to 0.16 migration guide in Notion describe the steps.
