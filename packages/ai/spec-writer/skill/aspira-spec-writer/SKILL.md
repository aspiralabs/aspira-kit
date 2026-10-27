---
name: aspira-spec-writer
description: The one spec step. From an idea (a Feature Board ticket at Ready: Idea, a file, a Notion page or inline text) it explores the repository, writes a draft in the Aspira spec contract and runs the official spec review on it; from In Review: Spec it reviews the answered spec again, so a spec is reviewed once per round, never twice. By default the pipeline runs inside this Claude Code session; with --cloud it runs spec-writer as a separate process on Claude and OpenAI models. Use for /aspira-spec-writer or requests to write or re-review a spec.
argument-hint: [<ticket ID | Notion URL> | <idea.md> --no-ticket] [--cloud] [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR] [--take-recommended] [--parent-run RUN:NONCE]
disable-model-invocation: true
---

# Spec writer

This skill only runs the official spec-writer agent. Its rules live in the agent package, not here: `agent/instructions.md` is the authority for what the agent does, what it writes and how its result is reported, and the phase prompts come from its `agent/lib/` modules (and spec-reviewer's library, for the review round). This file covers mechanics only. Write mode is explore, draft, then the review round on the draft: research, six parallel specialists, one reconciliation. Review mode (KIT-48) is the review round alone, on the spec the author answered.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket is pulled into `.work/<id>-<slug>/`: `ticket.md`, the ticket's Idea body as `idea.md`, and its Spec and Spec Reviewed pages when it has them. Never rewrite or embellish the idea: what it leaves open is for the pipeline to surface. The idea file is never modified after the pull. The output goes to `spec.reviewed/` in that folder, and the reviewed spec is copied to `spec.md` beside it. A file path only works with `--no-ticket`, for a repository with no board; the run then records `ticket: none`. A file path without `--no-ticket` is an error that names the flag.

The step runs from `Ready: Idea` (write mode), from its own `In Progress: Spec` (a retry after a failure, which makes no start move) and from `In Review: Spec` (review mode: the answered `spec.reviewed/spec.reviewed.md`, or `spec.md`, reviewed again with the ticks the author made in `trace/decisions.md`). Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the step needs and who makes that move. On start from `Ready: Idea` it sets Dev and moves the card to `In Progress: Spec`; on success it puts `spec.md` on the ticket as the child page `Spec`, the reviewed spec as `Spec Reviewed`, the open decisions as `Spec Review Decisions` when the status is `needs-author`, and moves the card to `In Review: Spec`. From `In Review: Spec` it makes no move: it replaces the pages and the card stays where the human reads it. On failure, or when no spec was written, the card stays where it was. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file.

## The idea without a ticket

With `--no-ticket` the pipeline reads the idea from a file. Turn whatever the user gave you into one first:

- **A file or `@` mention** (`@specs/cart/idea.md`): use it as is; the leading `@` is stripped.
- **A Notion page URL** that is not a Feature Board ticket, or **inline text**: write its title and full content, unedited, to the file the user names (with a `Source: <url>` line under the title for a page), and pass that file.

The repository is the git root of the current directory unless `--repo` is given. With `--no-ticket`, results go to `spec.reviewed/` beside the idea file unless `--output` is given. Both modes use `scripts/spec-writer.sh` beside this file (use its absolute path) and produce the same report.

| | Default | `--cloud` |
| --- | --- | --- |
| Where the model work runs | subagents of this Claude Code session | `spec-writer`, a separate process |
| Models | the model each task names (`model` in the stage) | the agent's configured models (`agent/lib/runner.ts`, spec-reviewer's `models.ts`) |
| Independence | fresh subagent contexts, same session | the reviewers are a second vendor with no session context |
| Cost | this session's usage, not itemized | Vercel AI Gateway, itemized in `run-analysis.md` |
| Needs | Node 24, pnpm, the Notion MCP for the board, `NOTION_TOKEN` for the guidelines (or `--guidelines`) | Node 24, pnpm, screen, the agents' `.env.local`; Docker when loading Notion guidelines |

The default stays in this session. Use `--cloud` when the spec should be reviewed by models independent of this session. `--local` is still accepted and means the default.

## Default: run the pipeline in this session

```bash
<skill-dir>/scripts/spec-writer.sh local [<ticket> | <idea.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR] [--finish] [--verify] [--take-recommended] [--parent-run RUN:NONCE] [--attach JSON]
```

