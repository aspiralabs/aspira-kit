---
'@aspiralabs/agent-common': patch
'@aspiralabs/groomer': patch
---

A `--local` groomer round reads the ticks made on Grooming Decisions since the last round (KIT-23). The board stage asks the Grooming Decisions pull (and the run marker) again at the start of every round after the first, and the round's base record merges the ticks the pulled page carries, so a question answered on the page between rounds, or between runs of a paused round under build-feature, is not asked again. The pull is recorded in `groom/trace/board.json` per round.
