---
'@aspiralabs/spec-reviewer': patch
'@aspiralabs/planner': patch
'@aspiralabs/agent-common': patch
---

Spec reviewer (KIT-36): every decided author decision, the author's answers and the ones taken as recommended, is written into the reviewed spec's `## Decisions` section, so the planner reads them as settled instead of raising them again. Planner: research and the plan may carry `notes`, observations the implementer should re-verify (a large file read only at a cited window, a line number not re-checked, a catalog with nothing in it, a test suite outside CI), rendered under "## Notes" in the plan and never a reason the plan is not ready; a gap is only evidence the phase could not get. Under `--local`, research reads a Notion page the spec names as changed or mirrored instead of leaving it as a gap.
