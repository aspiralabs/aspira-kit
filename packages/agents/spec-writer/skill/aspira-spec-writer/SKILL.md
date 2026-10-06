---
name: aspira-spec-writer
description: Turn a feature idea (a file, a Notion card or inline text) into a reviewed spec with the official spec-writer pipeline. It explores the repository, writes an initial draft in the Aspira spec contract, then runs the official spec review on that draft, and reports the written spec, the draft, open author decisions and a run analysis. By default it runs spec-writer as a separate process on Claude and OpenAI models; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-spec-writer or requests to write a spec from an idea.
argument-hint: <idea.md | Notion URL | "idea text"> [--local] [--guidelines FILE] [--repo DIR] [--output DIR]
---

# Spec writer

This skill only runs the official spec-writer agent. Its rules live in the agent package, not here: `agent/instructions.md` is the authority for what the agent does, what it writes and how its result is reported, and the phase prompts come from its `agent/lib/` modules (and spec-reviewer's, for the review half). This file covers mechanics only. The pipeline is explore, draft, then the spec review on the draft: research, six parallel specialists, one reconciliation.

## The idea

The pipeline reads the idea from a file. Turn whatever the user gave you into one first:

- **A file or `@` mention** (`@specs/cart/idea.md`): use it as is; the leading `@` is stripped.
- **A Notion page URL** (for example a Feature Board card): fetch it with the Notion MCP and write its title and full content, unedited, to `specs/<slug>/idea.md` at the repository root, where `<slug>` is the kebab-case title (prefix the card ID when it has one, such as `han-15-agent-file-format`). Add a `Source: <url>` line under the title.
- **Inline text**: write it, unedited, to `specs/<slug>/idea.md` the same way.

If the user names a different place, use it. Never rewrite or embellish the idea: what it leaves open is for the pipeline to surface. The idea file is never modified after that.

The repository is the git root of the current directory unless `--repo` is given. Results go to `spec.written/` beside the idea file unless `--output` is given. Both modes use `scripts/spec-writer.sh` beside this file (use its absolute path) and produce the same report.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `spec-writer`, a separate process | subagents of this Claude Code session |
| Models | the agent's configured models (`agent/lib/runner.ts`, spec-reviewer's `models.ts`) | this session's model, for every phase |
| Independence | the reviewers are a second vendor with no session context | fresh subagent contexts, same vendor and session |
| Cost | Vercel AI Gateway, itemized in `run-analysis.md` | this session's usage, not itemized |
| Needs | Node 24, pnpm, screen, the agents' `.env.local`; Docker when loading Notion guidelines | Node 24, pnpm, the Notion MCP (or `--guidelines`) |

Use the default when the spec should be reviewed by models independent of this session. Use `--local` to stay in this session.

## Default: run the agent

```bash
<skill-dir>/scripts/spec-writer.sh start <idea.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

With `--guidelines` the launcher runs the agent's CLI on that snapshot; otherwise it runs the eve entry point, which loads the guidelines with `load-knowledge` (Notion credentials and its Docker sandbox). The launcher resolves the package from `SPEC_WRITER_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/spec-writer` under the project's `node_modules`, then its own location A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`., and prints the run directory and the agent's `instructions:` file.

The run is detached. Tell the user it started and where results will go, then use `status <run-dir>`, or `wait <run-dir> --max 30` between updates (`watch` is an alias). Waiting returns control without stopping the agent; keep checking until it finishes or the user cancels. If launch fails, report the error. When it finishes, read the file named in `instructions:` and report the result the way it says.

## `--local`: run the pipeline in this session

```bash
<skill-dir>/scripts/spec-writer.sh local <idea.md> [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR] [--finish]
```

Each `local` call is one synchronous step. It makes no model calls: it prints JSON naming the next `stage` and its tasks, each with a `prompt` file assembled at that moment from the agent's own files and the `output` file to write, or the finished report. Every result carries `orchestrator`, the agent's `agent/instructions.md`: read the file named in `orchestrator` in full once, before the first phase. In this mode the `local` steps stand in for the agent's write tool, and you stand in for its router. Run the tasks as subagents and do not edit the prompt files: their content is exactly what the agent's phases get.

1. **Knowledge.** The engineering guidelines are mandatory; the driver refuses to start without them. With `--guidelines`, pass the same snapshot to every call. Otherwise the first call prints `stage: "knowledge"` with `knowledge.dir`, `knowledge.root` (the agent's `KNOWLEDGE_PAGE`), `knowledge.required` (the agent's `KNOWLEDGE_REQUIRED` pages, in order), `maxDepth`, `maxPages` and any `problems` with a folder already there. Build that folder with the Notion MCP the way the agent's `load-knowledge` does:
   - `INDEX.md`: the `root` page in full. When `root` is null, search Notion for the required pages by title and use the page that links them.
   - One file per page linked from the index, down to `maxDepth` levels and at most `maxPages` pages, named after the page title in kebab case, each starting `<!-- <title> · <url> -->`.
   - `REQUIRED.md`: every `required` page in order, each as `# <page title>`, then `<!-- <url> -->`, then its full content, separated by `---`, text as fetched with rule IDs.

   If a page is truncated or cannot be fetched, stop and say so. Run `local` again; it prints `problems` until the folder is complete.
2. **Explore.** `stage: "explore"`, one task. Launch one `general-purpose` subagent with this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
3. **Draft.** `stage: "draft"`, one task, the same way.
4. **Review research.** `stage: "research"`, one task, the same way.
5. **Specialists.** `stage: "specialists"`, six tasks. Launch all six subagents **in one message**, one per task, with the same message. The `ui` task needs the `aspiralabs-ui` MCP; its prompt says what to do without it.
6. **Reconciliation.** `stage: "reconciliation"`, the `synthesis` task, the same way.
7. **Report.** The last call prints `status`, `dir`, `spec`, `draft`, `findings`, `problems` and `authorDecisions`. Report it as the file named in `orchestrator` says, with the open author decisions and their options from `trace/decisions.md`.

A task that comes back with an `error` wrote an output that failed its schema: send that error back once, to the same subagent or a new one with the same message plus the error. If it fails again or a subagent cannot finish, run `local ... --finish` to export what exists with the missing phases recorded as failures. The work directory, `<output>.local/`, holds the knowledge folder, prompts and outputs between steps and is removed after export; every prompt and output is kept in `trace/calls.json`, and the rules used (source, files and hashes) in `trace/review.json`. If the idea, the guidelines or the repository change mid-run, `local` refuses to continue; delete the work directory to start again.

## Reporting

The output layout and what to report from it are in `agent/instructions.md`; hand `spec.md` to `/aspira-planner` only as it allows. Read `trace/review.json` for the status even when the command exits successfully. If a run fails before exporting, show its log or error and do not present an earlier report as the new result. Say which mode produced the report: a `--local` run used this session's model throughout, so its review is not independent of the writer.
