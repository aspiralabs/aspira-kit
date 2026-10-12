---
'@aspiralabs/groomer': patch
'@aspiralabs/agent-common': patch
'@aspiralabs/spec-writer': patch
'@aspiralabs/spec-reviewer': patch
'@aspiralabs/implementor': patch
---

The groomer's tools now read and write only the repository and working folder the launcher started the run on. A settled `## Decisions` item no longer waives a MUST guideline rule or the `@aspiralabs/ui` reuse rule; the reviewer still raises it as a finding. The spec writer treats only the groomer's marked Decisions list as settled, not a hand-typed one. A decision whose reasoning ends with a full stop no longer blocks the Idea summary.
