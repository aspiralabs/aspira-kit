---
'@aspiralabs/implementor': patch
---

A `--local` build no longer fails at its last step: the board trace, the agent version and the end-of-run board actions are written to the run's work folder (`plan.review/`), not to the path of the exported trace file inside it.
