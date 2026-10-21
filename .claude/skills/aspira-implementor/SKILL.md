---
name: aspira-implementor
description: Implement a feature test-first under the Aspira engineering rules in Notion, from a planner plan, a spec or a ticket, with the official implementor agent. By default the agent's own procedure runs inside this Claude Code session on the local checkout, with subagents for the parallel lanes; with --cloud it launches the implementor agent on the GitHub repository and reports back. Use for /aspira-implementor or requests to implement, build or execute a plan, spec or ticket.
argument-hint: [<ticket ID | Notion URL> | <plan.review | plan.reviewed.md | spec.md> --no-ticket] [--cloud] [--force-pull] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] [--max-parallel N] [--serial] [--guidelines FILE] [--parent-run RUN:NONCE]
disable-model-invocation: true
---

# Aspira implementor

This skill calls the `implementor` agent. It does not carry the agent's rules. The authority is the agent's own files in `packages/agents/implementor/`:

- `agent/skills/aspira-implementor/SKILL.md`: the procedure (eve loads it with `load_skill`; the default mode embeds it in every prompt).
- `agent/instructions.md`: the agent's system prompt, which covers the cloud run.

Do not build from memory of either file and do not summarize them into a prompt. The driver hands each task the current text of both files.

Both modes use `scripts/implementor.sh` beside this file (use its absolute path). A leading `@` on the source is dropped.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket's pages are pulled into `.work/<id>-<slug>/` and the implementor builds `plan.review/plan.reviewed.md` from there; a ticket with no Plan page yet is refused, naming the page. A file path only works with `--no-ticket`, for a repository with no board; the run then records `ticket: none`. A file path without `--no-ticket` is an error that names the flag.

The implementor runs only from `Ready: Plan`, or from its own `In Progress: Implementation` (a retry after a failure, which makes no start move). Any other Status is refused before any model call: the refusal names the ticket, its Status, the Status the implementor needs and who makes that move. On start it sets Dev and moves the card to `In Progress: Implementation`; on success it puts `plan.review/implementation.md` on the ticket as the child page `Implementation`. It sets the ticket's PR property and moves the card to `In Review: Implementation` only when it opened the PR (`--pr`, as a separate process); after a build in this session (the default), which pushes nothing, the card stays `In Progress: Implementation` and the report says that opening the PR is the remaining step. On failure the card stays `In Progress: Implementation`. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file. The separate-process run clones the repository from GitHub and cannot read `.work/` when it is gitignored (kit init's default), so `--cloud` with a ticket is refused before any board action in that case: run the ticket in this session (the default), or pass a committed plan path with `--no-ticket`.

| | Default | `--cloud` |
| --- | --- | --- |
| Where the work runs | this session as orchestrator, subagents as lane workers | the `implementor` eve agent, a separate process |
| Repository | the local checkout; nothing is pushed | a GitHub repository, cloned by the agent; it pushes an `implement/` branch |
| Notion rules | `local` runs `load-knowledge` itself with `NOTION_TOKEN`, or pass `--guidelines` | `load-knowledge` |
| Tickets | the `board` stage lists the same work for you to do with the Notion MCP | the launcher claims the ticket and pulls its Plan page before the run, and pushes and moves after it |
| Needs | Node 24, pnpm, git, the Notion MCP for the board, `NOTION_TOKEN` for the rules (or `--guidelines`) | Node 24, pnpm, screen, the agent's `.env.local` |

The default builds the local checkout in this session, a ticket included. Use `--cloud` for an unattended build on GitHub. `--local` is still accepted and means the default.

## Default: run the agent's procedure in this session

```bash
<skill-dir>/scripts/implementor.sh local [<ticket> | <plan.review | plan.reviewed.md | spec.md> --no-ticket] [--force-pull] [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--finish] [--verify] [--parent-run RUN:NONCE] [--attach JSON]
```

Each `local` call makes no model call. It prints one JSON stage, and you do what it lists, then call `local` again with the same source and options. Repeat until it prints `"pending": false`.

