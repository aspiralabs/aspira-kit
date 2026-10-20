---
'@aspiralabs/agent-common': patch
'@aspiralabs/groomer': patch
---

The Idea summary validator accepts an `_Avoid_:` line written indented under its term, as a markdown continuation (KIT-26); before, it refused the summary with "unexpected block in Terms". The summary prompts now say each `_Avoid_:` goes on its own unindented line right after its term.
