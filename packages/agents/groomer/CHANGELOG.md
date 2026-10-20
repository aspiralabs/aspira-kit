# @aspiralabs/groomer

## 0.8.10

### Patch Changes

- @aspiralabs/agent-common@0.8.10

## 0.8.9

### Patch Changes

- @aspiralabs/agent-common@0.8.9

## 0.8.8

### Patch Changes

- @aspiralabs/agent-common@0.8.8

## 0.8.7

### Patch Changes

- @aspiralabs/agent-common@0.8.7

## 0.8.6

### Patch Changes

- @aspiralabs/agent-common@0.8.6

## 0.8.5

### Patch Changes

- @aspiralabs/agent-common@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [048c839]
  - @aspiralabs/agent-common@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [e9e31fa]
  - @aspiralabs/agent-common@0.8.3

## 0.8.2

### Patch Changes

- bcb410e: The Idea summary validator accepts an `_Avoid_:` line written indented under its term, as a markdown continuation (KIT-26); before, it refused the summary with "unexpected block in Terms". The summary prompts now say each `_Avoid_:` goes on its own unindented line right after its term.
- Updated dependencies [bcb410e]
  - @aspiralabs/agent-common@0.8.2

## 0.8.1

### Patch Changes

- 45d3cdb: A Confirm confirms every decided question (KIT-25). The Idea summary lists the decisions taken as recommended (`--take-recommended`, `--autonomous`) beside the author's, and the summary validator accepts and requires them; before, the summary prompt named only the author's decisions and the validator refused a summary that listed a taken one, so a confirmed grooming either lost its taken decisions from the Idea the spec writer reads or could not finish.
- Updated dependencies [45d3cdb]
  - @aspiralabs/agent-common@0.8.1

## 0.8.0

### Minor Changes

- d9ffa72: `--autonomous` (KIT-24): `/aspira-build-feature <ID> --local --autonomous` skips the human gates. The groomer step runs with `--autonomous`: every open question is taken as its recommended option, the exit-criterion ones (problem, who, done) included, no chat round is printed, and the run confirms itself once every branch is visited (the Idea summary is still written and the card still moves Grooming → Shortlist → Ready: Idea). A build-feature `ask` whose quoted decision carries a recommended option is answered with it and recorded under asked. The flag is recorded on the run, carried by the resume command and named in the Build Summary's mode line. `--autonomous` without `--local` is refused. The merge stays human.

### Patch Changes

- @aspiralabs/agent-common@0.8.0

## 0.7.4

### Patch Changes

- d219f21: A `--local` groomer round reads the ticks made on Grooming Decisions since the last round (KIT-23). The board stage asks the Grooming Decisions pull (and the run marker) again at the start of every round after the first, and the round's base record merges the ticks the pulled page carries, so a question answered on the page between rounds, or between runs of a paused round under build-feature, is not asked again. The pull is recorded in `groom/trace/board.json` per round.
- Updated dependencies [d219f21]
  - @aspiralabs/agent-common@0.7.4

## 0.7.3

### Patch Changes

- a09d6de: The groomer grooms Bug cards as it grooms Features (KIT-22). Until the Diagnoser (KIT-9) exists, a Bug goes through the same path: `/aspira-groomer` and a `/aspira-build-feature` run on a Bug at Idea no longer refuse with "grooms Feature cards only". A Chore is still refused, and a card with no Type is still refused naming the Types it takes.
- Updated dependencies [a09d6de]
  - @aspiralabs/agent-common@0.7.3

## 0.7.2

### Patch Changes

- Updated dependencies [d51d79c]
  - @aspiralabs/agent-common@0.7.2

## 0.7.1

### Patch Changes

- @aspiralabs/agent-common@0.7.1

## 0.7.0

### Minor Changes

