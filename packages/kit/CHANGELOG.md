# @aspiralabs/kit

## 0.13.0

### Minor Changes

- e6199cd: KIT-58: visual-verify opens a UI-touching build in a real browser before the gate and reports what it saw. It is a new skill-only package, `/aspira-visual-verify`, that build-feature runs as a phase and that runs on its own (report only) on a ticket In Progress or In Review: Implementation. Projects add an `aspira.json` `dev` entry (`{cwd, command, url, backendDeployed}`) to turn it on.

### Patch Changes

- Updated dependencies [e6199cd]
  - @aspiralabs/agent-common@0.13.0

## 0.12.0

### Minor Changes

- 87ad569: KIT-54: research can happen at any stage. One research rule, verbatim in every in-session task prompt and every cloud agent's instructions: anything missing or vague is looked up first, in the repository's code, in Notion (any page or database the rules, the ticket, the idea or the spec point to) and in public documentation; what a phase was given is a head start, not a wall; "unknown" or a gap only once that research is exhausted, naming where it looked. The cloud research, reconciliation, draft and planning phases now read through tools (they were tool-less structured calls), with `notion_read` and `notion_search` on the integration token for any Notion page or database. The planner no longer fails on research or plan gaps: they are notes for the approver, listed as `openGaps`. The guidelines snapshot's INDEX.md lists the databases the rules link (Approved Technologies, ADRs) and how to read their rows.

### Patch Changes

- Updated dependencies [87ad569]
  - @aspiralabs/agent-common@0.12.0

## 0.11.1

### Patch Changes

- @aspiralabs/agent-common@0.11.1

## 0.11.0

### Minor Changes

- da30ab0: KIT-52: every PR description and the feature's section on the release page carry a plain-English "what it fixed" summary that becomes the release notes. The implementor writes `## What it fixed` at the top of `implementation.md` (headline with the ticket and the apps touched; one numbered item per problem fixed with Before and Now in user-visible terms; supporting changes; still to do; loose ends) and the local driver refuses a log without it. The shared PR body renderer puts that section first, verbatim (secrets redacted, markdown kept), with a visible placeholder when the log has none; the cloud implementor's pull request body starts with it. build-feature's release-row stage carries it as `whatItFixed` and has the session add `### <ID> — what it fixed` under the Features table of the open release page. `kit playbook` Steps 10 and 11 name it.

### Patch Changes

- Updated dependencies [da30ab0]
  - @aspiralabs/agent-common@0.11.0

## 0.10.0

### Minor Changes

- 23c44cf: KIT-51: running in the session is the default mode of every `/aspira-*` skill, and `--cloud` is the flag for the separate agent. `/aspira-<skill> <ID>` now does what `<ID> --local` did; `--local` is still accepted and means the default. `/aspira-build-feature <ID>` runs every step in the session and `--cloud` runs every step's cloud agent (`--autonomous` is refused with `--cloud`). The Playbook rows, `kit playbook`, the progress notes' Next action and the build-feature resume command print the commands without `--local`; a cloud run's commands carry `--cloud`. The launchers accept `--cloud` and `--local` and refuse the one that contradicts the subcommand.

### Patch Changes

- Updated dependencies [23c44cf]
  - @aspiralabs/agent-common@0.10.0

## 0.9.2

### Patch Changes

- Updated dependencies [de787ea]
  - @aspiralabs/agent-common@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [1fcdff8]
  - @aspiralabs/agent-common@0.9.1

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
  - @aspiralabs/agent-common@0.9.0

## 0.8.15

### Patch Changes

- @aspiralabs/agent-common@0.8.15

## 0.8.14

### Patch Changes

- @aspiralabs/agent-common@0.8.14

## 0.8.13

### Patch Changes

- @aspiralabs/agent-common@0.8.13

## 0.8.12

### Patch Changes

- @aspiralabs/agent-common@0.8.12

## 0.8.11

### Patch Changes

- Updated dependencies [db3dd67]
  - @aspiralabs/agent-common@0.8.11

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

- 0f7a1dd: The slowest build-feature test files are split by describe block so CI shards finish together, and two kit tests (`kit worktree` T49, `kit cleanup` T31) no longer depend on running as a non-root user. The reusable `kit-checks` workflow takes a `runs-on` input for the runner label (default `ubuntu-latest`).
  - @aspiralabs/agent-common@0.8.6

## 0.8.5

### Patch Changes

