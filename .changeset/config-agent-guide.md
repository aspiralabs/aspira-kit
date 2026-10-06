---
'@aspiralabs/config': minor
---

Agent config: a new org-level `agent/AGENTS.md` is the entry point every project points at. It names the Notion rules (Agent Instructions), the process (From Idea to Release and its Playbook, Feature Board, Releases, Review Verification), the skills, what each file in `agent/` is for, and where lessons are written back. The managed block that `kit init` writes into a project's `AGENTS.md` now points at that guide and tells agents to answer "what is the next step" from the Playbook using the ticket's Status, never from memory.