The Notion rules come first and nothing else runs without them: `local` runs `load-knowledge` itself, once per run, with `NOTION_TOKEN` from the environment, the app's `.env.local` or the project's `.env.local`, loading the pages the agent's own knowledge configuration names (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`). This session never fetches guidelines; a truncated or missing page stops the run, naming it, and with no token the run ends `blocked`. `--guidelines` takes only a `REQUIRED.md` that `load-knowledge` wrote, still where it wrote it; any other file, a `trace/` copy included, is refused, and the run records that live Notion was not read.

0. **`board`** (first, with a ticket). The board work for this session to perform with the Notion MCP, listed as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. A `set` action and a `move` action name the property and the Status to set on the ticket page, and `then` says what to update in `ticket.md` afterwards. Perform every action, then call `local` again; the driver reads `ticket.md`, refuses when its Status is not the one the implementor needs, and lists what is still missing until the folder is in sync. Never move a card anywhere the stage does not list.
1. **`knowledge`**: `local`'s own `load-knowledge` step already built the folder, or `blocked` names what to set. Run `local` again once it is set, or pass the same `--guidelines` snapshot to every call.
2. **Model stages.** Each lists `tasks: [{id, agent, prompt, output, schema}]`.
   - `agent: "orchestrator"`: do it yourself, in this session. Read `prompt` in full and follow it. It contains the agent's procedure and instructions and says which of their sections apply to this stage. Write the JSON result to `output`.
   - `agent: "worker"`: launch one `general-purpose` subagent per task, model `<task.model>` (KIT-48), all of a stage's worker tasks in one message, with exactly this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
   - The stages come in this order: `plan` (spec or ticket input only), `parallelize`, then for each wave `wave` (its worker lanes, at most `--max-parallel` at a time) and `wave-commit` (yours), then `verification`. A reviewed plan is gated by the driver first; `refused` or `blocked` ends the run with the reason.
3. **Errors.** A task with an `error` wrote an output that failed its schema or the driver's checks, and the driver set it aside. Fix it once (for a worker, resend the same message plus the error to a new subagent). `retry: false` means it has already been resent. Then, or when a task cannot finish, run `local ... --finish`, which exports what exists as `incomplete` with the missing stages listed.

4. **`board-end`.** The finished run carries `board` again: the `push` of `implementation.md` to the ticket as the page `Implementation` (create it, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`), or nothing after a failed run; no move, since a build in this session opens no PR. Perform the push with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md`, completes `trace/board.json`, and prints the report lines. If the push fails, say so with the local path of the implementation report and still make the move the stage lists, when it lists one.

The run directory `<work dir>/implementation.local/` holds the knowledge, prompts, outputs and state between steps. If the source or the knowledge folder changes mid-run, `local` refuses to continue; delete the run directory to start again. On export the driver writes `<work dir>/trace/implementation-local.json` (every prompt and output, the gate, and the Notion pages used with their hashes) and removes the run directory.

The default mode runs on this session's model, so the workers are not independent of the session that may have written the spec. Say so in the report.

## `--cloud`: launch the agent

```bash
<skill-dir>/scripts/implementor.sh start [<ticket> | <path-in-repo> --no-ticket] [--force-pull] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] [--parent-run RUN:NONCE]
```

With a ticket, the launcher makes the board moves itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing), and the push, the PR property and the success move after it exits, appended to the run's log and recorded in `plan.review/trace/board.json`. The pulled plan must be committed and pushed like any other source. With `--repo owner/name` (or a GitHub URL) and `--no-ticket`, the source is a path inside that repository. Without it, the launcher uses the repository of the current directory: it reads `owner/name` from the `origin` remote and starts from the current branch. It refuses a source that is not committed and pushed, since the agent can only see what is on GitHub. `--pr` asks the agent for a draft pull request.