- 4818573: Tests no longer depend on each other. build-feature's tests run concurrently within a file (each builds its own fixture, and temp folders are removed once per file), and the kit's install test does its one `kit init` in setup instead of in its first test. The reusable `kit-checks` workflow now runs build, lint, typecheck and each test shard as separate parallel jobs; a product keeps today's behaviour by default and can pass `prepare` and `test-shards` to narrow the pre-build and shard its tests.
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

- Updated dependencies [bcb410e]
  - @aspiralabs/agent-common@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [45d3cdb]
  - @aspiralabs/agent-common@0.8.1

## 0.8.0

### Patch Changes

- @aspiralabs/agent-common@0.8.0

## 0.7.4

### Patch Changes

- Updated dependencies [d219f21]
  - @aspiralabs/agent-common@0.7.4

## 0.7.3

### Patch Changes

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

- f8eb4f6: `kit cleanup` deletes the `.work/` folders and `.worktrees/<TYPE>-<ID>` ticket worktrees whose card is Released or Dropped, after listing them with the card's live Status and asking (`--yes` skips the question, `--only` limits it to the confirmed paths); it never removes a worktree with uncommitted or unpushed work and deletes only the local branch, with `git branch -d`. `kit worktree <ticket>` creates or reuses the ticket's worktree on its `feat/`, `fix/` or `chore/` branch from `origin/main`, links `.env.local`, and installs and builds. When it reuses a branch it did not make here under the card's name (for example one that exists only on origin), it prints the branch's last commit and skips install and build, so nobody's scripts run before you have read them; `--install` runs them. `kit init` installs three kit-owned skills, `/aspira-cleanup`, `/aspira-next` and `/aspira-worktree`, which `kit doctor` checks against the `@aspiralabs/kit` version, and writes `.worktrees/` and (unless already ignored) `.env.local` into `.gitignore`; `kit doctor` fails without them. The Playbook's Step 1 mentions `kit worktree` and Step 12 ends with `kit cleanup`.

  `kit next` now finds `@aspiralabs/agent-common` by its package name, so it works in the self-hosting kit checkout, and prints the cause on stderr whenever the board does not answer instead of a bare "see the error above". `@aspiralabs/agent-common`'s `resolve-ticket.ts` also prints the card's `type=` and working-folder `folder=`, and `error=unknown` or `error=unreachable` on failure. `@aspiralabs/kit` now depends on `zod`.

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
  - @aspiralabs/agent-common@0.7.0

## 0.6.1

### Patch Changes

- 718c0d5: `kit init --app` works in a workspace whose root has its own package.json (pnpm-workspace.yaml or a "workspaces" field): it uses the root's `.npmrc`, lockfile, allowBuilds and prettier config instead of writing copies into the app, and moves any @aspiralabs packages the root declares to the same version as the app's. `kit doctor` flags a root kit package on another version. Repositories with no root package.json work exactly as before. The kit now reads JSON with comments and trailing commas, so a commented tsconfig.json no longer stops init or doctor.

## 0.6.0

### Minor Changes

