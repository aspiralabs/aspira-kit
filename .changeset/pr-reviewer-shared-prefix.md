---
'@aspiralabs/kit': patch
---

pr-reviewer's seven review sessions share one cached prefix. Each seat's system prompt is now the shared prefix, the packet and the review instructions that are the same for every seat, resolved per session from the context `load-pr` writes, and the persona follows it in the message instead of leading as a static `instructions.md`; the `--local` prompt files take the same order. The Gateway's automatic caching puts the breakpoint at the end of the system prompt, which is the end of that block, and one warm-up call writes it before the six seats run in parallel. With `--max-cost`, the launcher and `pr-debator` refuse before any model call when one round is estimated above the budget, naming both numbers. `cost.md` adds round-one cache writes per seat.
