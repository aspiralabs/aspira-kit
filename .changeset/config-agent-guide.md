---
'@aspiralabs/config': minor
'@aspiralabs/kit': minor
---

The managed block that `kit init` writes into a project's `AGENTS.md` is now pointers only: the rules live in Notion (Agent Instructions), the process and "what is the next step" live in From Idea to Release and its Playbook, lessons go to the Slop Repo and the kit gap pages. It restates no rule. Everything outside the block is project-specific.

Feature work has one layout in every project: a gitignored `.work/<id>-<slug>/` per ticket, pulled from the Notion ticket and never committed. `kit init` adds `.work/` to `.gitignore` instead of creating `specs/`; `kit doctor` checks the ignore line and fails on a committed `specs/`, `docs/plans` or `docs/working-feature` folder. Rule zero's commit trailer is `Spec: <ticket URL>`.
