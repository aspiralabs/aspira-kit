# @aspiralabs/build-feature

## 0.11.1

### Patch Changes

- @aspiralabs/kit@0.11.1
- @aspiralabs/agent-common@0.11.1
- @aspiralabs/pr-reviewer@0.11.1

## 0.11.0

### Minor Changes

- da30ab0: KIT-52: every PR description and the feature's section on the release page carry a plain-English "what it fixed" summary that becomes the release notes. The implementor writes `## What it fixed` at the top of `implementation.md` (headline with the ticket and the apps touched; one numbered item per problem fixed with Before and Now in user-visible terms; supporting changes; still to do; loose ends) and the local driver refuses a log without it. The shared PR body renderer puts that section first, verbatim (secrets redacted, markdown kept), with a visible placeholder when the log has none; the cloud implementor's pull request body starts with it. build-feature's release-row stage carries it as `whatItFixed` and has the session add `### <ID> — what it fixed` under the Features table of the open release page. `kit playbook` Steps 10 and 11 name it.

### Patch Changes

- Updated dependencies [da30ab0]
  - @aspiralabs/agent-common@0.11.0
  - @aspiralabs/pr-reviewer@0.11.0
  - @aspiralabs/kit@0.11.0

## 0.10.0

### Minor Changes

- 23c44cf: KIT-51: running in the session is the default mode of every `/aspira-*` skill, and `--cloud` is the flag for the separate agent. `/aspira-<skill> <ID>` now does what `<ID> --local` did; `--local` is still accepted and means the default. `/aspira-build-feature <ID>` runs every step in the session and `--cloud` runs every step's cloud agent (`--autonomous` is refused with `--cloud`). The Playbook rows, `kit playbook`, the progress notes' Next action and the build-feature resume command print the commands without `--local`; a cloud run's commands carry `--cloud`. The launchers accept `--cloud` and `--local` and refuse the one that contradicts the subcommand.

### Patch Changes

- Updated dependencies [23c44cf]
  - @aspiralabs/agent-common@0.10.0
  - @aspiralabs/pr-reviewer@0.10.0
  - @aspiralabs/kit@0.10.0

## 0.9.2

### Patch Changes

- Updated dependencies [de787ea]
  - @aspiralabs/agent-common@0.9.2
  - @aspiralabs/pr-reviewer@0.9.2
  - @aspiralabs/kit@0.9.2

## 0.9.1

### Patch Changes

- 1fcdff8: A build-feature run starts a fresh ticket from any Status, cloud mode included (KIT-49). The cloud `start` of a step skill now pulls a ticket that has no ticket.md yet into the run's own working folder instead of refusing `--parent-run` (the --local path already did since KIT-21); the driver creates its stage output directory before printing a stage (the worktree stage's did not exist); and the ticket worktree gets the main checkout's root and app `.env.local` linked in before the install, as `kit worktree` does.
- Updated dependencies [1fcdff8]
  - @aspiralabs/agent-common@0.9.1
  - @aspiralabs/pr-reviewer@0.9.1
  - @aspiralabs/kit@0.9.1

## 0.9.0

### Minor Changes

