---
'@aspiralabs/kit': patch
---

pr-reviewer launches again as a cloud agent: the round plan that `pr-debator` runs inside the eve workflow body now lives in a pure module (`agent/lib/plan.ts`) with no Node.js builtin in its import graph, and the `--local` driver imports it instead of the other way round, so eve's workflow bundle no longer refuses `node:fs/promises` at startup. A new test runs `eve build`, the same bundling `eve invoke` and `eve dev` do, so a builtin import reachable from the workflow body fails in CI rather than on launch. Every agent launcher's `agent_json` uses a function instead of an inline `$(case …)`, which bash 3.2 (macOS `/bin/bash`) mis-parsed into a syntax error on every start; the six skill tests now check the `agent.json` each run writes.
