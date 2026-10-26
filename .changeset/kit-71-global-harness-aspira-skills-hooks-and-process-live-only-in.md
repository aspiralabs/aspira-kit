---
"@aspiralabs/ai": patch
---

Global harness: /aspira-* skills, hooks and process live only in the engineer's ~/.claude, never in a project repo (KIT-71)

aspira.json is git-ignored in every repo, never committed: the global ignore lists it, `kit init` stops tracking a committed one (the file stays) and restores one a pull deleted, ticket worktrees link the main checkout's, and `kit doctor` fails while git tracks it (KIT-71)

`kit upgrade` and the /aspira-upgrade skill move an existing project to the global harness: update the global kit, remove the committed harness, stop tracking aspira.json, and commit on a yes; no stack wiring is touched (KIT-71)