- 3412b52: KIT-48: cut build-feature working time. SIFT-11 spent 10.8 hours working, 5.7 of them in subagents; this release removes the waste the run telemetry showed.

  - **Code analyzer on a ticket fixes only the branch's changed files.** Auto-fix and the model fix run on the files the ticket branch changed against `origin/main` (or `main`), with per-file commands (`eslint --fix <files>`, `prettier --write <files>`, ruff, black, gofmt, rubocop); diagnostics in untouched files are reported as pre-existing in `report.md` and `diagnostics.json`, never fixed and never a reason to end incomplete. `--no-ticket` keeps the whole tree.
  - **One spec step.** `/aspira-spec-writer` is the one spec skill: from Ready: Idea it explores, drafts and runs the one specialist review on the draft; from In Review: Spec it reviews the answered spec again (`spec.reviewed/spec.reviewed.md`, or `spec.md`) with no move. Its output is `spec.reviewed/` in the reviewer's layout plus `spec.md`; it pushes Spec, Spec Reviewed and, for needs-author, Spec Review Decisions. The Playbook row for In Review: Spec runs the spec writer. `@aspiralabs/spec-reviewer` is a library only: its skill, eve agent and local driver are gone, and `kit init` removes the old `aspira-spec-reviewer` skill folder.
  - **Parallel exploration.** An idea that names two or more repository areas gets one explorer per area, launched in one message, and the explorations merge; the draft, research and reconciliation prompts are held to the packet (no re-exploration, at most five confirming reads).
  - **One pre-built packet per run.** build-feature writes `.work/<id>-<slug>/packet.md` before each step (the repository map, aspira.json facts, the ticket's files, the guidelines folder) and passes `--packet` to the spec writer and the planner, which put it in front of every phase's context.
  - **Guidelines built once per ticket.** build-feature walks Notion into `.work/<id>-<slug>/knowledge/` on the first step and, before every later step, compares the pages by hash: unchanged, the step gets the folder (`--guidelines <dir>/REQUIRED.md`, or `--knowledge <dir>`); any page changed, the whole folder is rebuilt. Without a token or `KNOWLEDGE_PAGE` every step loads its own, as before.
  - **One consolidated grooming round.** Round 1 asks every question the idea needs across every branch and closes the rest; the driver refuses a round 1 that leaves a branch neither asked nor closed. A second round happens only when an answer invalidates other questions.
  - **Model routing per task.** Every task a `local` stage prints names its `model` (opus, sonnet or haiku); the orchestrating session launches each task's subagent on it. Research and reconciliation on opus, explorers and specialists on sonnet, the analyzer's fixes on haiku; the pr-reviewer's seats follow its own model map. Fable stays the orchestrator.

### Patch Changes

- Updated dependencies [3412b52]
  - @aspiralabs/pr-reviewer@0.9.0
  - @aspiralabs/agent-common@0.9.0
  - @aspiralabs/kit@0.9.0

## 0.8.15

### Patch Changes

- bc71b35: build-feature judges each code-analyzer step by the export under that step's own `--app` directory, commits the fixes every analyzer step recorded and lists every app's result in the PR body (KIT-40). Before, the driver read aspira.json's `app` for every analyzer step, so on a multi-app repository a stale `.static-analysis/rounds.json` under that app ended a run whose per-app steps had all finished ready.
  - @aspiralabs/kit@0.8.15
  - @aspiralabs/agent-common@0.8.15
  - @aspiralabs/pr-reviewer@0.8.15

## 0.8.14

### Patch Changes

- 19dbf83: build-feature runs the code analyzer once per app directory the implementor's record says it changed, each with its own `--app`, and treats static analysis as done only when every one of them ended ready (KIT-39); aspira.json's `app` is used only when the record names no app. Before, the analyzer ran on aspira.json's `app` alone, so on a multi-app repository a ticket's changes in other packages were never analyzed and a kit-only app directory with nothing to lint ended the step incomplete.
  - @aspiralabs/kit@0.8.14
  - @aspiralabs/agent-common@0.8.14
  - @aspiralabs/pr-reviewer@0.8.14

## 0.8.13

### Patch Changes

- 90dab54: The project gate runs each command in its own directory (KIT-38). `aspira.json` may list the gates, `"gates": [{ "cwd": "tools/aspira", "command": "pnpm check" }, ...]`, cwd relative to the repository and `.` by default; when present the list wins over AGENTS.md and the package.json fallback, and the gate stage carries a directory per command (`cwds`) so a multi-app repository runs each where it belongs. Before, every AGENTS.md command ran in that file's directory, which on a repository with no root package.json made every command fail at once.
  - @aspiralabs/kit@0.8.13
  - @aspiralabs/agent-common@0.8.13
  - @aspiralabs/pr-reviewer@0.8.13

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