`--take-recommended` takes every decision the review leaves open as the agent's recommended option instead of waiting on the author.

When aspira.json has `"useCodebaseMap": true` (off when absent), the run uses the codebase map: a missing or stale map is built at the start of the run, the brief for the files the idea touches goes into the draft and the review, and the report says `Codebase map: used` or `Codebase map: not used (<reason>)`. A failed build never stops the run.

Each `local` call is one synchronous step. It makes no model calls: it prints JSON naming the next `stage` and its tasks, each with a `prompt` file assembled at that moment from the agent's own files, the `output` file to write and the `model` to run it on, or the finished report. Every result carries `orchestrator`, the agent's `agent/instructions.md`: read the file named in `orchestrator` in full once, before the first phase. In this mode the `local` steps stand in for the agent's write tool, and you stand in for its router. Run the tasks as subagents and do not edit the prompt files: their content is exactly what the agent's phases get. Every task a stage prints names its `model`, and its `effort` when aspira.json `models` sets one for `<step>.<phase>`: launch that task's subagent on that model, passing that reasoning effort to the Agent tool when the task has one.

The engineering guidelines are mandatory, local mode included: `local` runs `load-knowledge` itself, once per run, with `NOTION_TOKEN` from the environment, the app's `.env.local` or the project's `.env.local`, and never asks this session to fetch them. A truncated or missing guideline page stops the run, naming it; with no token the run ends `blocked`. `--guidelines` takes only a `REQUIRED.md` that `load-knowledge` wrote, still where it wrote it; any other file, a `trace/` copy included, is refused.

