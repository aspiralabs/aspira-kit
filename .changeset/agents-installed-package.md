---
'@aspiralabs/kit': minor
'@aspiralabs/agents': minor
'@aspiralabs/agent-common': minor
'@aspiralabs/spec-writer': minor
'@aspiralabs/spec-reviewer': minor
'@aspiralabs/planner': minor
'@aspiralabs/implementor': minor
'@aspiralabs/code-analyzer': minor
'@aspiralabs/pr-reviewer': minor
---

The agents are installed packages, not a source checkout. The seven agent packages publish with the kit at one version, and a new `@aspiralabs/agents` brings all of them into a project as one devDependency. `kit init` adds it and writes `.claude/skills/aspira-<agent>/` for each agent as a copy of the installed package's skill with a `.kit-version`; `kit doctor` prints the installed `@aspiralabs/agents` version and fails when a skill folder is missing or from another version. The `~/.claude/skills` symlinks are retired; the kit README says how to remove them.

Every launcher resolves its agent as `<AGENT>_AGENT_DIR` (kit development only), then the package installed under the project, then its own location, and no longer reads `$ASPIRA_KIT`; one that lands on a checkout says it is running kit source. The agents run from `node_modules` with Node and amaro, reading the project's `.env.local` first, and every run reports and records the agent package version it ran. `kit init` also ships the `.claude/settings.json` hooks template again, which had been committed empty.
