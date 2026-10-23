# @aspiralabs/visual-verify

`/aspira-visual-verify` opens a UI-touching build in a real browser and reports what it saw against the spec's acceptance criteria. It is a skill-only package: a skill and its driver, and no eve agent.

It runs in two places:

- **A build-feature phase before the gate.** `/aspira-build-feature` runs it after the build and before the gate when the plan touches UI.
- **Standalone, report-only.** `/aspira-visual-verify <ID>` on a ticket In Progress: Implementation or In Review: Implementation writes its report and changes nothing. Any other status is refused.

It is turned on by a `dev` entry in the project's `aspira.json`:

```json
{ "dev": { "cwd": ".", "command": "pnpm dev", "url": "http://localhost:3000", "backendDeployed": true } }
```

`cwd` is where the dev server starts, `command` starts it, `url` is where it answers, and `backendDeployed` says whether the app talks to a deployed backend. Without the entry the run skips and says why in its report.

The CLI exits by run status: exit 0 is ready (or skipped), 1 incomplete or blocked, 3 refused, 5 needs-author.
