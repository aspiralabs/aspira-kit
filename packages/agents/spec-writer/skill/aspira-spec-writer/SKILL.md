---
name: aspira-spec-writer
description: Turn a feature idea (a file, a Notion card or inline text) into a reviewed spec with the official spec-writer pipeline. It explores the repository, writes an initial draft in the Aspira spec contract, then runs the official spec review on that draft, and reports the written spec, the draft, open author decisions and a run analysis. By default it runs spec-writer as a separate process on Claude and OpenAI models; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-spec-writer or requests to write a spec from an idea.
argument-hint: <idea.md | Notion URL | "idea text"> [--local] [--guidelines FILE] [--repo DIR] [--output DIR]
---

# Spec writer

Turn an idea into a spec the planner can take. The pipeline is: **explore** (read the repository the idea touches), **draft** (the initial spec in the Aspira contract, with every unstated product choice listed under Assumptions), then the official spec review on the draft: frontier research, six parallel specialist reviews (security, architecture, data, behavior, ui, acceptance) and one reconciliation. Code, not a model, validates every phase, assigns finding IDs, applies the reconciled edits to the draft and writes the report. There is no elapsed-time limit.

Do not write the spec yourself. The value is a draft grounded in the repository and then reviewed independently; a spec you write in this conversation skips both.

## The idea

The pipeline reads the idea from a file. Turn whatever the user gave you into one first:

- **A file or `@` mention** (`@specs/cart/idea.md`): use it as is; the leading `@` is stripped.
- **A Notion page URL** (for example a Feature Board card): fetch it with the Notion MCP and write its title and full content, unedited, to `specs/<slug>/idea.md` at the repository root, where `<slug>` is the kebab-case title (prefix the card ID when it has one, such as `han-15-agent-file-format`). Add a `Source: <url>` line under the title.
- **Inline text**: write it, unedited, to `specs/<slug>/idea.md` the same way.

If the user names a different place, use it. Never rewrite or embellish the idea: what the idea does not say is for the draft's Assumptions and the review's author decisions, not for you.

The repository is the git root of the current directory unless `--repo` is given. Results go to `spec.written/` beside the idea file unless `--output` is given. Both modes use `scripts/spec-writer.sh` beside this file (use its absolute path) and produce the same report.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `spec-writer`, a separate process | subagents of this Claude Code session |
| Models | Claude Opus 5.5 explore, draft and review research; OpenAI GPT-6.1 Sol specialists and reconciliation | this session's model, for every phase |
| Independence | the reviewers are a second vendor with no session context | fresh subagent contexts, same vendor and session |
| Cost | Vercel AI Gateway, itemized in `run-analysis.md` | this session's usage, not itemized |
| Needs | Node 24, pnpm, screen, the agents' `.env.local`; Docker when loading Notion guidelines | Node 24, pnpm, the Notion MCP (or `--guidelines`) |

Use the default when the spec should be reviewed by models independent of this session. Use `--local` to stay in this session.

## Default: run the agent

```bash
<skill-dir>/scripts/spec-writer.sh start <idea.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

A supplied guidelines snapshot uses the direct CLI. Otherwise the eve entry point loads the required guidelines from Notion, which needs configured credentials and its Docker sandbox. The launcher resolves the package using `SPEC_WRITER_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/spec-writer`, then its own package location.

The launcher detaches the run and prints its run directory. Tell the user it started and where results will go. Use `status <run-dir>`, or `wait <run-dir> --max 30` between updates; `watch` is an alias. Waiting returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Do not automatically retry a failed or incomplete run, since every run is paid. If launch fails, report the error rather than writing the spec manually.

## `--local`: run the pipeline in this session

The launcher's `local` step replays the agent's pipeline with this session as the model. It makes no model calls itself: it either lists the phases still to run, writing each one's exact agent prompt to a file, or, once every phase output exists, validates everything and writes the report. You run the phases as subagents in between. Do not edit the prompts: each phase must get exactly what the agent's phase gets.

```bash
<skill-dir>/scripts/spec-writer.sh local <idea.md> [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR] [--finish]
```

1. **Guidelines.** With `--guidelines`, pass it to every `local` call. Otherwise build the snapshot from Notion with the Notion MCP. Fetch **Agent Instructions** (https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3) and **Review Verification** (https://app.notion.com/p/3e83e59b225881caa641db4f121662da), and write `<output>.local/REQUIRED.md` (by default `<idea dir>/spec.written.local/REQUIRED.md`). Use each page's full `<content>` under a `# <page title>` heading, in that order, separated by `---`, text as fetched, rule IDs included. If a page is truncated or cannot be fetched, stop and say so; a partial rule set would pass a review it should fail.
2. **Explore.** Run `local`. It prints `stage: "explore"` and one task. Launch one `general-purpose` subagent with this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
3. **Draft.** Run `local` again: `stage: "draft"`, one task. Launch one subagent the same way.
4. **Review research.** Run `local` again: `stage: "research"`, one task, the same way.
5. **Specialists.** Run `local` again: `stage: "specialists"` and six tasks. Launch all six subagents **in one message**, one per task. The `ui` subagent needs the `aspiralabs-ui` MCP; its prompt says what to do when it is missing.
6. **Reconciliation.** Run `local` again: `stage: "reconciliation"`, the `synthesis` task, the same way.
7. **Report.** Run `local` a last time. It prints the finished report: `status`, `dir`, `spec`, `draft`, `findings`, `problems` and `authorDecisions`.

The snapshot only holds the two required pages; Agent Instructions routes to topic pages (Approved Technologies, Infrastructure/CI-CD and others). The explore and specialist subagents read the pages that apply with the Notion MCP, read-only, and cite their rules, as the agent's Notion connection does. Without the Notion MCP in this session they record those pages as gaps, which blocks `ready`.

A task that comes back with an `error` had an output that failed its schema. Send that error to the same subagent (or a new one with the same message plus the error) once. If it fails again, or a subagent cannot finish, run `local ... --finish`: it exports the report with the missing phases recorded as failures, so the status is `incomplete`. The work directory `<output>.local/` holds prompts and outputs between steps and is removed once the report is written; every prompt and output is kept in `trace/calls.json`. If the idea, guidelines or repository change mid-run, `local` refuses to continue; delete the work directory to start again.

## Results

In `spec.written/` beside the idea, unless an output directory was given:

- `idea.md`: the idea as read.
- `spec.draft.md`: the initial stab, before review.
- `spec.md`: the reviewed spec, only when the review produced valid edits. Hand this to `/aspira-planner`.
- `run-analysis.md`: wall time and reported cost per phase and model turn. A `--local` report says the work ran in the session and itemizes no cost.
- `trace/`: `exploration.md`, `findings.md`, `decisions.md`, `checks.md`, `review.json`, `calls.json`, `guidelines.md` (the agent also writes `usage.json`).

Reruns archive previous results in `spec.written/trace/history/run-*/`. The idea file is never modified. Summarize the status, the open author decisions with their options (from `trace/decisions.md`), and link `spec.md`, `spec.draft.md` and `run-analysis.md`. `incomplete` or `needs-author` is not a spec to plan from; read `trace/review.json` even when the command exits successfully. If a run fails before exporting, show its log or error and do not present an earlier report as the new result. Say which mode produced the report: a `--local` run used this session's model throughout, so its review is not independent of the writer.
