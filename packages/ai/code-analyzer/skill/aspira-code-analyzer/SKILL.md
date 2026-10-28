---
name: aspira-code-analyzer
description: Run every static analyzer a repository uses (ESLint, tsc, Prettier, Biome, Ruff, mypy, gofmt, go vet, cargo clippy, RuboCop and the project's own lint/typecheck scripts), auto-fix, let the official code-analyzer fix the rest, and loop until clean. Works on a whole repository or one app inside it. By default the analyzers run from the agent's code and this Claude Code session is the fix model; with --cloud it runs code-analyzer as a separate process. Use for /aspira-code-analyzer or requests to clean up lint and type errors across a repo with this agent.
argument-hint: [<ticket ID | Notion URL> [--app DIR] | <repo-path | app-dir | github-url | owner/name> --no-ticket] [--cloud] [--force-pull] [--push] [--parent-run RUN:NONCE]
disable-model-invocation: true
---

# Static analysis

This skill only calls the official `code-analyzer`: do not run the linters or fix diagnostics yourself. The agent's rules (what the fix model may change, what counts as clean, how to report) live in its own files: `agent/instructions.md` in the code-analyzer package is the authority for how a run is reported, and `agent/lib/fixer.ts` holds the fix model's prompt. This file describes only the mechanics.

Both modes use `scripts/code-analyzer.sh` beside this file (use its absolute path). It resolves the package from `CODE_ANALYZER_AGENT_DIR` (kit development only; the report says so), then the global kit (`kit package-dir`). A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket's pages are pulled into `.work/<id>-<slug>/`; the directory to analyze is named with `--app <dir>` (default: the repository root). For a repository with several apps and no root `package.json` (for example `apps/web`, `apps/mobile`, `services/infra`), run once per app with `--app`. A path or a GitHub repository only works with `--no-ticket`, as the argument, for a repository with no board; the run then records `ticket: none`, and `--app` is an error. A path without `--no-ticket` is an error that names the flag. Output goes to `<the analyzed directory>/.static-analysis/` unless `--output` says otherwise.

The analyzer runs only from `In Progress: Implementation` or `In Review: Implementation`. Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the analyzer needs and who makes that move. It makes no board move and pushes nothing; the run's board trace lands in `.static-analysis/board.json`. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file.

| | Default | `--cloud` |
| --- | --- | --- |
| Analyzers, auto-fix, loop and stop rules | the agent's code, run by the `local` step | the agent, in a separate process |
| Fix model | subagents of this session, given the fixer's prompts | the agent's workhorse model through the AI Gateway |
| Engineering guidelines | required: fetched by this session with the Notion MCP, or `--knowledge` / `--guidelines` | required: loaded from Notion by the agent, or `--knowledge` / `--guidelines` |
| Sources | local path only | local path or GitHub repository |
| Cost | this session's usage, not itemized | Gateway, in `usage.json` |

## Default: the session is the fix model

```bash
<skill-dir>/scripts/code-analyzer.sh local [<ticket> [--app DIR] | <repo-path | app-dir> --no-ticket] [--force-pull] [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--finish] [--parent-run RUN:NONCE] [--attach JSON]
```

Each `local` call is one step and makes no model call. Pass the same ticket (or path) and options on every call. It prints JSON: Every task a stage prints names its `model`, and its `effort` when aspira.json `models` sets one for `<step>.<phase>`: launch that task's subagent on that model, passing that reasoning effort to the Agent tool when the task has one.

0. **Board** (first, with a ticket). The board work for this session to perform with the Notion MCP, listed as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not one the analyzer runs from, and lists what is still missing until the folder is in sync. The analyzer lists no `set` or `move`: never move a card anywhere the stage does not list.
1. **Knowledge.** `local`'s own `load-knowledge` step already built the folder, or `blocked` names what to set; a rare `knowledge` stage names a folder problem to fix by hand. Run `local` again either way, or pass `--knowledge DIR`.
2. **Fix stages.** A step prints `stage: "fix"`, `round`, `maxRounds`, `parallel`, `root`, `orchestrator` and `tasks: [{id, prompt, output, files, diagnostics, model}]`. Before printing it, the driver already ran the auto-fixes and the analyzers. For every task, launch one `general-purpose` subagent, model `<task.model>` (KIT-48), with exactly this message, at most `parallel` at a time, all in one message when they fit:

   `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`

   When they have all finished, run `local` again. Do not edit the prompts or fix anything outside the tasks: each prompt is the fixer's own prompt from `agent/lib/fixer.ts`, built on that call, and the next step checks every changed file against the agent's edit guards and reverts what they reject.
3. **Repeat** until the step prints `pending: false`. Do not decide yourself whether another round is needed; the driver applies the agent's stop rules and round cap. With a ticket the finished step carries `board` with no action and no verify step: the analyzer pushes nothing and makes no move, and the trace is complete as printed.

A task that comes back with an `error` wrote an output that failed the fixer's schema; the driver has set it aside. Resend it once to a new subagent with the same message plus the error. `retry: false` means it was already resent. Then, or when a subagent cannot finish, run `local ... --finish`: it takes a last analysis and exports, listing the missing tasks in `missing`.

`--no-fix` only detects and analyzes: no dependency install, no auto-fix, no fix stage. Use it for a read-only check; with `--output` outside the repository nothing is written there. The work directory is `<output>/.local/`; it is removed after export, and every prompt and output is kept in `calls.json`. A remote repository is refused: use `start`.

## `--cloud`: run the agent

`--local` is still accepted and means the default, the section above.

```bash
<skill-dir>/scripts/code-analyzer.sh start [<ticket> [--app DIR] | <repo-path | app-dir | github-url | owner/name> --no-ticket] [--force-pull] [--knowledge DIR | --guidelines FILE] [--push] [--ref BRANCH] [--output /absolute/dir] [--max-rounds N] [--fix-warnings] [--parent-run RUN:NONCE]
```

With a ticket, the launcher does the board work itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing) and the trace after it exits, appended to the run's log. A ticket run analyzes the local checkout; `--push` and `--ref` are for a remote repository with `--no-ticket`.

