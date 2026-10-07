# @aspiralabs/kit

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
