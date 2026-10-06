---
name: aspira-planner
description: Turn a reviewed business spec into concrete implementation tasks and unit/integration test checklists by calling the Aspira planner agent. By default it runs the planner as a separate process; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-planner or requests to generate an implementation plan with this agent.
---

# Spec to plan

This skill only calls the `planner` agent. `agent/instructions.md` in the planner package is the authority for what the planner does, what it needs and what to report; this file covers only the mechanics of calling it. The planner researches the repository and the Notion engineering rules, then writes a test-first implementation plan mapped to the spec's business criteria.

Use the absolute path to `scripts/planner.sh` beside this file. Run from the target repository, or pass `--repo`. The helper needs Node 24 and pnpm. It resolves the agent through `PLANNER_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/planner` under the project's `node_modules`, then its own package location. A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`.

## Default: the agent as a separate process

```bash
<skill-dir>/scripts/planner.sh start <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

With a complete guidelines snapshot, the launcher uses the direct CLI. Otherwise it uses the eve entry point, which loads the engineering rules from Notion with `load-knowledge` (integration credentials and the loader's Docker sandbox). It also needs screen and the agent environment.

The helper detaches the run and prints its run/log directory. Tell the user where results will go. Check with `status <run-dir>` or `wait <run-dir> --max 30`; `watch` is a bounded alias for `wait`. The polling wait returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Report launch errors as they are.

## --local: the same pipeline in this session

```bash
<skill-dir>/scripts/planner.sh local <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output] [--finish]
```

Each call is one synchronous step that makes no model call and launches nothing. It prints JSON: the next stage, or the exported plan once `pending` is `false`. The driver assembles every prompt from the agent's own files when the step runs, so nothing here restates them. `--local` is not independent of this session: every phase runs on this session's model, and no cost is itemized.

1. Read the file named by `router` once. It is `agent/instructions.md` verbatim, with how its tools map onto this driver. Follow it as the planner's router would.
2. Stage `knowledge`: the engineering rules come first, and the driver refuses to start any model stage without them. `knowledge.pages` lists the pages the agent's own knowledge configuration loads (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`). Fetch exactly the pages the stage lists with the Notion MCP (read-only `notion-fetch`), and write them into `knowledge.dir` in the layout of `knowledge.formats`: the index page as `INDEX.md`, the required pages in the listed order as `REQUIRED.md`, and each topic page at its `file`. Fix anything in `knowledge.problems`, then call `local` again. Topic pages are listed once `REQUIRED.md` exists, because they are the pages it routes to. Never write to Notion. Without the Notion MCP, pass `--guidelines` with a complete `REQUIRED.md` snapshot instead.
3. Stages `research` and `planning`: each has one task. Launch one subagent per task and tell it to read the `prompt` file and do what it says; it writes `output` (and, for research, `reads`). Do not write a task output yourself. When it finishes, call `local` again.
4. A task that comes back with `error` was rejected by the agent's schema. If `retry` is `true`, resend that task once, with the error. If `retry` is `false`, call `local --finish` to export what exists as incomplete.
5. Do not change the spec, the repository or the knowledge folder during a run: the driver refuses to continue. To start over, delete `workDir`.

The work directory is `<output>.local/`. It is deleted after export; every prompt and output is kept in `trace/calls.json`, and the rules used in `trace/knowledge.json` and `trace/knowledge/`.

## Output

The output is `plan.review/` beside the input spec. For `spec.reviewed/spec.reviewed.md`, it is a sibling of `spec.reviewed/`. An explicit `--output` overrides that location.

- `plan.reviewed.md`: file-level tasks, dependencies, unit/integration checklists and verification commands. Omitted if no structured plan was produced.
- `run-analysis.md`: reported cost and wall time per agent/turn, plus totals (`--local`: wall time only).
- `trace/`: original spec, guidelines, research, structured plan, validation results, prompts, outputs, tool activity and prior reports under `history/`.

Read `trace/review.json` to determine `ready`, `needs-author` or `incomplete`; eve process success alone is not plan approval. Report as `agent/instructions.md` says, linking the plan and run analysis. If the run fails before export, show its log and do not present a previous report as current.