- 8f782ff: `kit init --stack next` takes `--app <dir>` for a repository whose app is not the root: the Next app with its `package.json` and `node_modules` lives in `apps/web`, there is no root `package.json`, and Claude Code runs at the repository root. Run at the root with `--app apps/web`, the package steps (`.npmrc`, the install, `eslint.config.mjs`, `prettier.config.mjs`, `tsconfig.json`, `globals.css`) go into the app and the Claude-facing files go to the root: the `AGENTS.md` managed block, `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, `.claude/skills/aspira-*`, `.gitignore` and `aspira.json`, which records `"app": "apps/web"`. The paths inside those files point into the app: the hooks run as `sh apps/web/node_modules/@aspiralabs/kit/hooks/<name>.sh` and the MCP server as `node apps/web/node_modules/@aspiralabs/ui/bin/mcp.js`. Without `--app` nothing changes.

  `kit doctor --app` checks the app for the package-level items and the root for the Claude-facing items in one run; `kit doctor` and `kit next` read `app` from `aspira.json`, so they need no flag after `init`, and run from inside the app they find the root that wired it. `kit next` resolves the installed agents under the app's `node_modules`. The six skill launchers read `app` from the nearest `aspira.json` above them before walking up from the working directory, so they find the agents under `apps/web/node_modules` when run from the root; a project with no `app` resolves as before, and the `<AGENT>_AGENT_DIR` override still comes first. The audit-log hook writes its log at the project root (`CLAUDE_PROJECT_DIR`) rather than relative to wherever it is invoked.

  `kit init` now also adds `.aspira/` to the root `.gitignore` next to `.work/`, and `kit doctor` checks for it: the audit-log hook writes `.aspira/audit.jsonl` at the root on the first tool call, which otherwise dirties the tree of a freshly wired project. The kit's hook groups and its `aspiralabs-ui` MCP entry are replaced on a re-run of `init` rather than merged, so an entry from an earlier layout does not linger beside the current one.

## 0.5.5

### Patch Changes

- 37d738d: `kit next` finds the agents' TypeScript loader the way Node would, from an installed agent's real location, so it works in a pnpm project (the loader sits two levels up from a scoped package, not beside agent-common). When the board cannot be resolved it now prints the resolver's actual error instead of a guess.

## 0.5.4

### Patch Changes

- a406d37: The board module accepts the Feature Board's database page URL, the one a person copies from Notion and `kit init --board` stores, by looking up the database's data source on first use. Before, only the data source id worked, so `kit next` and every ticket-aware skill answered "the board did not answer" on a freshly initialised project.

## 0.5.3

### Patch Changes

- d267b93: `kit init` approves pnpm build scripts the way pnpm 12.4 expects: `allowBuilds: <name>: true` in `pnpm-workspace.yaml`, replacing the placeholder pnpm writes there, and it retries each install until no new build script is reported (at most five times).

## 0.5.2

### Patch Changes

- 45a0b17: `kit init` approves pnpm build scripts in `pnpm-workspace.yaml` (`onlyBuiltDependencies`), the place pnpm 12 reads, instead of the `pnpm` field of package.json, which pnpm 12 ignores.

## 0.5.1

### Patch Changes

- 109514a: `kit init` installs every `@aspiralabs` package at the kit's own version instead of a bare name, so the four packages stay in lockstep and pnpm 12's minimum-release-age policy cannot resolve a just-released version down to an older one (a fresh 0.5.0 install pulled `@aspiralabs/ui` 0.4.1). When pnpm 12 refuses a dependency's build script, `kit init` approves exactly the packages pnpm named in the project's `pnpm.onlyBuiltDependencies` and reruns the install, instead of failing.

## 0.5.0

### Minor Changes

- 375e69c: The agents are installed packages, not a source checkout. The seven agent packages publish with the kit at one version, and a new `@aspiralabs/agents` brings all of them into a project as one devDependency. `kit init` adds it and writes `.claude/skills/aspira-<agent>/` for each agent as a copy of the installed package's skill with a `.kit-version`; `kit doctor` prints the installed `@aspiralabs/agents` version and fails when a skill folder is missing or from another version. The `~/.claude/skills` symlinks are retired; the kit README says how to remove them.

  Every launcher resolves its agent as `<AGENT>_AGENT_DIR` (kit development only), then the package installed under the project, then its own location, and no longer reads `$ASPIRA_KIT`; one that lands on a checkout says it is running kit source. The agents run from `node_modules` with Node and amaro, reading the project's `.env.local` first, and every run reports and records the agent package version it ran. `kit init` also ships the `.claude/settings.json` hooks template again, which had been committed empty.

- c6e7dcf: `@aspiralabs/config` is eslint, tsconfig and prettier only. Its `agent/` folder is gone: the rules live in Notion (Engineering Central), the `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and settings templates now ship in `@aspiralabs/kit` (`templates/agent/`), and the session hooks in `@aspiralabs/kit/hooks/`. The `./agent/*` export is removed.

  The managed block that `kit init` writes into a project's `AGENTS.md`, and the session-start hook, are pointers only: Agent Instructions for the rules, From Idea to Release and its Playbook for the process and "what is the next step", the Slop Repo and the kit gap pages for lessons. They restate no rule. `kit init` drops settings entries that still point at the retired config hook path.

  Feature work has one layout in every project: a gitignored `.work/<id>-<slug>/` per ticket, pulled from the Notion ticket and never committed. `kit init` adds `.work/` to `.gitignore` instead of creating `specs/`; `kit doctor` checks the ignore line and fails on a committed `specs/`, `docs/plans` or `docs/working-feature` folder.

