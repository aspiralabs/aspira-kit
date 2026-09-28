---
name: aspira-spec-reviewer
description: Review a feature spec against its repository and Aspira engineering guidelines with the official spec-review pipeline, then report findings, a reviewed spec and a run analysis. By default it runs spec-reviewer as a separate process and reports back; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-spec-reviewer or requests to review a spec.
argument-hint: <spec.md> [--local] [--guidelines FILE] [--repo DIR] [--output DIR]
---

# Spec review

Review intent and business acceptance criteria; technical unit/integration test planning belongs to `planner`. The pipeline is frontier research, six parallel specialist reviews (security, architecture, data, behavior, ui, acceptance), then one reconciliation. Code, not a model, assigns finding IDs, validates every disposition and edit, applies the edits, checks the acceptance contract and REV rule coverage, and writes the report. There is no elapsed-time limit. Never switch to the removed debate workflow or pass round caps.

The spec path may be an `@` file mention (`@specs/cart.md`); the leading `@` is stripped. The repository is the git root of the current directory unless `--repo` is given. Both modes use `scripts/spec-reviewer.sh` beside this file (use its absolute path) and produce the same `spec.reviewed/` report.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `spec-reviewer`, a separate process | subagents of this Claude Code session |
| Models | Opus 5.5 research, GPT-6 Sol specialists and reconciliation | this session's model, for every phase |
| Independence | a second vendor, no session context | fresh subagent contexts, same vendor and session |
| Cost | Vercel AI Gateway, itemized in `run-analysis.md` | this session's usage, not itemized |
| Needs | Node 24, pnpm, screen, the agents' `.env.local`; Docker when loading Notion | Node 24, pnpm, the Notion MCP (or `--guidelines`) |

Use the default when the review should be independent of the person or session that wrote the spec. Use `--local` when you want to stay in this session.

## Default: run the agent

Call the official `spec-reviewer`; do not perform a second review yourself.

```bash
<skill-dir>/scripts/spec-reviewer.sh start <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

A supplied guidelines snapshot uses the direct CLI. Otherwise the eve entry point loads required guidelines from Notion; that loader requires configured credentials and its Docker sandbox. The launcher resolves the package using `SPEC_REVIEWER_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/spec-reviewer`, then its own package location.

The launcher detaches the review and prints its run/log directory. Tell the user it started and where results will go. Use `status <run-dir>` to check progress, or `wait <run-dir> --max 30` between updates; `watch` is a bounded alias for `wait`. The polling wait returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Do not automatically retry failed or incomplete reviews, since that starts another paid run. If launch fails, report the error rather than reviewing manually.

## `--local`: run the pipeline in this session

The launcher's `local` step replays the agent's pipeline with this session as the model. Each call makes no model calls itself. It either lists the phases still to run, writing each one's exact agent prompt to a file, or, once every phase output exists, validates everything and writes the report. You run the phases as subagents in between. Do not review the spec yourself and do not edit the prompts: the value is that each phase gets exactly what the agent's phase gets.

```bash
<skill-dir>/scripts/spec-reviewer.sh local <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR] [--finish]
```

1. **Guidelines.** With `--guidelines`, pass it to every `local` call. Otherwise build the snapshot from Notion with the Notion MCP. Fetch **Agent Instructions** (https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3) and **Review Verification** (https://app.notion.com/p/3e83e59b225881caa641db4f121662da), and write `<output>.local/REQUIRED.md`. The default output is `spec.reviewed/` beside the spec, so the path is `<spec dir>/spec.reviewed.local/REQUIRED.md`. Use each page's full `<content>` under a `# <page title>` heading, in that order, separated by `---`, and keep the text as fetched, rule IDs included. If a page is truncated or cannot be fetched, stop and say so; a partial rule set would pass a review it should fail.
2. **Research.** Run `local`. It prints JSON with `stage: "research"` and one task. Launch one `general-purpose` subagent with this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
3. **Specialists.** Run `local` again. It prints `stage: "specialists"` and six tasks. Launch all six subagents **in one message**, one per task, with the same message shape. The `ui` subagent needs the `aspiralabs-ui` MCP; its prompt says what to do when the MCP is missing.
4. **Reconciliation.** Run `local` again. It prints `stage: "reconciliation"` and the `synthesis` task. Launch one subagent the same way.
5. **Report.** Run `local` a last time. It prints the finished report: `status`, `dir`, `findings`, `problems` and `authorDecisions`.

A task that comes back with an `error` had an output that failed its schema. Send that error to the same subagent (or a new one with the same message plus the error) once. If it fails again, or a subagent cannot finish, run `local ... --finish`. That exports the report with the missing phases recorded as failures, so the status is `incomplete`. The work directory, `<output>.local/`, holds the prompts and outputs between steps and is removed once the report is written; every prompt and output is kept in `trace/calls.json`. If the spec, guidelines or repository change mid-review, `local` refuses to continue; delete the work directory to start again.

## Results

Results are directly in `spec.reviewed/` beside the source spec unless an output directory was supplied:

- `spec.original.md`: unchanged source spec.
- `spec.reviewed.md`: proposed revised spec, only when valid edits were produced.
- `run-analysis.md`: wall time and reported cost per agent and model turn, plus totals. A `--local` report says the work ran in the session and itemizes no cost.
- `trace/`: all debugging records, including `findings.md`, `decisions.md`, `checks.md`, `review.json`, `calls.json` and `guidelines.md` (the agent also writes `usage.json`). Prompts, outputs, tool activity and errors are retained here.

Reruns archive previous results in `spec.reviewed/trace/history/run-*/`. The source spec remains unchanged. Read the completed report, summarize findings and unresolved decisions, and link the reviewed spec, run analysis and trace/findings.md. `incomplete` or `needs-author` is not approval; consult `trace/review.json` even when the command exits successfully. If a run fails before exporting, show its log or error and do not present an earlier report as the new result. Say which mode produced the report: a `--local` review ran on this session's model, so it is not an independent review.
