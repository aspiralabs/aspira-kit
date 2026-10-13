---
'@aspiralabs/groomer': patch
---

The groomer's default (separate-process) mode builds again. Its workflow body imported the fact-finding schemas from `runner.ts`, which pulled `node:fs/promises` into eve's workflow bundle, and eve refused to start the run. The schemas now live in `agent/lib/fact-finding.ts`, which imports only `zod`. Every eve agent's `build` is now `eve build`, and root `pnpm build` (and so CI) builds the agents, so a workflow body that reaches a Node.js builtin fails the build instead of the first run.
