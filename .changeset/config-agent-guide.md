---
'@aspiralabs/config': minor
'@aspiralabs/kit': minor
---

`@aspiralabs/config` is eslint, tsconfig and prettier only. Its `agent/` folder is gone: the rules live in Notion (Engineering Central), the `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and settings templates now ship in `@aspiralabs/kit` (`templates/agent/`), and the session hooks in `@aspiralabs/kit/hooks/`. The `./agent/*` export is removed.

The managed block that `kit init` writes into a project's `AGENTS.md`, and the session-start hook, are pointers only: Agent Instructions for the rules, From Idea to Release and its Playbook for the process and "what is the next step", the Slop Repo and the kit gap pages for lessons. They restate no rule. `kit init` drops settings entries that still point at the retired config hook path.

Feature work has one layout in every project: a gitignored `.work/<id>-<slug>/` per ticket, pulled from the Notion ticket and never committed. `kit init` adds `.work/` to `.gitignore` instead of creating `specs/`; `kit doctor` checks the ignore line and fails on a committed `specs/`, `docs/plans` or `docs/working-feature` folder.