- 808d84f: The Feature Board ticket is the argument of every skill. `/aspira-spec-writer`, `spec-reviewer`, `planner`, `implementor`, `code-analyzer` and `pr-reviewer` take a ticket ID such as `NOM-4`, a Notion page URL, or nothing when `.work/` holds one ticket; a file path needs `--no-ticket`. Before any model call a skill checks the ticket's Status against its row of the gate table and refuses, naming the Status it needs and who makes that move, when the Status is another. It pulls the ticket's pages into `.work/<id>-<slug>/` (`ticket.md`, `idea.md`, `spec.md`, `spec.reviewed/spec.reviewed.md`, `plan.review/plan.reviewed.md`, `plan.review/implementation.md`), leaving an unchanged file alone and refusing to overwrite a local file newer than its page without `--force-pull`. The spec writer, planner and implementor claim the card (Dev set, their In Progress status) on start and move it to their In Review status on success, the implementor only once it opened the PR; the reviewers and the analyzer make no move; nothing moves a card to a Ready column. On success each skill pushes its output back to the ticket under a fixed title (Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review); a push failure is reported with the local path and the success move is still made. In `--local` the driver prints a `board` stage before `knowledge` with the actions for the session to perform with the Notion MCP, verifies `ticket.md` between steps and ends with a `--verify` step; a separate-process run does the same through the shared board module with `NOTION_TOKEN`. Every board action lands in the run's trace with the Status before and after, and every report starts with the ticket, the moves, the pages pushed and the working folder.

  `kit init --board <Feature Board URL>` writes `aspira.json` (with `--releases` for the Releases page), `kit doctor` checks it, and `kit next [<ticket>]` prints a ticket's Status with the Playbook step, command and owner. `kit playbook` renders the Playbook section of From Idea to Release from the same table.

### Patch Changes

