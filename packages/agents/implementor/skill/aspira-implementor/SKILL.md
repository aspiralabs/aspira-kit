---
name: aspira-implementor
description: Implement a feature test-first under the Aspira engineering rules in Notion, from a planner plan, a spec or a ticket, with the official implementor agent. By default it launches the implementor agent on the GitHub repository and reports back; with --local the agent's own procedure runs inside this Claude Code session on the local checkout, with subagents for the parallel lanes. Use for /aspira-implementor or requests to implement, build or execute a plan, spec or ticket.
argument-hint: [<ticket ID | Notion URL> | <plan.review | plan.reviewed.md | spec.md> --no-ticket] [--local] [--force-pull] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] [--max-parallel N] [--serial] [--guidelines FILE]
---

# Aspira implementor

This skill calls the `implementor` agent. It does not carry the agent's rules. The authority is the agent's own files in `packages/agents/implementor/`:

- `agent/skills/aspira-implementor/SKILL.md`: the procedure (eve loads it with `load_skill`; `--local` embeds it in every prompt).
- `agent/instructions.md`: the agent's system prompt, which covers the cloud run.

Do not build from memory of either file and do not summarize them into a prompt. The driver hands each task the current text of both files.

Both modes use `scripts/implementor.sh` beside this file (use its absolute path). A leading `@` on the source is dropped.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket's pages are pulled into `.work/<id>-<slug>/` and the implementor builds `plan.review/plan.reviewed.md` from there; a ticket with no Plan page yet is refused, naming the page. A file path only works with `--no-ticket`, for a repository with no board; the run then records `ticket: none`. A file path without `--no-ticket` is an error that names the flag.

The implementor runs only from `Ready: Plan`, or from its own `In Progress: Implementation` (a retry after a failure, which makes no start move). Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the implementor needs and who makes that move. On start it sets Dev and moves the card to `In Progress: Implementation`; on success it puts `plan.review/implementation.md` on the ticket as the child page `Implementation`. It sets the ticket's PR property and moves the card to `In Review: Implementation` only when it opened the PR (`--pr`, as a separate process); after a `--local` build, which pushes nothing, the card stays `In Progress: Implementation` and the report says that opening the PR is the remaining step. On failure the card stays `In Progress: Implementation`. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file. The separate-process run clones the repository from GitHub and cannot read `.work/` when it is gitignored (kit init's default), so `start` with a ticket is refused before any board action in that case: run the ticket with `--local`, or pass a committed plan path with `--no-ticket`.

| | Default | `--local` |
| --- | --- | --- |
| Where the work runs | the `implementor` eve agent, a separate process | this session as orchestrator, subagents as lane workers |
| Repository | a GitHub repository, cloned by the agent; it pushes an `implement/` branch | the local checkout; nothing is pushed |
| Notion rules | `load-knowledge` | the `knowledge` stage: you fetch the listed pages with the Notion MCP, or pass `--guidelines` |
| Tickets | the launcher claims the ticket and pulls its Plan page before the run, and pushes and moves after it | the `board` stage lists the same work for you to do with the Notion MCP |
| Needs | Node 24, pnpm, screen, the agent's `.env.local` | Node 24, pnpm, git, the Notion MCP (or `--guidelines`) |

Use the default for unattended builds on GitHub. Use `--local` for a local checkout, a ticket, or to keep the build in this session.

## Default: launch the agent

```bash
<skill-dir>/scripts/implementor.sh start [<ticket> | <path-in-repo> --no-ticket] [--force-pull] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr]
```

With a ticket, the launcher makes the board moves itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing), and the push, the PR property and the success move after it exits, appended to the run's log and recorded in `plan.review/trace/board.json`. The pulled plan must be committed and pushed like any other source. With `--repo owner/name` (or a GitHub URL) and `--no-ticket`, the source is a path inside that repository. Without it, the launcher uses the repository of the current directory: it reads `owner/name` from the `origin` remote and starts from the current branch. It refuses a source that is not committed and pushed, since the agent can only see what is on GitHub. `--pr` asks the agent for a draft pull request.

