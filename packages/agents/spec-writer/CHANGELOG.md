# @aspiralabs/spec-writer

## 0.8.11

### Patch Changes

- Updated dependencies [db3dd67]
  - @aspiralabs/spec-reviewer@0.8.11
  - @aspiralabs/agent-common@0.8.11

## 0.8.10

### Patch Changes

- @aspiralabs/agent-common@0.8.10
- @aspiralabs/spec-reviewer@0.8.10

## 0.8.9

### Patch Changes

- Updated dependencies [26450eb]
  - @aspiralabs/spec-reviewer@0.8.9
  - @aspiralabs/agent-common@0.8.9

## 0.8.8

### Patch Changes

- 60c39c6: Under `--local`, the spec writer's and spec reviewer's research subagents may read Notion (the MCP's read tools) and public documentation (WebFetch, WebSearch) for a fact that lives outside the repository, citing the URL or page with the quoted line (KIT-33). Before, every subagent prompt limited them to repository reads, so a vendor limit, an infrastructure behaviour or a Notion decision was always an evidence gap only the author could close.
- Updated dependencies [60c39c6]
  - @aspiralabs/spec-reviewer@0.8.8
  - @aspiralabs/agent-common@0.8.8

## 0.8.7

### Patch Changes

- Updated dependencies [d4bef0e]
  - @aspiralabs/spec-reviewer@0.8.7
  - @aspiralabs/agent-common@0.8.7

## 0.8.6

### Patch Changes

- @aspiralabs/agent-common@0.8.6
- @aspiralabs/spec-reviewer@0.8.6

## 0.8.5

### Patch Changes

- Updated dependencies [f18d295]
  - @aspiralabs/spec-reviewer@0.8.5
  - @aspiralabs/agent-common@0.8.5

## 0.8.4

### Patch Changes

- 048c839: A repository file over the index size budget no longer ends a run incomplete (KIT-29). The index names every file it left out for size in the evidence packet ("Not indexed (size budget): <path>"), so the model reads it directly when the work touches it; the spec writer, spec reviewer and planner no longer turn those notes into problems. Before, every run on a repository with one tracked file over 256 KB ended incomplete whatever the output said.
- Updated dependencies [048c839]
  - @aspiralabs/agent-common@0.8.4
  - @aspiralabs/spec-reviewer@0.8.4

## 0.8.3

### Patch Changes

- e9e31fa: A feature in a spec's Features list may carry its detail in indented bullets beneath it (KIT-27). The business-spec check counted every bullet, indented ones included, as a feature and failed a spec whose features had sub-bullets with "Every feature must have an unchecked, unique F-number", naming no line. It now holds only top-level bullets to the `- [ ] F<n>:` form and names the lines that are not. The spec writer's draft prompt and the review pipeline's contract say so.
- Updated dependencies [e9e31fa]
  - @aspiralabs/agent-common@0.8.3
  - @aspiralabs/spec-reviewer@0.8.3

## 0.8.2

### Patch Changes

- Updated dependencies [bcb410e]
  - @aspiralabs/agent-common@0.8.2
  - @aspiralabs/spec-reviewer@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [45d3cdb]
  - @aspiralabs/agent-common@0.8.1
  - @aspiralabs/spec-reviewer@0.8.1

## 0.8.0

### Patch Changes

- @aspiralabs/agent-common@0.8.0
- @aspiralabs/spec-reviewer@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [d219f21]
  - @aspiralabs/agent-common@0.7.4
  - @aspiralabs/spec-reviewer@0.7.4

## 0.7.3

### Patch Changes

- Updated dependencies [a09d6de]
  - @aspiralabs/agent-common@0.7.3
  - @aspiralabs/spec-reviewer@0.7.3

## 0.7.2

### Patch Changes

- Updated dependencies [d51d79c]
  - @aspiralabs/agent-common@0.7.2
  - @aspiralabs/spec-reviewer@0.7.2

## 0.7.1

### Patch Changes

- @aspiralabs/agent-common@0.7.1
- @aspiralabs/spec-reviewer@0.7.1

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

- 9212f60: `/aspira-groomer <ID>` grooms a Backlog card before it reaches Ready: Idea: it moves the card Idea → Grooming, interviews the author in rounds on the ticket's Grooming Decisions page, grounded in the repository, and on Confirm writes the settled Decisions and Terms into the Idea and moves the card to Shortlist; moving it on to Ready: Idea stays the human's step. `kit init` installs the seventh skill, `@aspiralabs/agents` brings in `@aspiralabs/groomer`, and `kit next` sends Idea and Grooming cards to the groomer. The spec writer, spec reviewer, planner and implementor treat a groomed spec's `## Decisions` section as settled and do not reopen it.

  Also in `@aspiralabs/agent-common`: the Idea a ticket pull reads now ends at the next heading of its own level or shallower, so `###` subsections under `## Idea` (the groomer's Decisions and Terms) reach every skill's `idea.md`; a ticket page Notion truncates is refused instead of read partially.

- 2809ee1: Every skill writes a progress note and reports its real run status (KIT-2)
- 1b303a9: The groomer's tools now read and write only the repository and working folder the launcher started the run on. A settled `## Decisions` item no longer waives a MUST guideline rule or the `@aspiralabs/ui` reuse rule; the reviewer still raises it as a finding. The spec writer treats only the groomer's marked Decisions list as settled, not a hand-typed one. A decision whose reasoning ends with a full stop no longer blocks the Idea summary.
- 00fb30a: The skill launchers work in a repository that installs its own agents, such as the kit checkout running `/aspira-*` on itself: a launcher that finds its own package through the root `node_modules` treats it as the package, so the project (and its `.env.local`) is still the working directory's.
- Updated dependencies [9212f60]
- Updated dependencies [f99dcc2]
- Updated dependencies [f8eb4f6]
- Updated dependencies [49ccda8]
- Updated dependencies [2809ee1]
- Updated dependencies [267beb0]
- Updated dependencies [1b303a9]
- Updated dependencies [00fb30a]
  - @aspiralabs/agent-common@0.7.0
  - @aspiralabs/spec-reviewer@0.7.0

## 0.6.1

### Patch Changes

- @aspiralabs/agent-common@0.6.1
- @aspiralabs/spec-reviewer@0.6.1

## 0.6.0

### Patch Changes

- @aspiralabs/agent-common@0.6.0
- @aspiralabs/spec-reviewer@0.6.0

## 0.5.5

### Patch Changes

- @aspiralabs/agent-common@0.5.5
- @aspiralabs/spec-reviewer@0.5.5

## 0.5.4

### Patch Changes

- @aspiralabs/agent-common@0.5.4
- @aspiralabs/spec-reviewer@0.5.4

## 0.5.3

### Patch Changes

- @aspiralabs/agent-common@0.5.3
- @aspiralabs/spec-reviewer@0.5.3

## 0.5.2

### Patch Changes

- @aspiralabs/agent-common@0.5.2
- @aspiralabs/spec-reviewer@0.5.2

## 0.5.1

### Patch Changes

- @aspiralabs/agent-common@0.5.1
- @aspiralabs/spec-reviewer@0.5.1

## 0.5.0

### Minor Changes

- 375e69c: The agents are installed packages, not a source checkout. The seven agent packages publish with the kit at one version, and a new `@aspiralabs/agents` brings all of them into a project as one devDependency. `kit init` adds it and writes `.claude/skills/aspira-<agent>/` for each agent as a copy of the installed package's skill with a `.kit-version`; `kit doctor` prints the installed `@aspiralabs/agents` version and fails when a skill folder is missing or from another version. The `~/.claude/skills` symlinks are retired; the kit README says how to remove them.

  Every launcher resolves its agent as `<AGENT>_AGENT_DIR` (kit development only), then the package installed under the project, then its own location, and no longer reads `$ASPIRA_KIT`; one that lands on a checkout says it is running kit source. The agents run from `node_modules` with Node and amaro, reading the project's `.env.local` first, and every run reports and records the agent package version it ran. `kit init` also ships the `.claude/settings.json` hooks template again, which had been committed empty.

- 808d84f: The Feature Board ticket is the argument of every skill. `/aspira-spec-writer`, `spec-reviewer`, `planner`, `implementor`, `code-analyzer` and `pr-reviewer` take a ticket ID such as `NOM-4`, a Notion page URL, or nothing when `.work/` holds one ticket; a file path needs `--no-ticket`. Before any model call a skill checks the ticket's Status against its row of the gate table and refuses, naming the Status it needs and who makes that move, when the Status is another. It pulls the ticket's pages into `.work/<id>-<slug>/` (`ticket.md`, `idea.md`, `spec.md`, `spec.reviewed/spec.reviewed.md`, `plan.review/plan.reviewed.md`, `plan.review/implementation.md`), leaving an unchanged file alone and refusing to overwrite a local file newer than its page without `--force-pull`. The spec writer, planner and implementor claim the card (Dev set, their In Progress status) on start and move it to their In Review status on success, the implementor only once it opened the PR; the reviewers and the analyzer make no move; nothing moves a card to a Ready column. On success each skill pushes its output back to the ticket under a fixed title (Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review); a push failure is reported with the local path and the success move is still made. In `--local` the driver prints a `board` stage before `knowledge` with the actions for the session to perform with the Notion MCP, verifies `ticket.md` between steps and ends with a `--verify` step; a separate-process run does the same through the shared board module with `NOTION_TOKEN`. Every board action lands in the run's trace with the Status before and after, and every report starts with the ticket, the moves, the pages pushed and the working folder.

  `kit init --board <Feature Board URL>` writes `aspira.json` (with `--releases` for the Releases page), `kit doctor` checks it, and `kit next [<ticket>]` prints a ticket's Status with the Playbook step, command and owner. `kit playbook` renders the Playbook section of From Idea to Release from the same table.

### Patch Changes

- Updated dependencies [375e69c]
- Updated dependencies [808d84f]
  - @aspiralabs/agent-common@0.5.0
  - @aspiralabs/spec-reviewer@0.5.0
