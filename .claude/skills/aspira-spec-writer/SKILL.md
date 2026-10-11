---
name: aspira-spec-writer
description: Turn a feature idea (a file, a Notion card or inline text) into a reviewed spec with the official spec-writer pipeline. It explores the repository, writes an initial draft in the Aspira spec contract, then runs the official spec review on that draft, and reports the written spec, the draft, open author decisions and a run analysis. By default it runs spec-writer as a separate process on Claude and OpenAI models; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-spec-writer or requests to write a spec from an idea.
argument-hint: [<ticket ID | Notion URL> | <idea.md> --no-ticket] [--local] [--force-pull] [--guidelines FILE] [--repo DIR] [--output DIR]
---

# Spec writer

This skill only runs the official spec-writer agent. Its rules live in the agent package, not here: `agent/instructions.md` is the authority for what the agent does, what it writes and how its result is reported, and the phase prompts come from its `agent/lib/` modules (and spec-reviewer's, for the review half). This file covers mechanics only. The pipeline is explore, draft, then the spec review on the draft: research, six parallel specialists, one reconciliation.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket is pulled into `.work/<id>-<slug>/`: `ticket.md`, and the ticket's Idea body as `idea.md`, which the writer reads as is. Never rewrite or embellish the idea: what it leaves open is for the pipeline to surface. The idea file is never modified after the pull. The output goes to `spec.written/` in that folder, and the written spec is copied to `spec.md` beside it. A file path only works with `--no-ticket`, for a repository with no board; the run then records `ticket: none`. A file path without `--no-ticket` is an error that names the flag.

The writer runs only from `Ready: Idea`, or from its own `In Progress: Spec` (a retry after a failure, which makes no start move). Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the writer needs and who makes that move. On start it sets Dev and moves the card to `In Progress: Spec`; on success it puts `spec.md` on the ticket as the child page `Spec` and moves the card to `In Review: Spec`; on failure, or when no spec was written, the card stays `In Progress: Spec`. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file.

## The idea without a ticket

With `--no-ticket` the pipeline reads the idea from a file. Turn whatever the user gave you into one first:

- **A file or `@` mention** (`@specs/cart/idea.md`): use it as is; the leading `@` is stripped.
- **A Notion page URL** that is not a Feature Board ticket, or **inline text**: write its title and full content, unedited, to the file the user names (with a `Source: <url>` line under the title for a page), and pass that file.

The repository is the git root of the current directory unless `--repo` is given. With `--no-ticket`, results go to `spec.written/` beside the idea file unless `--output` is given. Both modes use `scripts/spec-writer.sh` beside this file (use its absolute path) and produce the same report.

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
<skill-dir>/scripts/spec-writer.sh start [<ticket> | <idea.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

The launcher does the board work itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing), and the copy to `spec.md`, the push and the success move after it exits, appended to the run's log and recorded in `trace/board.json`. With `--guidelines` the launcher runs the agent's CLI on that snapshot; otherwise it runs the eve entry point, which loads the guidelines with `load-knowledge` (Notion credentials and its Docker sandbox). The launcher resolves the package from `SPEC_WRITER_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/spec-writer` under the project's `node_modules`, then its own location A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`., and prints the run directory and the agent's `instructions:` file.

The run is detached. Tell the user it started and where results will go, then use `status <run-dir>`, or `wait <run-dir> --max 30` between updates (`watch` is an alias). Waiting returns control without stopping the agent; keep checking until it finishes or the user cancels. If launch fails, report the error. When it finishes, read the file named in `instructions:` and report the result the way it says.

## `--local`: run the pipeline in this session

```bash
<skill-dir>/scripts/spec-writer.sh local [<ticket> | <idea.md> --no-ticket] [--force-pull] [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR] [--finish] [--verify]
```

Each `local` call is one synchronous step. It makes no model calls: it prints JSON naming the next `stage` and its tasks, each with a `prompt` file assembled at that moment from the agent's own files and the `output` file to write, or the finished report. Every result carries `orchestrator`, the agent's `agent/instructions.md`: read the file named in `orchestrator` in full once, before the first phase. In this mode the `local` steps stand in for the agent's write tool, and you stand in for its router. Run the tasks as subagents and do not edit the prompt files: their content is exactly what the agent's phases get.

1. **Board** (first, with a ticket). `stage: "board"` lists the board work for this session to perform with the Notion MCP, as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. A `set` action and a `move` action name the property and the Status to set on the ticket page, and `then` says what to update in `ticket.md` afterwards. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not the one the writer needs, and lists what is still missing until the folder is in sync. Never move a card anywhere the stage does not list.
2. **Knowledge.** The engineering guidelines are mandatory; the driver refuses to start without them. With `--guidelines`, pass the same snapshot to every call. Otherwise the first call prints `stage: "knowledge"` with `knowledge.dir`, `knowledge.root` (the agent's `KNOWLEDGE_PAGE`), `knowledge.required` (the agent's `KNOWLEDGE_REQUIRED` pages, in order), `maxDepth`, `maxPages` and any `problems` with a folder already there. Build that folder with the Notion MCP the way the agent's `load-knowledge` does:
   - `INDEX.md`: the `root` page in full. When `root` is null, search Notion for the required pages by title and use the page that links them.
   - One file per page linked from the index, down to `maxDepth` levels and at most `maxPages` pages, named after the page title in kebab case, each starting `<!-- <title> · <url> -->`.
   - `REQUIRED.md`: every `required` page in order, each as `# <page title>`, then `<!-- <url> -->`, then its full content, separated by `---`, text as fetched with rule IDs.

   If a page is truncated or cannot be fetched, stop and say so. Run `local` again; it prints `problems` until the folder is complete.
3. **Explore.** `stage: "explore"`, one task. Launch one `general-purpose` subagent with this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
4. **Draft.** `stage: "draft"`, one task, the same way.
5. **Review research.** `stage: "research"`, one task, the same way.
6. **Specialists.** `stage: "specialists"`, six tasks. Launch all six subagents **in one message**, one per task, with the same message. The `ui` task needs the `aspiralabs-ui` MCP; its prompt says what to do without it.
7. **Reconciliation.** `stage: "reconciliation"`, the `synthesis` task, the same way.
8. **Report.** The last call prints `status`, `dir`, `spec`, `draft`, `findings`, `problems` and `authorDecisions`, and, with a ticket, `ticketSpec` (the copy of the written spec at `spec.md` in the working folder) and `board` again (stage `board-end`): the `push` of that `spec.md` to the ticket as the page `Spec` (create it, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`) and the success `move`, or nothing after a failed run. Perform them with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md` shows the expected Status, completes `trace/board.json`, and prints the report lines. If a push fails, say so with the local path of the spec and still make the move. Report it as the file named in `orchestrator` says, with the open author decisions and their options from `trace/decisions.md`.

A task that comes back with an `error` wrote an output that failed its schema: send that error back once, to the same subagent or a new one with the same message plus the error. If it fails again or a subagent cannot finish, run `local ... --finish` to export what exists with the missing phases recorded as failures. The work directory, `<output>.local/`, holds the knowledge folder, prompts and outputs between steps and is removed after export; every prompt and output is kept in `trace/calls.json`, the rules used (source, files and hashes) in `trace/review.json`, and every board action with the Status before and after in `trace/board.json`. If the idea, the guidelines or the repository change mid-run, `local` refuses to continue; delete the work directory to start again.

## Reporting

Start the report with the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log). The output layout and what to report from it are in `agent/instructions.md`; hand `spec.md` to `/aspira-planner` only as it allows. Read `trace/review.json` for the status even when the command exits successfully. If a run fails before exporting, show its log or error and do not present an earlier report as the new result. Say which mode produced the report: a `--local` run used this session's model throughout, so its review is not independent of the writer.