The launcher resolves the agent from `IMPLEMENTOR_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/implementor` under the project's `node_modules`, then its own location. A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`. It detaches the run in `screen` and prints a run directory. Tell the user it started. Check on it with `status <run-dir>`, or `wait <run-dir> --max 30` between updates, until it finishes or the user cancels; waiting does not stop the agent. Do not retry a failed run automatically, because every run costs model time. If the launch fails, show the error and do not build by hand. When it finishes, relay the agent's report from the log.

## Run telemetry

Every run of this skill on a ticket writes one telemetry file, `.work/<id>-<slug>/telemetry/<run-id>.json` (OpenTelemetry JSON: the run, its waves' subagents, with timings, tokens, tool calls and cost where they are measured), and attaches it to the end of the ticket page when the Feature Board rules list it (BOARD-003). A telemetry failure is a notice beside the result: it never changes the run's status, the card's move or the exit code.

- **`--cloud`.** The launcher does it all: `ticket.ts start` prints `run-id=` and `run-started=`, and the finish step after the agent exits writes the file from them and attaches it. Nothing to do here.
- **Default.** The session reports its own usage, since only it sees its subagents:
  1. Record the wall-clock start and end (ISO 8601) of every subagent you launch (every lane worker of every wave is its own entry), with the total tokens, tool uses and duration the Agent tool reports for it, and its model when you know it.
  2. Every pending step on a ticket prints `sessionUsage` with a `file` and a `runId`. Before the call that exports the run (the call after the last wave's outputs are written, or `--finish`), write that `file` (`plan.review/trace/session-usage.json`) as JSON: `{"runId": "<runId>", "subagents": [{"label": "…", "startedAt": "…", "endedAt": "…", "totalTokens": 0, "toolUses": 0, "wallMs": 0, "model": "…"}]}`, one entry per subagent in launch order. `label` is a short name of your own (`research`, `lane A`), never the task's description or prompt text. Leave out a number you do not have; never guess one. Without the file the run's telemetry records the subagents as missing.
  3. The export's `board.actions` then end with two telemetry actions. `read` (`target: "board-rules"`): fetch the Feature Board rules page with the Notion MCP (`notion-fetch`, read-only) and write it to `file` as plain markdown, one rule per line. `attach`: only when one line of the rules you saved contains every string of `onlyIf`, attach `file`, as `name`, in one file block at the end of the ticket page `page`: `notion-create-attachment` for a file of at most 200 KiB, otherwise `notion-create-file-upload`, then `notion-update-page`. Attach no other file, to no other page, and never edit or delete another block.
  4. Pass the result to the verify step: `local <ticket> --verify --attach '{"blockId":"<the new block id>"}'`, or `--attach '{"error":"<why>"}'` when the rules do not allow it or the attach failed. A missing, refused or failed attach is a notice in the verify output, never a failed verify.
- **`--parent-run <run-id>:<nonce>`** (a step of an `/aspira-build-feature` run, which prints it on the step's command). Skip all of the above: the run writes no usage report, reads no rules and attaches nothing; build-feature records the step in its own telemetry. Pass `--parent-run` unchanged on every call of the launcher, `start` or `local`, `--verify` included. A malformed value, or one that does not name the pending step of the build-feature run on the ticket, is refused (exit 3) naming `--parent-run`.
- **`--no-ticket`** runs write no telemetry.

The separate-process implementor records timing only: its run has no usage file, so its telemetry carries the run's start and end without phases.

## Report

A non-zero exit is a run status to relay (exit 0 is ready, 1 incomplete or blocked, 3 refused, 5 needs-author): never retry or rerun it on needs-author, settle the open decisions the report names first. Start the report with the run status, the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log), then relay the agent's report (`--cloud`) or the final `verification` result and `implementation.md` (the default): status, branch, commits, the feature table, deviations with rule IDs, assumptions, blockers, the pull request link if any, and which mode produced it. With a ticket and no PR, opening the PR is the remaining step: say so. The next steps are `/aspira-code-analyzer`, then `/aspira-pr-reviewer`. A refused, blocked or incomplete run is not a finished build; say what stopped it.