- fa4b805: Agents: every output lands in the ticket's working folder. The PR reviewer writes a local review to `<repo>/.work/<ticket>/pr-review/` (the ticket folder is the branch without its type prefix) and ignores `.work/`, not `.pr-review/`. The implementor builds a ticket from `.work/<ticket>/spec.md` instead of `.implement/<key>/spec.md`, and its commits cite the ticket's Notion URL when `ticket.md` beside the spec names one.
- 01c1b4c: Agents: the shared `agent-common` package gains the two modules the ticket-aware skills build on. `lib/board` is the one client for a product's Feature Board in Notion: it resolves a ticket by ID or URL, moves it between statuses (refusing a move from the wrong status), sets Dev and PR, and pushes or pulls the ticket's child pages such as Spec and Plan. `lib/notion-markdown` converts Notion markdown to plain markdown and plain markdown to Notion blocks, both ways deterministic, so a pulled spec and a pushed plan keep every heading, list item, table cell and code line. No skill uses them yet; that wiring is the next change.
- 95c4fbc: Every list the agents hand to a person is sorted, explained and comes with a recommendation. Findings from the spec reviewer, the spec writer and the PR reviewer, and the planner's readiness problems, are ordered critical, high, medium, low, info, under a header whose count equals the items below it. Every finding carries a plain-English "What this means" line before its evidence. Every decision left to the author (spec review author decisions, planner decisions, the implementor's assumptions) names its options, a recommended option with one sentence of reasoning and why it is the author's call, and is rendered as checkboxes in trace/decisions.md; the next run of the same stage reads a ticked option and records it in review.json as the author's decision. The implementor's assumptions are shown as the recommended option already taken. The PR comment lists every finding in severity order. Each agent's instructions.md says how to report, and the skill-rules tests pin those sentences.
- 3701df3: Implementor: the final verification writes down what the build changed and learned. The procedure's final verification now lists every dependency the build added (a manifest diff between the branch base and HEAD, each addition flagged native when the installed package carries native code and by its Approved Technologies status in the loaded knowledge), rewrites every mid-build notes file from the code at HEAD or deletes it (each backticked identifier checked with `git grep -F`, renames corrected, missing ones removed, a header with the commit SHA), and proposes Slop Repo entries for the bugs it fixed or says why none would recur. The verification output requires `dependenciesAdded`, `notesRewritten` and `slopEntries` (with `slopJustification` when empty): the `--local` driver computes the findings, puts them in the verification prompt and checks the output against the tree, and the cloud agent records the same shape through a new `record-verification` tool that `publish-branch` requires.
- 0331cef: pr-reviewer launches again as a cloud agent: the round plan that `pr-debator` runs inside the eve workflow body now lives in a pure module (`agent/lib/plan.ts`) with no Node.js builtin in its import graph, and the `--local` driver imports it instead of the other way round, so eve's workflow bundle no longer refuses `node:fs/promises` at startup. A new test runs `eve build`, the same bundling `eve invoke` and `eve dev` do, so a builtin import reachable from the workflow body fails in CI rather than on launch. Every agent launcher's `agent_json` uses a function instead of an inline `$(case …)`, which bash 3.2 (macOS `/bin/bash`) mis-parsed into a syntax error on every start; the six skill tests now check the `agent.json` each run writes.
- 70013cb: pr-reviewer sends less context, stops when the verdict is settled, can re-review a delta, and takes a budget. Before round one, `load-pr` builds one packet (the diff, every changed file at HEAD with large files as their changed hunks, the changed paths, the PR, the required reading) that every seat's prompt starts with, so the seats stop reading changed files one call at a time and every call shares a cache prefix. The seats and Quinn get `read_files` (many files in one call) and `search` (grep with two lines of context), are told to batch their reads, and are capped at `MAX_SEAT_CALLS` tool calls a round (default 8). A seat is agreed once Quinn has ruled on its findings, fixed or not, and a round with no dispute and no new finding ends the review; the round cap stays as a ceiling. `--since <previous review dir>` re-reviews only what changed since the head that review recorded: the seats say which previous findings the delta fixes and raise new ones only on the delta, and `findings.md` gains a previous-findings table and a new-findings section. `review.md`, `findings.md` and the PR comment carry the base and head sha the verdict applies to. `--max-cost <USD>` (default `MAX_COST_USD`) stops a cloud run after the call that crosses it and exports what exists as incomplete, and the launcher prints an estimate (diff size, seats, round cap, a dollar range from this package's previous `cost.md` files) before a cloud run unless `--yes`. `cost.md` adds calls per seat per round, the packet size, the cache-read share and the budget. Both the agent and `--local` run the same loop. Also fixes a second local review of a repo that ignores `.work/` failing on `git add`.
- 8b4e957: pr-reviewer's shared packet is an index of the change, not the change. It holds the PR description, `REQUIRED.md`, and one line per changed file with its path, added and deleted lines, an area tag from its path (api, db-migration, web-ui, mobile, lib, test, e2e, docs, config, infra) and the symbols its hunks touch; no diff hunks and no file bodies, so on nomnomzz PR #3 (68 files, 12,448 changed lines) it is under 15,000 tokens instead of 185,000. Each seat picks the files its lens needs from the index and fetches their hunks with the new `read_diff(paths)` tool and the surrounding code with `read_files(paths)`, one batch each, into its own context; Quinn fetches only what findings cite. The packet-wide character cap and the per-file excerpt rule are gone (file truncation stays in `read_files` and `read_diff`), and `--local` maps `read_diff` to the work directory's `pr.patch`.
- c3da657: pr-reviewer launches again: `load-pr` read each seat's `persona.md` (and previous reviews' `cost.md`) from a path built from its own module location, which at launch is eve's compiled snapshot under `.eve/dev-runtime/snapshots/…`, where no authored file exists, so every run died in `load-pr`. Host-side reads now resolve the real package directory from the snapshot location (`agent/lib/package-dir.ts`), and a new test builds eve's own snapshot plan for the package and requires every file the runtime opens at launch to exist where the runtime will look, so a renamed or forgotten file fails in CI rather than on the first run.
- 886224f: pr-reviewer's seven review sessions share one cached prefix. Each seat's system prompt is now the shared prefix, the packet and the review instructions that are the same for every seat, resolved per session from the context `load-pr` writes, and the persona follows it in the message instead of leading as a static `instructions.md`; the `--local` prompt files take the same order. The Gateway's automatic caching puts the breakpoint at the end of the system prompt, which is the end of that block, and one warm-up call writes it before the six seats run in parallel. With `--max-cost`, the launcher and `pr-debator` refuse before any model call when one round is estimated above the budget, naming both numbers. `cost.md` adds round-one cache writes per seat.

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.0

### Minor Changes

- 9e1b4e5: `kit add auth` writes a base Better Auth setup into a Next.js project: server config, client, session helpers, auth emails, Redis and Prisma clients, the route handler, and `.env.example` keys. Options: `--no-passkey`, `--expo <scheme>`. Existing files are kept. CLI errors now print one line instead of a stack trace.

## 0.2.1

## 0.2.0

### Patch Changes

- adcc8e7: `kit init` writes a registry-only `.npmrc` and points at `~/.npmrc` for the token, since pnpm 12 does not expand `${VAR}` in `.npmrc`. `--dry-run` no longer writes files.

## 0.1.0

### Minor Changes

- d898b86: Initial release: the ui library with tokens, docs, and MCP server; shared eslint, tsconfig, prettier, and agent config; the kit CLI.
