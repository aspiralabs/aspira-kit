---
'@aspiralabs/config': minor
'@aspiralabs/kit': minor
---

Agent config: a new org-level `agent/AGENTS.md` is the entry point every project points at. It names the Notion rules (Agent Instructions), the process (From Idea to Release and its Playbook, Feature Board, Releases, Review Verification), the skills, what each file in `agent/` is for, and where lessons are written back. The managed block that `kit init` writes into a project's `AGENTS.md` now points at that guide and tells agents to answer "what is the next step" from the Playbook using the ticket's Status, never from memory.

Feature work has one layout in every project: a gitignored `.work/<id>-<slug>/` per ticket, pulled from the Notion ticket and never committed. `kit init` adds `.work/` to `.gitignore` instead of creating `specs/`; `kit doctor` checks the ignore line and fails on a committed `specs/`, `docs/plans` or `docs/working-feature` folder. Rule zero's commit trailer is `Spec: <ticket URL>`.