- 9212f60: `/aspira-groomer <ID>` grooms a Backlog card before it reaches Ready: Idea: it moves the card Idea → Grooming, interviews the author in rounds on the ticket's Grooming Decisions page, grounded in the repository, and on Confirm writes the settled Decisions and Terms into the Idea and moves the card to Shortlist; moving it on to Ready: Idea stays the human's step. `kit init` installs the seventh skill, `@aspiralabs/agents` brings in `@aspiralabs/groomer`, and `kit next` sends Idea and Grooming cards to the groomer. The spec writer, spec reviewer, planner and implementor treat a groomed spec's `## Decisions` section as settled and do not reopen it.

  Also in `@aspiralabs/agent-common`: the Idea a ticket pull reads now ends at the next heading of its own level or shallower, so `###` subsections under `## Idea` (the groomer's Decisions and Terms) reach every skill's `idea.md`; a ticket page Notion truncates is refused instead of read partially.

- f99dcc2: New `/aspira-build-feature` skill: a skill-only package, `@aspiralabs/build-feature`, that steps a deterministic driver through the whole AI-DLC process for a Feature Board ticket — idea to a reviewed, merge-ready PR — running each stage as a subagent of a `--local` Claude Code session instead of launching an agent. `kit init` installs it with the other `/aspira-*` skills via `@aspiralabs/agents`.

  `groomer`, `spec-writer`, `spec-reviewer` and `planner` take a shared `--take-recommended` option that answers non-exit-criteria questions with the recommended choice instead of asking, so build-feature's steps can run unattended; the decision records which answers were agent-taken so a rerun or a human override can tell. `@aspiralabs/kit` now exports a `playbook` entry point (`@aspiralabs/kit/playbook`) that build-feature's driver imports to route each ticket Status.

  `/aspira-build-feature` runs in two modes: with `--local` every step skill runs with `--local` in the session; without it every step runs its skill's default cloud-agent mode and the run waits on it (the mode is in the run state and the Build Summary). Each run works the ticket in its own git worktree, `.worktrees/<TYPE>-<ID>` on `<feat|fix|chore>/<id>-<slug>` from the card's Type, and pushes with `git push -u origin HEAD` from there. `@aspiralabs/agent-common`'s `resolve-ticket` script now also prints the card's `type`.

  The project gate runs every command with credentials (Notion, GitHub, npm, AI Gateway tokens and any `*_TOKEN`, `*_SECRET`, `*_KEY` or `*_PASSWORD` variable) removed from its environment. In cloud mode, gate scripts in `package.json` that differ from `origin/main` are shown to the human as a diff and run only on their "run" answer.

- 49ccda8: Run telemetry: every run of an `/aspira-*` skill on a ticket writes one OpenTelemetry JSON file, `.work/<id>-<slug>/telemetry/<run-id>.json`, with the run's timings and, where they are measured, its tokens, tool calls and cost per phase or subagent. When the Feature Board rules list the run telemetry file (BOARD-003), the file is attached to the end of the ticket page as one file block. A telemetry failure is only a notice: it never changes a run's status, a card's move or an exit code.

  - Default (cloud) runs: `ticket.ts start` prints `run-id=` and `run-started=`; every launcher passes them back to `ticket.ts finish` as `--run-id` and `--run-started`, which writes the file from the agent's usage file and attaches it.
  - `--local` runs: the session writes a session usage report for its subagents (`<export>/trace/session-usage.json`; code-analyzer's `.static-analysis/session-usage.json`), the driver prints where and for which run id, writes the file at the export, and lists a `read board-rules` and an `attach` action; the session passes the attach result to the verify step with the new `--attach '{"blockId": …}'` option.
  - `--parent-run <run-id>:<nonce>`: every launcher and local driver accepts it (a malformed value is refused, exit 3, naming the option). It marks a step of an `/aspira-build-feature` run, which writes and attaches no telemetry of its own.
  - `/aspira-build-feature` writes one telemetry file per run with its steps, their subagents and the orchestration, adds a Run telemetry table to the Build Summary, attaches the file in a new `telemetry` stage, and refuses to start a step when a step skill's `.kit-version` is not its own version (`kit init` fixes it).

- 267beb0: Every skill now ends its run in one of five statuses — `ready`, `needs-author`, `incomplete`, `refused` or `blocked` — instead of each skill's own word (`complete`, `clean`, `confirmed`, `stopped`, `partial`, `nothing-detected`, `failed`). A launcher exits by the status: 0 for `ready`, 1 for `incomplete` or `blocked`, 3 for `refused` and 5 for `needs-author` (its own code, so a script can tell a run waiting on the author from a failure); every non-ready status carries the status word and a reason in its JSON. `readRunStatus` (`@aspiralabs/agent-common/lib/run-status`) still reads every old per-skill word, mapped onto its new status and reason code, so a record written before this change keeps resolving.

  Every `--local` driver writes `.work/<id>-<slug>/progress.md` after each stage: the ticket, its outputs, what finished, decisions taken, open issues and the one Next action to run, so a fresh session or a human can see where a ticket stands without re-reading the whole run folder. Every agent's `--local` knowledge stage now loads the engineering guidelines folder itself, once per run, through the shared load-knowledge walk, instead of asking the session to fetch it over the Notion MCP; `--guidelines` (and code-analyzer's and pr-reviewer's `--knowledge DIR`) accepts only a verified load-knowledge snapshot. After a ready implementor or code-analyzer run the note names Step 7 (the next changed app to analyze) or, once every app is analyzed for the ticket, Step 8 as exact commands on the branch the implementor recorded, with the PR body written to `.work/<id>-<slug>/pr-body.md`. Step 8 never stages a `.env*` file at any depth; one left out is named in the note's Open issues. `kit next` recognises Step 8's `git add`/`git commit`, `git push` and `gh pr create` lines through `progress-note-shapes.json`, now shipped in `@aspiralabs/agent-common`.

  The Playbook's Status table moved into `@aspiralabs/agent-common` (`lib/playbook.json`): `@aspiralabs/kit` reads it from there and now depends on `@aspiralabs/agent-common`, never the other way round. `@aspiralabs/kit/playbook` keeps exporting `PLAYBOOK`, `nextStep` and `commandFor`.

  build-feature's PR bodies (and the --local Step 8 note) gained a shared Summary/Evidence/Merge Danger renderer (`@aspiralabs/agent-common/lib/pr-body`): a file tree of the branch's changed files, every implementation task's red/green evidence grouped by feature ID (tailed and redacted), and a one-way/two-way door call for a native dependency or a migration path. build-feature itself now routes on the five statuses, runs each step through its own launcher script instead of the Playbook slash command, and reports its own run status (`buildRunStatus`, one of the five words, never its internal `stopped`/`finished` run-state bookkeeping words): its `end` stage carries the stop reason and status, and it exits by that status (a Dropped or nothing-to-do card now exits 3, refused). While it runs it keeps `.local/build-feature/active.json`, so a step's progress note resumes build-feature, and it writes its own `progress.md` when it stops.

  Every `/aspira-*` launcher skill (and `/aspira-build-feature`) is now `disable-model-invocation: true`: invoke it with its slash command or its launcher script directly, never by asking the model to decide to call it.

  **Breaking for projects.** Rerun `kit init` after upgrading, to pick up the updated skill files. A non-`ready` run now exits non-zero where it used to exit 0 for some old words (`confirmed`, `complete`, `clean`): a CI step or script that only checked for a crash, not the status word, will now see those stops as failures. Every `--local` run now needs `NOTION_TOKEN` in the environment, the app's `.env.local` or the project root's `.env.local` (never the agent package's own env file); without it the run reports `blocked` instead of printing a session fetch stage. A `--guidelines` file that is not a load-knowledge snapshot (for example a copied `trace/guidelines.md`) is refused.

### Patch Changes

- 315b0dd: The groomer's default (separate-process) mode builds again. Its workflow body imported the fact-finding schemas from `runner.ts`, which pulled `node:fs/promises` into eve's workflow bundle, and eve refused to start the run. The schemas now live in `agent/lib/fact-finding.ts`, which imports only `zod`. Every eve agent's `build` is now `eve build`, and root `pnpm build` (and so CI) builds the agents, so a workflow body that reaches a Node.js builtin fails the build instead of the first run.
- 2809ee1: Every skill writes a progress note and reports its real run status (KIT-2)
- 1b303a9: The groomer's tools now read and write only the repository and working folder the launcher started the run on. A settled `## Decisions` item no longer waives a MUST guideline rule or the `@aspiralabs/ui` reuse rule; the reviewer still raises it as a finding. The spec writer treats only the groomer's marked Decisions list as settled, not a hand-typed one. A decision whose reasoning ends with a full stop no longer blocks the Idea summary.
- Updated dependencies [9212f60]
- Updated dependencies [f99dcc2]
- Updated dependencies [f8eb4f6]
- Updated dependencies [49ccda8]
- Updated dependencies [2809ee1]
- Updated dependencies [267beb0]
- Updated dependencies [1b303a9]
  - @aspiralabs/agent-common@0.7.0