The launcher resolves the agent from `IMPLEMENTOR_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/implementor` under the project's `node_modules`, then its own location. A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`. It detaches the run in `screen` and prints a run directory. Tell the user it started. Check on it with `status <run-dir>`, or `wait <run-dir> --max 30` between updates, until it finishes or the user cancels; waiting does not stop the agent. Do not retry a failed run automatically, because every run costs model time. If the launch fails, show the error and do not build by hand. When it finishes, relay the agent's report from the log.

## `--local`: run the agent's procedure in this session

```bash
<skill-dir>/scripts/implementor.sh local [<ticket> | <plan.review | plan.reviewed.md | spec.md> --no-ticket] [--force-pull] [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--finish] [--verify]
```

Each `local` call makes no model call. It prints one JSON stage, and you do what it lists, then call `local` again with the same source and options. Repeat until it prints `"pending": false`.

0. **`board`** (first, with a ticket). The board work for this session to perform with the Notion MCP, listed as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. A `set` action and a `move` action name the property and the Status to set on the ticket page, and `then` says what to update in `ticket.md` afterwards. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not the one the implementor needs, and lists what is still missing until the folder is in sync. Never move a card anywhere the stage does not list.
1. **`knowledge`** (nothing else runs without it). The stage lists `pages` from the agent's own knowledge configuration (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`): the index page, the required pages, and, once those are in, the topic pages they route to. Fetch every page with `present: false` using the Notion MCP (by `url`, or by `title` when there is no URL). Write each to `knowledgeDir`, at `file` when given, else `<title in kebab case>.md`. Start each file with the `pageHeader` line filled in, followed by the page content exactly as fetched. Then run `local` again; it may list more pages. When all are present, the driver writes `REQUIRED.md` the way `load-knowledge` does. If a page cannot be fetched, stop and say so. With `--guidelines FILE` (a `REQUIRED.md` snapshot), this stage is skipped and the run records that live Notion was not read.
2. **Model stages.** Each lists `tasks: [{id, agent, prompt, output, schema}]`.
   - `agent: "orchestrator"`: do it yourself, in this session. Read `prompt` in full and follow it. It contains the agent's procedure and instructions and says which of their sections apply to this stage. Write the JSON result to `output`.
   - `agent: "worker"`: launch one `general-purpose` subagent per task, all of a stage's worker tasks in one message, with exactly this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
   - The stages come in this order: `plan` (spec or ticket input only), `parallelize`, then for each wave `wave` (its worker lanes, at most `--max-parallel` at a time) and `wave-commit` (yours), then `verification`. A reviewed plan is gated by the driver first; `refused` or `blocked` ends the run with the reason.
3. **Errors.** A task with an `error` wrote an output that failed its schema or the driver's checks, and the driver set it aside. Fix it once (for a worker, resend the same message plus the error to a new subagent). `retry: false` means it has already been resent. Then, or when a task cannot finish, run `local ... --finish`, which exports what exists as `incomplete` with the missing stages listed.

4. **`board-end`.** The finished run carries `board` again: the `push` of `implementation.md` to the ticket as the page `Implementation` (create it, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`), or nothing after a failed run; no move, since a `--local` build opens no PR. Perform the push with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md`, completes `trace/board.json`, and prints the report lines. If the push fails, say so with the local path of the implementation report and still make the move the stage lists, when it lists one.

The run directory `<work dir>/implementation.local/` holds the knowledge, prompts, outputs and state between steps. If the source or the knowledge folder changes mid-run, `local` refuses to continue; delete the run directory to start again. On export the driver writes `<work dir>/trace/implementation-local.json` (every prompt and output, the gate, and the Notion pages used with their hashes) and removes the run directory.

`--local` runs on this session's model, so the workers are not independent of the session that may have written the spec. Say so in the report.

## Report

Start the report with the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log), then relay the agent's report (default) or the final `verification` result and `implementation.md` (`--local`): status, branch, commits, the feature table, deviations with rule IDs, assumptions, blockers, the pull request link if any, and which mode produced it. With a ticket and no PR, opening the PR is the remaining step: say so. The next steps are `/aspira-code-analyzer`, then `/aspira-pr-reviewer`. A refused, blocked or incomplete run is not a finished build; say what stopped it.