A local path runs on the host and changes the working tree in place; it needs Node 24, pnpm and the project's toolchain. A GitHub repository is cloned and fixed in the agent's sandbox and its patch lands in the output directory; `--push` asks the agent to push a branch and open a pull request (needs `GITHUB_TOKEN`).

The agent loads the engineering guidelines from Notion with `NOTION_TOKEN` and `KNOWLEDGE_PAGE` from its env. `--knowledge DIR` gives it a guidelines folder instead (`REQUIRED.md`, `INDEX.md`, one file per page, as `load-knowledge` writes it) and `--guidelines FILE` a `REQUIRED.md` snapshot. Without any of them the run refuses and exits non-zero; report that, do not work around it.

The launcher detaches the run and prints its run directory. Tell the user it started and where the report will land. Check on it with `status <run-dir>`, or `wait <run-dir> --max 30` between updates (`watch` is an alias), until it finishes or the user cancels. Do not relaunch a finished run on your own: each `start` is paid. If launch fails, report the error and do not lint by hand.

## Run telemetry

Every run of this skill on a ticket writes one telemetry file, `.work/<id>-<slug>/telemetry/<run-id>.json` (OpenTelemetry JSON: the run, its fix rounds and subagents, with timings, tokens, tool calls and cost where they are measured), and attaches it to the end of the ticket page when the Feature Board rules list it (BOARD-003). A telemetry failure is a notice beside the result: it never changes the run's status, the card's move or the exit code.

- **`--cloud`.** The launcher does it all: `ticket.ts start` prints `run-id=` and `run-started=`, and the finish step after the agent exits writes the file from them and attaches it. Nothing to do here.
- **Default.** The session reports its own usage, since only it sees its subagents:
  1. Record the wall-clock start and end (ISO 8601) of every subagent you launch (every fix batch is its own entry), with the total tokens, tool uses and duration the Agent tool reports for it, and its model when you know it.
  2. Every pending step on a ticket prints `sessionUsage` with a `file` and a `runId`. Before the call that exports the run (the call after the last fix round's outputs are written, or `--finish`), write that `file` (`.static-analysis/session-usage.json`, beside `board.json`; the analyzer's report folder gets no `trace/`) as JSON: `{"runId": "<runId>", "subagents": [{"label": "…", "startedAt": "…", "endedAt": "…", "totalTokens": 0, "toolUses": 0, "wallMs": 0, "model": "…"}]}`, one entry per subagent in launch order. `label` is a short name of your own (`research`, `lane A`), never the task's description or prompt text. Leave out a number you do not have; never guess one. Without the file the run's telemetry records the subagents as missing.
  3. The export's `board.actions` then end with two telemetry actions. `read` (`target: "board-rules"`): fetch the Feature Board rules page with the Notion MCP (`notion-fetch`, read-only) and write it to `file` as plain markdown, one rule per line. `attach`: only when one line of the rules you saved contains every string of `onlyIf`, attach `file`, as `name`, in one file block at the end of the ticket page `page`: `notion-create-attachment` for a file of at most 200 KiB, otherwise `notion-create-file-upload`, then `notion-update-page`. Attach no other file, to no other page, and never edit or delete another block.
  4. Pass the result to the verify step: `local <ticket> --verify --attach '{"blockId":"<the new block id>"}'`, or `--attach '{"error":"<why>"}'` when the rules do not allow it or the attach failed. A missing, refused or failed attach is a notice in the verify output, never a failed verify.
- **`--parent-run <run-id>:<nonce>`** (a step of an `/aspira-build-feature` run, which prints it on the step's command). Skip steps 2 to 4 above: the run writes no usage report, reads no rules and attaches nothing; build-feature records the step in its own telemetry. Step 1 still applies: record every subagent you launch, because the build-feature step report lists them in `usage.subagents` (KIT-80). Pass `--parent-run` unchanged on every call of the launcher, `start` or `local`, `--verify` included. A malformed value, or one that does not name the pending step of the build-feature run on the ticket, is refused (exit 3) naming `--parent-run`.
- **`--no-ticket`** runs write no telemetry.

## Results

`report.md`, `diagnostics.json`, `rounds.json`, `usage.json` and `calls.json` in the output directory, plus `guidelines/` (the rules the run was held to) and, for a remote run, `changes.patch`. A local path's output folder is added to that directory's `.gitignore` once, unless `--output` was given to `local`.

A non-zero exit is a run status to relay (exit 0 is ready, 1 incomplete or blocked, 3 refused, 5 needs-author): never retry or rerun it on needs-author, settle the open decisions the report names first. Start the report with the run status, the ticket ID and title, the Status (unchanged), that no page was pushed, and the working folder, then report the run the way the agent's `agent/instructions.md` says (the `orchestrator` path the `local` step prints, read in full; in the default mode the finished step returns its text as `orchestrator.text`). Say which mode produced the run and which directory was analyzed. In the default mode the fix model was this session, so say so.
