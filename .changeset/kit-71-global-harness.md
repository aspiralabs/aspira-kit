---
'@aspiralabs/ai': minor
---

The Aspira skills, hooks and process pointers now live on the engineer's machine, not in each product repo. `kit update` installs the latest global kit and writes the eleven `/aspira-*` skills and three hooks to `~/.claude`; every `kit` command refreshes them when they are behind the running kit. `kit init` stops writing the harness and removes what earlier kits committed (skills, hooks, hook entries, the `AGENTS.md` managed block and the kit's `.gitignore` lines), then prints the commit to make. `kit doctor` checks the global harness and fails while committed leftovers remain. Launchers find the project from the working directory and run only the global kit.
