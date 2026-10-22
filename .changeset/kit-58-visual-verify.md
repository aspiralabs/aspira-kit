---
"@aspiralabs/visual-verify": minor
"@aspiralabs/build-feature": minor
"@aspiralabs/agent-common": minor
"@aspiralabs/planner": minor
"@aspiralabs/kit": minor
"@aspiralabs/agents": minor
---

KIT-58: visual-verify opens a UI-touching build in a real browser before the gate and reports what it saw. It is a new skill-only package, `/aspira-visual-verify`, that build-feature runs as a phase and that runs on its own (report only) on a ticket In Progress or In Review: Implementation. Projects add an `aspira.json` `dev` entry (`{cwd, command, url, backendDeployed}`) to turn it on.
