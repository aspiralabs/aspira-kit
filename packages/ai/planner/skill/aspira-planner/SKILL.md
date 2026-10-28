---
name: aspira-planner
description: Turn a reviewed business spec into concrete implementation tasks and unit/integration test checklists by calling the Aspira planner agent. By default the pipeline runs inside this Claude Code session; with --cloud it runs the planner as a separate process. Use for /aspira-planner or requests to generate an implementation plan with this agent.
argument-hint: [<ticket ID | Notion URL> | <spec.md> --no-ticket] [--cloud] [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR] [--take-recommended] [--parent-run RUN:NONCE]
disable-model-invocation: true
---

# Spec to plan

This skill only calls the `planner` agent. `agent/instructions.md` in the planner package is the authority for what the planner does, what it needs and what to report; this file covers only the mechanics of calling it. The planner researches the repository and the Notion engineering rules, then writes a test-first implementation plan mapped to the spec's business criteria.

Use the absolute path to `scripts/planner.sh` beside this file. Run from the target repository, or pass `--repo`. The helper needs Node 24 and pnpm. It resolves the agent through `PLANNER_AGENT_DIR` (kit development only; the report says so), then the global kit (`kit package-dir`). A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket's pages are pulled into `.work/<id>-<slug>/` and the planner plans `spec.reviewed/spec.reviewed.md` from there; the output goes to `plan.review/` in that folder. A file path only works with `--no-ticket`, for a repository with no board; the run then records `ticket: none`. A file path without `--no-ticket` is an error that names the flag.

