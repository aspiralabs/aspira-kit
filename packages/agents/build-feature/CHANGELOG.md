# @aspiralabs/build-feature

## 0.8.12

### Patch Changes

- @aspiralabs/kit@0.8.12
- @aspiralabs/agent-common@0.8.12
- @aspiralabs/pr-reviewer@0.8.12

## 0.8.11

### Patch Changes

- Updated dependencies [db3dd67]
  - @aspiralabs/agent-common@0.8.11
  - @aspiralabs/pr-reviewer@0.8.11
  - @aspiralabs/kit@0.8.11

## 0.8.10

### Patch Changes

- @aspiralabs/kit@0.8.10
- @aspiralabs/agent-common@0.8.10
- @aspiralabs/pr-reviewer@0.8.10

## 0.8.9

### Patch Changes

- @aspiralabs/kit@0.8.9
- @aspiralabs/agent-common@0.8.9
- @aspiralabs/pr-reviewer@0.8.9

## 0.8.8

### Patch Changes

- @aspiralabs/kit@0.8.8
- @aspiralabs/agent-common@0.8.8
- @aspiralabs/pr-reviewer@0.8.8

## 0.8.7

### Patch Changes

- @aspiralabs/kit@0.8.7
- @aspiralabs/agent-common@0.8.7
- @aspiralabs/pr-reviewer@0.8.7

## 0.8.6

### Patch Changes

- 0f7a1dd: The slowest build-feature test files are split by describe block so CI shards finish together, and two kit tests (`kit worktree` T49, `kit cleanup` T31) no longer depend on running as a non-root user. The reusable `kit-checks` workflow takes a `runs-on` input for the runner label (default `ubuntu-latest`).
- Updated dependencies [0f7a1dd]
  - @aspiralabs/kit@0.8.6
  - @aspiralabs/agent-common@0.8.6
  - @aspiralabs/pr-reviewer@0.8.6

## 0.8.5

### Patch Changes

- 4818573: Tests no longer depend on each other. build-feature's tests run concurrently within a file (each builds its own fixture, and temp folders are removed once per file), and the kit's install test does its one `kit init` in setup instead of in its first test. The reusable `kit-checks` workflow now runs build, lint, typecheck and each test shard as separate parallel jobs; a product keeps today's behaviour by default and can pass `prepare` and `test-shards` to narrow the pre-build and shard its tests.
- Updated dependencies [4818573]
  - @aspiralabs/kit@0.8.5
  - @aspiralabs/agent-common@0.8.5
  - @aspiralabs/pr-reviewer@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [048c839]
  - @aspiralabs/agent-common@0.8.4
  - @aspiralabs/pr-reviewer@0.8.4
  - @aspiralabs/kit@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [e9e31fa]
  - @aspiralabs/agent-common@0.8.3
  - @aspiralabs/pr-reviewer@0.8.3
  - @aspiralabs/kit@0.8.3

## 0.8.2

### Patch Changes

- Updated dependencies [bcb410e]
  - @aspiralabs/agent-common@0.8.2
  - @aspiralabs/pr-reviewer@0.8.2
  - @aspiralabs/kit@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [45d3cdb]
  - @aspiralabs/agent-common@0.8.1
  - @aspiralabs/pr-reviewer@0.8.1
  - @aspiralabs/kit@0.8.1

## 0.8.0

### Minor Changes

- d9ffa72: `--autonomous` (KIT-24): `/aspira-build-feature <ID> --local --autonomous` skips the human gates. The groomer step runs with `--autonomous`: every open question is taken as its recommended option, the exit-criterion ones (problem, who, done) included, no chat round is printed, and the run confirms itself once every branch is visited (the Idea summary is still written and the card still moves Grooming → Shortlist → Ready: Idea). A build-feature `ask` whose quoted decision carries a recommended option is answered with it and recorded under asked. The flag is recorded on the run, carried by the resume command and named in the Build Summary's mode line. `--autonomous` without `--local` is refused. The merge stays human.

### Patch Changes

- @aspiralabs/kit@0.8.0
- @aspiralabs/agent-common@0.8.0
- @aspiralabs/pr-reviewer@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [d219f21]
  - @aspiralabs/agent-common@0.7.4
  - @aspiralabs/pr-reviewer@0.7.4
  - @aspiralabs/kit@0.7.4

## 0.7.3

### Patch Changes

- Updated dependencies [a09d6de]
  - @aspiralabs/agent-common@0.7.3
  - @aspiralabs/pr-reviewer@0.7.3
  - @aspiralabs/kit@0.7.3

## 0.7.2

### Patch Changes

- d51d79c: A build-feature run on a fresh ticket reaches its first step (KIT-21). A step skill run with `--parent-run` now finds the build-feature folder of a ticket that has no `ticket.md` yet (`.work/<id>/` holding the run state) and resolves the ticket into it, instead of refusing with "the ticket has no working folder yet". The worktree stage runs the project's install and build in the `app` directory `aspira.json` names, not only at the worktree root.
- Updated dependencies [d51d79c]
  - @aspiralabs/agent-common@0.7.2
  - @aspiralabs/pr-reviewer@0.7.2
  - @aspiralabs/kit@0.7.2

## 0.7.1

### Patch Changes

- 28821d6: The run-start approval is the invocation itself (KIT-20). The driver records who ran `/aspira-build-feature` (the git user of the checkout, else the shell user), when, and the command, at run start; no `approval` stage asks the session to call notion-get-self and write an approval file, which the Claude Code auto-mode classifier refuses as self-approval. A run pending on the old stage still has its answer read once.
  - @aspiralabs/kit@0.7.1
  - @aspiralabs/agent-common@0.7.1
  - @aspiralabs/pr-reviewer@0.7.1

## 0.7.0

### Minor Changes

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

- 2809ee1: Every skill writes a progress note and reports its real run status (KIT-2)
- Updated dependencies [9212f60]
- Updated dependencies [f99dcc2]
- Updated dependencies [f8eb4f6]
- Updated dependencies [49ccda8]
- Updated dependencies [2809ee1]
- Updated dependencies [267beb0]
- Updated dependencies [1b303a9]
- Updated dependencies [00fb30a]
  - @aspiralabs/agent-common@0.7.0
  - @aspiralabs/kit@0.7.0
  - @aspiralabs/pr-reviewer@0.7.0