1. **Board** (first, with a ticket). `stage: "board"` lists the board work for this session to perform with the Notion MCP, as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. A `set` action and a `move` action name the property and the Status to set on the ticket page, and `then` says what to update in `ticket.md` afterwards. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not one the step runs from, and lists what is still missing until the folder is in sync. Never move a card anywhere the stage does not list.
2. **Knowledge.** `local`'s own `load-knowledge` step already built the folder, or `blocked` names what to set. Run `local` again once it is set, or pass the same `--guidelines` snapshot to every call.
3. **Explore** (write mode only). `stage: "explore"`, one task per area the idea names, launched **in one message**. Each task names its `model`: launch one `general-purpose` subagent per task, model `<task.model>`, with this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
4. **Draft** (write mode only). `stage: "draft"`, one task, the same way.
5. **Review research.** `stage: "research"`, one task, the same way. In review mode this is the first model stage.
6. **Specialists.** `stage: "specialists"`, six tasks. Launch all six subagents **in one message**, one per task, with the same message. The `ui` task needs the `aspiralabs-ui` MCP; its prompt says what to do without it.
7. **Reconciliation.** `stage: "reconciliation"`, the `synthesis` task, the same way.
8. **Report.** The last call prints `status`, `mode` (`write` or `review`), `dir`, `spec`, `draft`, `findings`, `problems` and `authorDecisions`, and, with a ticket, `ticketSpec` (the copy of the reviewed spec at `spec.md` in the working folder) and `board` again (stage `board-end`): the `push` of that `spec.md` to the ticket as the page `Spec`, of `spec.reviewed/spec.reviewed.md` as `Spec Reviewed`, of `trace/decisions.md` as `Spec Review Decisions` for `needs-author` (create each page, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`) and, from `In Progress: Spec`, the success `move`; nothing after a failed run. Perform them with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md` shows the expected Status, completes `trace/board.json`, records the Spec Reviewed page's last-edited time in the export, and prints the report lines. If a push fails, say so with the local path of the spec and still make the move the stage lists, if any. Report it as the file named in `orchestrator` says, with the open author decisions and their options from `trace/decisions.md`.

A task that comes back with an `error` wrote an output that failed its schema: send that error back once, to the same subagent or a new one with the same message plus the error. If it fails again or a subagent cannot finish, run `local ... --finish` to export what exists with the missing phases recorded as failures. The work directory, `<output>.local/`, holds the knowledge folder, prompts and outputs between steps and is removed after export; every prompt and output is kept in `trace/calls.json`, the rules used (source, files and hashes) in `trace/review.json`, and every board action with the Status before and after in `trace/board.json`. If the idea, the spec, the guidelines or the repository change mid-run, `local` refuses to continue; delete the work directory to start again.

## `--cloud`: run the agent

```bash
<skill-dir>/scripts/spec-writer.sh start [<ticket> | <idea.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output] [--parent-run RUN:NONCE]
```

The launcher does the board work itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing), and the copy to `spec.md`, the pushes and the success move after it exits, appended to the run's log and recorded in `trace/board.json`. With `--guidelines` the launcher runs the agent's CLI on that snapshot; otherwise it runs the eve entry point, which loads the guidelines with `load-knowledge` (Notion credentials and its Docker sandbox). The launcher resolves the package from `SPEC_WRITER_AGENT_DIR` (kit development only; the report says so), then the global kit (`kit package-dir`). A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`, and prints the run directory and the agent's `instructions:` file.

The run is detached. Tell the user it started and where results will go, then use `status <run-dir>`, or `wait <run-dir> --max 30` between updates (`watch` is an alias). Waiting returns control without stopping the agent; keep checking until it finishes or the user cancels. If launch fails, report the error. When it finishes, read the file named in `instructions:` and report the result the way it says.

## Run telemetry

Every run of this skill on a ticket writes one telemetry file, `.work/<id>-<slug>/telemetry/<run-id>.json` (OpenTelemetry JSON: the run, its phases and subagents, with timings, tokens, tool calls and cost where they are measured), and attaches it to the end of the ticket page when the Feature Board rules list it (BOARD-003). A telemetry failure is a notice beside the result: it never changes the run's status, the card's move or the exit code.

- **`--cloud`.** The launcher does it all: `ticket.ts start` prints `run-id=` and `run-started=`, and the finish step after the agent exits writes the file from them and attaches it. Nothing to do here.
- **Default.** The session reports its own usage, since only it sees its subagents:
  1. Record the wall-clock start and end (ISO 8601) of every subagent you launch, with the total tokens, tool uses and duration the Agent tool reports for it, and its model when you know it.
  2. Every pending step on a ticket prints `sessionUsage` with a `file` and a `runId`. Before the call that exports the run (the call after the last phase output is written, or `--finish`), write that `file` (`spec.reviewed/trace/session-usage.json`) as JSON: `{"runId": "<runId>", "subagents": [{"label": "…", "startedAt": "…", "endedAt": "…", "totalTokens": 0, "toolUses": 0, "wallMs": 0, "model": "…"}]}`, one entry per subagent in launch order. `label` is a short name of your own (`research`, `lane A`), never the task's description or prompt text. Leave out a number you do not have; never guess one. Without the file the run's telemetry records the subagents as missing.
  3. The export's `board.actions` then end with two telemetry actions. `read` (`target: "board-rules"`): fetch the Feature Board rules page with the Notion MCP (`notion-fetch`, read-only) and write it to `file` as plain markdown, one rule per line. `attach`: only when one line of the rules you saved contains every string of `onlyIf`, attach `file`, as `name`, in one file block at the end of the ticket page `page`: `notion-create-attachment` for a file of at most 200 KiB, otherwise `notion-create-file-upload`, then `notion-update-page`. Attach no other file, to no other page, and never edit or delete another block.
  4. Pass the result to the verify step: `local <ticket> --verify --attach '{"blockId":"<the new block id>"}'`, or `--attach '{"error":"<why>"}'` when the rules do not allow it or the attach failed. A missing, refused or failed attach is a notice in the verify output, never a failed verify.
- **`--parent-run <run-id>:<nonce>`** (a step of an `/aspira-build-feature` run, which prints it on the step's command). Skip all of the above: the run writes no usage report, reads no rules and attaches nothing; build-feature records the step in its own telemetry. Pass `--parent-run` unchanged on every call of the launcher, `start` or `local`, `--verify` included. A malformed value, or one that does not name the pending step of the build-feature run on the ticket, is refused (exit 3) naming `--parent-run`.
- **`--no-ticket`** runs write no telemetry.

## Reporting

A non-zero exit is a run status to relay (exit 0 is ready, 1 incomplete or blocked, 3 refused, 5 needs-author): never retry or rerun it on needs-author, settle the open decisions the report names first. Start the report with the run status and the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log). The output layout and what to report from it are in `agent/instructions.md`; hand `spec.reviewed/spec.reviewed.md` to `/aspira-planner` only as it allows. If a run fails before exporting, show its log or error and do not present an earlier report as the new result. Say which mode produced the report: a run in this session (the default) used it throughout, so its review is not independent of the writer.
