---
name: aspira-planner
description: Turn a reviewed business spec into concrete implementation tasks and unit/integration test checklists by calling the Aspira planner agent. By default it runs the planner as a separate process; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-planner or requests to generate an implementation plan with this agent.
argument-hint: [<ticket ID | Notion URL> | <spec.md> --no-ticket] [--local] [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR]
---

# Spec to plan

This skill only calls the `planner` agent. `agent/instructions.md` in the planner package is the authority for what the planner does, what it needs and what to report; this file covers only the mechanics of calling it. The planner researches the repository and the Notion engineering rules, then writes a test-first implementation plan mapped to the spec's business criteria.

Use the absolute path to `scripts/planner.sh` beside this file. Run from the target repository, or pass `--repo`. The helper needs Node 24 and pnpm. It resolves the agent through `PLANNER_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/planner` under the project's `node_modules`, then its own package location. A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket's pages are pulled into `.work/<id>-<slug>/` and the planner plans `spec.reviewed/spec.reviewed.md` from there; the output goes to `plan.review/` in that folder. A file path only works with `--no-ticket`, for a repository with no board; the run then records `ticket: none`. A file path without `--no-ticket` is an error that names the flag.

The planner runs only from `Ready: Spec`, or from its own `In Progress: Plan` (a retry after a failure, which makes no start move). Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the planner needs and who makes that move. On start it sets Dev and moves the card to `In Progress: Plan`; on success it puts the plan on the ticket as the child page `Plan` and moves the card to `In Review: Plan`; on failure or an incomplete plan the card stays `In Progress: Plan`. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file.

## Default: the agent as a separate process

```bash
<skill-dir>/scripts/planner.sh start [<ticket> | <spec.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

The launcher makes the board moves itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing), and the push and the success move after it exits, appended to the run's log and recorded in `trace/board.json`. With a complete guidelines snapshot, the launcher uses the direct CLI. Otherwise it uses the eve entry point, which loads the engineering rules from Notion with `load-knowledge` (integration credentials and the loader's Docker sandbox). It also needs screen and the agent environment.

The helper detaches the run and prints its run/log directory. Tell the user where results will go. Check with `status <run-dir>` or `wait <run-dir> --max 30`; `watch` is a bounded alias for `wait`. The polling wait returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Report launch errors as they are.

## --local: the same pipeline in this session

```bash
<skill-dir>/scripts/planner.sh local [<ticket> | <spec.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output] [--finish] [--verify]
```

Each call is one synchronous step that makes no model call and launches nothing. It prints JSON: the next stage, or the exported plan once `pending` is `false`. The driver assembles every prompt from the agent's own files when the step runs, so nothing here restates them. `--local` is not independent of this session: every phase runs on this session's model, and no cost is itemized.

1. Stage `board` (first, with a ticket): the board work for this session to perform with the Notion MCP, listed as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. A `set` action and a `move` action name the property and the Status to set on the ticket page, and `then` says what to update in `ticket.md` afterwards. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not the one the planner needs, and lists what is still missing until the folder is in sync. Never move a card anywhere the stage does not list.
2. Read the file named by `router` once. It is `agent/instructions.md` verbatim, with how its tools map onto this driver. Follow it as the planner's router would.
3. Stage `knowledge`: the engineering rules come first, and the driver refuses to start any model stage without them. `knowledge.pages` lists the pages the agent's own knowledge configuration loads (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`). Fetch exactly the pages the stage lists with the Notion MCP (read-only `notion-fetch`), and write them into `knowledge.dir` in the layout of `knowledge.formats`: the index page as `INDEX.md`, the required pages in the listed order as `REQUIRED.md`, and each topic page at its `file`. Fix anything in `knowledge.problems`, then call `local` again. Topic pages are listed once `REQUIRED.md` exists, because they are the pages it routes to. Never write to Notion outside a `board` action. Without the Notion MCP, pass `--guidelines` with a complete `REQUIRED.md` snapshot instead.
4. Stages `research` and `planning`: each has one task. Launch one subagent per task and tell it to read the `prompt` file and do what it says; it writes `output` (and, for research, `reads`). Do not write a task output yourself. When it finishes, call `local` again.
5. A task that comes back with `error` was rejected by the agent's schema. If `retry` is `true`, resend that task once, with the error. If `retry` is `false`, call `local --finish` to export what exists as incomplete.
6. The export carries `board` again, stage `board-end`: the `push` of `plan.reviewed.md` to the ticket as the page `Plan` (create it, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`) and the success `move`, or nothing after a failed run. Perform them with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md` shows the expected Status, completes `trace/board.json`, and prints the report lines. If a push fails, say so with the local path of the plan and still make the move.
7. Do not change the spec, the repository or the knowledge folder during a run: the driver refuses to continue. To start over, delete `workDir`.

The work directory is `<output>.local/`. It is deleted after export; every prompt and output is kept in `trace/calls.json`, the rules used in `trace/knowledge.json` and `trace/knowledge/`, and every board action with the Status before and after in `trace/board.json`.

## Output

The output is `plan.review/` in the ticket's working folder (with `--no-ticket`: beside the input spec; for `spec.reviewed/spec.reviewed.md`, a sibling of `spec.reviewed/`). An explicit `--output` overrides that location.

- `plan.reviewed.md`: file-level tasks, dependencies, unit/integration checklists and verification commands. Omitted if no structured plan was produced.
- `run-analysis.md`: reported cost and wall time per agent/turn, plus totals (`--local`: wall time only).
- `trace/`: original spec, guidelines, research, structured plan, validation results, prompts, outputs, tool activity, the board actions, and prior reports under `history/`.

Read `trace/review.json` to determine `ready`, `needs-author` or `incomplete`; eve process success alone is not plan approval. Start the report with the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log), then report as `agent/instructions.md` says, linking the plan and run analysis. If the run fails before export, show its log and do not present a previous report as current.
