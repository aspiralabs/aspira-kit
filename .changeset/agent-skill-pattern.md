---
'@aspiralabs/config': patch
---

Agents follow one skill pattern: every agent has an `aspira-<agent>` skill that launches it, `--local` runs the same pipeline inside a Claude Code session from the agent's own instruction files, and the Notion engineering rules are mandatory on every path. Adds `aspira-pr-reviewer`, `--local` for planner and code-analyzer, and code-analyzer subdirectory support. See `packages/agents/README.md`.