The planner runs only from `Ready: Spec`, from its own `In Progress: Plan` (a retry after a failure, which makes no start move), or from `In Review: Plan` (a rerun after the author answered the plan's open decisions in `plan.review/trace/decisions.md`, which makes no move, KIT-87). Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the planner needs and who makes that move. On start it sets Dev and moves the card to `In Progress: Plan`; on success it puts the plan on the ticket as the child page `Plan` and moves the card to `In Review: Plan`; on failure or an incomplete plan the card stays `In Progress: Plan`. It never moves a card to a Ready column. It refuses a spec whose review banner still reads `incomplete` or `needs-author`, unless the author approved that exact spec with `/aspira-build-feature <ID> --approve spec-writer --reason "<why>"` (KIT-84); never edit the banner to get past it. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file.

## Default: the same pipeline in this session

```bash
<skill-dir>/scripts/planner.sh local [<ticket> | <spec.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output] [--finish] [--verify] [--take-recommended] [--parent-run RUN:NONCE] [--attach JSON]
```

Each call is one synchronous step that makes no model call and launches nothing. `--take-recommended` takes every decision still open after the author's ticks as the agent's recommended option instead of waiting on the author. It prints JSON: the next stage, or the exported plan once `pending` is `false`. The driver assembles every prompt from the agent's own files when the step runs, so nothing here restates them. This default mode is not independent of this session: every phase runs on this session's model, and no cost is itemized. Every task a stage prints names its `model`, and its `effort` when aspira.json `models` sets one for `<step>.<phase>`: launch that task's subagent on that model, passing that reasoning effort to the Agent tool when the task has one.

When aspira.json has `"useCodebaseMap": true` (off when absent), the run uses the codebase map: a missing or stale map is built at the start of the run, the brief for the files the spec names goes into the research and planning prompts so the plan's file lists include the files that import them, and the report says `Codebase map: used` or `Codebase map: not used (<reason>)`. A failed build never stops the run.

The engineering rules come first, and the driver refuses to start any model stage without them: `local` runs `load-knowledge` itself, once per run, with `NOTION_TOKEN` from the environment, the app's `.env.local` or the project's `.env.local`, loading exactly the pages the agent's own knowledge configuration names (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`). This session never fetches guidelines; with no token the run ends `blocked`. `--guidelines` takes only a `REQUIRED.md` that `load-knowledge` wrote, still where it wrote it; any other file, a `trace/` copy included, is refused.

1. Stage `board` (first, with a ticket): the board work for this session to perform with the Notion MCP, listed as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. A `set` action and a `move` action name the property and the Status to set on the ticket page, and `then` says what to update in `ticket.md` afterwards. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not the one the planner needs, and lists what is still missing until the folder is in sync. Never move a card anywhere the stage does not list.
2. Read the file named by `router` once. It is `agent/instructions.md` verbatim, with how its tools map onto this driver. Follow it as the planner's router would.
3. Stage `knowledge`: `local`'s own `load-knowledge` step already built the folder, or `blocked` names what to set. Run `local` again once it is set, or pass the same `--guidelines` snapshot to every call.
4. Stage `explore` (when the spec's source spans two or more areas of the repository): one task per area. Launch all of them in one message, in parallel, one `general-purpose` subagent each on its `<task.model>`, each told to read its `prompt` file and do what it says; each writes its own `output`. When they have all finished, call `local` again. Stages `research` and `planning`: each has one task. Launch one `general-purpose` subagent per task, model `<task.model>` (KIT-48), and tell it to read the `prompt` file and do what it says; it writes `output` (and, for research, `reads`). Do not write a task output yourself. When it finishes, call `local` again.
5. A task that comes back with `error` was rejected by the agent's schema. If `retry` is `true`, resend that task once, with the error. If `retry` is `false`, call `local --finish` to export what exists as incomplete.
6. The export carries `board` again, stage `board-end`: the `push` of `plan.reviewed.md` to the ticket as the page `Plan` (create it, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`) and the success `move`, or nothing after a failed run. Perform them with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md` shows the expected Status, completes `trace/board.json`, and prints the report lines. If a push fails, say so with the local path of the plan and still make the move.
7. Do not change the spec, the repository or the knowledge folder during a run: the driver refuses to continue. To start over, delete `workDir`.

The work directory is `<output>.local/`. It is deleted after export; every prompt and output is kept in `trace/calls.json`, the rules used in `trace/knowledge.json` and `trace/knowledge/`, and every board action with the Status before and after in `trace/board.json`.

## `--cloud`: the agent as a separate process

`--local` is still accepted and means the default, the section above.

```bash
<skill-dir>/scripts/planner.sh start [<ticket> | <spec.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output] [--parent-run RUN:NONCE]
```

The launcher makes the board moves itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing), and the push and the success move after it exits, appended to the run's log and recorded in `trace/board.json`. With a complete guidelines snapshot, the launcher uses the direct CLI. Otherwise it uses the eve entry point, which loads the engineering rules from Notion with `load-knowledge` (integration credentials and the loader's Docker sandbox). It also needs screen and the agent environment.

The helper detaches the run and prints its run/log directory. Tell the user where results will go. Check with `status <run-dir>` or `wait <run-dir> --max 30`; `watch` is a bounded alias for `wait`. The polling wait returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Report launch errors as they are.

## Run telemetry

Every run of this skill on a ticket writes one telemetry file, `.work/<id>-<slug>/telemetry/<run-id>.json` (OpenTelemetry JSON: the run, its phases and subagents, with timings, tokens, tool calls and cost where they are measured), and attaches it to the end of the ticket page when the Feature Board rules list it (BOARD-003). A telemetry failure is a notice beside the result: it never changes the run's status, the card's move or the exit code.

- **`--cloud`.** The launcher does it all: `ticket.ts start` prints `run-id=` and `run-started=`, and the finish step after the agent exits writes the file from them and attaches it. Nothing to do here.
- **Default.** The session reports its own usage, since only it sees its subagents:
  1. Record the wall-clock start and end (ISO 8601) of every subagent you launch, with the total tokens, tool uses and duration the Agent tool reports for it, and its model when you know it.
  2. Every pending step on a ticket prints `sessionUsage` with a `file` and a `runId`. Before the call that exports the run (the call after the planning output is written, or `--finish`), write that `file` (`plan.review/trace/session-usage.json`) as JSON: `{"runId": "<runId>", "subagents": [{"label": "…", "startedAt": "…", "endedAt": "…", "totalTokens": 0, "toolUses": 0, "wallMs": 0, "model": "…"}]}`, one entry per subagent in launch order. `label` is a short name of your own (`research`, `lane A`), never the task's description or prompt text. Leave out a number you do not have; never guess one. Without the file the run's telemetry records the subagents as missing.
  3. The export's `board.actions` then end with two telemetry actions. `read` (`target: "board-rules"`): fetch the Feature Board rules page with the Notion MCP (`notion-fetch`, read-only) and write it to `file` as plain markdown, one rule per line. `attach`: only when one line of the rules you saved contains every string of `onlyIf`, attach `file`, as `name`, in one file block at the end of the ticket page `page`: `notion-create-attachment` for a file of at most 200 KiB, otherwise `notion-create-file-upload`, then `notion-update-page`. Attach no other file, to no other page, and never edit or delete another block.
  4. Pass the result to the verify step: `local <ticket> --verify --attach '{"blockId":"<the new block id>"}'`, or `--attach '{"error":"<why>"}'` when the rules do not allow it or the attach failed. A missing, refused or failed attach is a notice in the verify output, never a failed verify.
- **`--parent-run <run-id>:<nonce>`** (a step of an `/aspira-build-feature` run, which prints it on the step's command). Skip steps 2 to 4 above: the run writes no usage report, reads no rules and attaches nothing; build-feature records the step in its own telemetry. Step 1 still applies: record every subagent you launch, because the build-feature step report lists them in `usage.subagents` (KIT-80). Pass `--parent-run` unchanged on every call of the launcher, `start` or `local`, `--verify` included. A malformed value, or one that does not name the pending step of the build-feature run on the ticket, is refused (exit 3) naming `--parent-run`.
- **`--no-ticket`** runs write no telemetry.

## Output

The output is `plan.review/` in the ticket's working folder (with `--no-ticket`: beside the input spec; for `spec.reviewed/spec.reviewed.md`, a sibling of `spec.reviewed/`). An explicit `--output` overrides that location.

- `plan.reviewed.md`: file-level tasks, dependencies, unit/integration checklists and verification commands. Omitted if no structured plan was produced.
- `run-analysis.md`: reported cost and wall time per agent/turn, plus totals (in this session: wall time only).
- `trace/`: original spec, guidelines, research, structured plan, validation results, prompts, outputs, tool activity, the board actions, and prior reports under `history/`.

A non-zero exit is a run status to relay (exit 0 is ready, 1 incomplete or blocked, 3 refused, 5 needs-author): never retry or rerun it on needs-author, settle the open decisions the report names first. Start the report with the run status, the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log), then report as `agent/instructions.md` says, linking the plan and run analysis. If the run fails before export, show its log and do not present a previous report as current.
