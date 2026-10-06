---
'@aspiralabs/kit': patch
---

Agents: every output lands in the ticket's working folder. The PR reviewer writes a local review to `<repo>/.work/<ticket>/pr-review/` (the ticket folder is the branch without its type prefix) and ignores `.work/`, not `.pr-review/`. The implementor builds a ticket from `.work/<ticket>/spec.md` instead of `.implement/<key>/spec.md`, and its commits cite the ticket's Notion URL when `ticket.md` beside the spec names one.
