---
'@aspiralabs/ai': patch
---

Fixes for the bugs the ScoopLine SCOOP-4 run hit on 0.20.1:

- Spec review and planner ask once more for only the rule rows still missing before counting a rule uncovered (KIT-81).
- Groomer normalizes fact quotes with backticks or line breaks, and a Grooming Decisions pull equal to the old copy no longer loops the board stage (KIT-82).
- build-feature `--approve <spec-writer|planner> --reason "<why>"` records an author approval of a stopped step's output and continues the run (KIT-83).
- The planner plans from a spec the author approved, not only from a clean review banner (KIT-84).
- Exports keep the session's `trace/session-usage.json` instead of refusing it or moving it to history (KIT-85).
- `--verify` reports the run status the export computed (KIT-86).
- The planner reruns from In Review: Plan after the author answers a decision; build-feature moves to Ready: Plan only on a ready plan (KIT-87).
- A step that stops the run reads the card again, so the Build Summary shows its real Status (KIT-88).
- The planner's research and planning prompts carry the author's ticked decisions (KIT-89), matched by decision id rather than question text (KIT-90).
- The board stage gates on the board's Status, not a stale `ticket.md` (KIT-91), and does not pull pages whose content has not changed (KIT-92).
