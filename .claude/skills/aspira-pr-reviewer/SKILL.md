---
name: aspira-pr-reviewer
description: Run the official pr-reviewer agent on a pull request (a GitHub PR or a local branch) and report its result. By default it launches pr-reviewer as a separate process; with --local the same agent pipeline runs inside this Claude Code session, using the agent's own instruction files. Use for /aspira-pr-reviewer or requests to review a PR or branch with this agent.
argument-hint: [<ticket ID | Notion URL> | <github-pr | repo-path> --no-ticket] [--local] [--force-pull] [--branch B] [--base main] [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--yes]
---

# PR review

This skill only runs the official pr-reviewer agent. What the review does, its rules and how its result is reported are defined by the agent, in the pr-reviewer package:

- `agent/instructions.md`: the orchestrator, the authority for the rules and the report.
- `agent/subagents/<seat>/persona.md`: each seat and Quinn. Their system prompt is the shared prefix (`agent/lib/shared-prefix-instructions.ts`): the packet and the review instructions, the same bytes for all seven, so the seats share one cached prefix; the persona follows it in the message.
- `agent/lib/review.ts`: the prompts, the output schemas, the stopping rule and the verdict.
- `agent/tools/load-knowledge.ts` and the agent's env (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`): which Notion engineering guidelines it loads.

This file covers only how to run the agent, and the agent's files win wherever the two seem to differ. The package README describes the pipeline.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The ticket's pages are pulled into `.work/<id>-<slug>/`, the PR under review is the ticket's PR property, and the review lands in `pr-review/` in that folder. A file path only works with `--no-ticket`, for a repository with no board: the source is then a GitHub PR (`https://github.com/owner/name/pull/123` or `owner/name#123`) or a local repository path, where `--branch` names the branch (default: the checked-out one) and `--base` the base (default `main`); a GitHub PR names its own base, so neither flag applies to it. The run then records `ticket: none`. A path or a PR without `--no-ticket` is an error that names the flag.

The pr-reviewer runs only from `In Review: Implementation` with the PR property set. Any other Status, or a missing PR, is refused before any model call: the refusal names the ticket, its Status, the Status the reviewer needs and who makes that move. The review makes no board move: not on start, not on success, not on failure. On success it puts `review.md` on the ticket as the child page `PR Review`, in addition to the PR comment. It never moves a card to a Ready column. A local file newer than its ticket page is not overwritten unless `--force-pull` is given; the run stops and names the file.

Both modes use `scripts/pr-reviewer.sh` beside this file (use its absolute path) and export the same files. Run from the project repository, or pass `--repo` (the ticket's working folder lives under its `.work/`).

Flags both modes take: `--max-rounds N` caps the rounds; `--max-cost USD` is the budget (default `MAX_COST_USD` from the agent's environment, unset means none; a cloud run is refused before any model call when one round is estimated above it, and the refusal names both numbers); `--since DIR` re-reviews only what changed since the previous review exported to DIR; `--no-comment` keeps a GitHub PR's review off the PR. `--yes` is for the default mode only and skips the estimate.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `pr-reviewer`, a separate eve process | subagents of this Claude Code session |
| Models | as configured in the agent's `agent.ts` files | this session's model, for every seat and Quinn |
| Instructions | the agent's files | the same files, read from disk on every `local` call |
| Guidelines | `load-knowledge` fetches them from Notion | this session fetches the same pages with the Notion MCP |
| Cost | Vercel AI Gateway, itemized in `cost.md`; `--max-cost` stops the run | this session's usage, not itemized; `--max-cost` is recorded, not enforced |
| Needs | Node 24, pnpm, screen, the agent's `.env.local` | Node 24, pnpm, git, the Notion MCP; `GITHUB_TOKEN` or `gh` for a GitHub PR |

The launcher resolves the package from `PR_REVIEWER_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/pr-reviewer` under the project's `node_modules`, then its own location. A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`. That package's files are the ones that run.

## Default: launch the agent

```bash
<skill-dir>/scripts/pr-reviewer.sh start [<ticket> | <github-pr | repo-path> --no-ticket] [--force-pull] [--repo DIR] [--branch B] [--base main] [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--yes]
```

With a ticket, the launcher does the board work itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the estimate (resolve, gate, pull; a refusal exits 3 and launches nothing), and the push of `review.md` as `PR Review` after the agent exits, appended to the run's log and recorded in `trace/board.json`. Before it detaches, it prints an estimate: the diff size in changed lines, the seats and round cap, and a dollar range from the `cost.md` files of this package's previous reviews (seeded from the NOM-4 review until there are any), with one line saying `--local` costs session usage instead. The estimate is printed, not confirmed; show it to the user as printed, and pass `--yes` only for an unattended run. It then detaches the agent in `screen` and prints a run directory. Tell the user it started. Check it with `status <run-dir>`, or with `wait <run-dir> --max 30` between updates. The wait returns without stopping the agent, so keep checking until it finishes or the user cancels. Do not automatically retry failed or incomplete reviews: every run is paid. If the launch fails, report the error. When the run finishes, the log holds the agent's reply; relay it.

## `--local`: run the agent's pipeline in this session

`local` replays the agent's pipeline with this session as the model. It makes no model calls itself. It stands in for the agent's tools: it loads the PR, checks the guidelines, builds the packet, runs the round loop, exports and comments. It prints the next stage, with each turn's prompt assembled at that moment from the agent's own files, and you run those turns as subagents. You are the orchestrator here: read the file named in `orchestrator` in full before the first stage. It is the authority for what you do and how you report. Run the turns as listed and do not edit the prompt files.

```bash
<skill-dir>/scripts/pr-reviewer.sh local [<ticket> | <github-pr | repo-path> --no-ticket] [--force-pull] [--repo DIR] [--branch B] [--base main] [--max-rounds N] [--max-cost USD] [--since DIR] [--no-comment] [--output DIR] [--knowledge DIR] [--finish] [--verify]
```

Pass the same ticket (or source) and options to every call.

0. **Board.** With a ticket, the first call prints `stage: "board"`: the board work for this session to perform with the Notion MCP, listed as data in `actions`. A `resolve` action names the ticket and the board: fetch the ticket and write `ticket.md` at `write` in exactly the `format` given. A `pull` action names a child page and the file to write it to as plain markdown. Perform every action, then run `local` again; the driver reads `ticket.md`, refuses when its Status is not `In Review: Implementation` or its PR is unset, and lists what is still missing until the folder is in sync. The reviewer lists no `move` action, and the session makes none. Never move a card anywhere the stage does not list.
1. **Guidelines.** The engineering guidelines are mandatory. `local` will not start a review without them, and there is no flag to skip them. Run `local`. Until the folder exists it refuses, exits 3 and prints `stage: "knowledge"` with a `knowledge` object, read from the agent's own load-knowledge configuration. That object gives:
   - the folder to build, `dir`;
   - the root page, `root`, which is the agent's `KNOWLEDGE_PAGE`;
   - the required pages, `required`;
   - the walk limits, `maxDepth` and `maxPages`;
   - the file layout, `files`.

   Build that folder with the Notion MCP (`notion-fetch`, read-only), in the shape load-knowledge writes:
   - `INDEX.md`: the root page as fetched.
   - One file per page reached from the root by its child pages and page links, breadth first, within `maxDepth` levels and `maxPages` pages, named as `files.pages` says.
   - `REQUIRED.md`: the `required` pages in full, in that order, each under `# <page title>` and separated by `---`. Keep the text as fetched, rule IDs included.

   If a page is truncated or cannot be fetched, stop and say so. If `root` is null, the agent has no guidelines configured; stop and say so. Then run `local` again. It checks the folder, fingerprints it, and passes its paths into every prompt the way the agent passes load-knowledge's folder. With `--knowledge DIR` the folder is DIR instead.
2. **Seats.** Once the guidelines are in place, `local` prints `stage: "seats"`, `round: 1` and six tasks, plus `packet` (what every prompt starts with) and `target` (the shas under review). For each task, launch one `general-purpose` subagent with exactly this message, with the task's paths filled in:

   `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`

   Launch all six seat tasks **in one message**, as six parallel subagents, and wait for all six. The prompt file says how a session turn maps the agent's tools: `read_files` is the Read tool over each listed path, `read_diff` is the `diff --git` section of each listed path in the work directory's `pr.patch`, `search` is Grep with two lines of context.
3. **Quinn.** Run `local` again. It prints `stage: "verifier"` and one task. Launch one subagent the same way.
4. **Repeat** steps 2 and 3 until the driver says the rounds are done by printing `stage: "documents"`. Whether another round runs is the driver's decision, not yours: it applies the agent's stopping rule from `agent/lib/review.ts`.
5. **Documents**, then **checks.** Each of these stages has two tasks; launch both in one message. Run `local` between them.
6. **Export.** Run `local` a last time. It writes the review with the shas stamped in, posts the comment when the agent would, and prints the result. That result includes `orchestrator.text`, the agent's instructions as they are now. With a ticket it also carries `board`, stage `board-end`: the `push` of `review.md` to the ticket as the page `PR Review` (create it, or replace the content of the page with that title; then record its URL in the Pages table of `ticket.md`), or nothing after a failed run. Perform it with the Notion MCP, then run the command in `board.verify.command` (`local <ticket> --verify`): the driver checks `ticket.md`, completes `trace/board.json`, and prints the report lines. If the push fails, say so with the local path of the review and still report the review. Report the review as the agent's instructions say, and add that it ran with `--local`.

A task that comes back with an `error` wrote an output that failed its schema, and the driver has set that output aside. When that happens, send the error back and resend it once: the same message plus the error, to a new subagent. `retry: false` means that turn has already been resent once. After that, or when a subagent cannot finish, run `local ... --finish`. It exports what exists, with the missing turns listed in `missing` and the status `incomplete`, and an `incomplete` export is not a finished review.

The work directory, `<output>.local/`, holds the prompts, the packet and the outputs between steps and, by default, the guidelines folder. It is removed after export. Every prompt and output is kept in `trace/calls.json` and the guidelines in `trace/guidelines/`. If the branch, the working tree, the PR head or the guidelines change mid-review, `local` refuses to continue; delete the work directory to start again.

`--local` is not independent of this session: every seat and Quinn run on this session's model. Say so when you report a `--local` review.

## Results

With a ticket, the review goes to `.work/<id>-<slug>/pr-review/`, the ticket's working folder, and `trace/board.json` there records every board action with the Status before and after. With `--no-ticket`, a local repository's review goes to `<repo>/.work/<ticket>/pr-review/` (`<ticket>` is the branch without its type prefix) and a GitHub PR's review to `reviews/<date>-<branch>/` in the pr-reviewer package. `--output` overrides all three. Start the report with the ticket ID and title, the Status before and after, the pages pushed with their URLs, and the working folder (the `report` lines of the verify step, or the launcher's log), or `Ticket: none` for a `--no-ticket` run. Both modes write the agent's files there: `review.md`, `findings.md`, `conversation.md`, `pr.md`, `pr.patch`, `changed_files.txt` and `cost.md`, plus `previous-findings.md` for a re-review. `--local` adds `trace/`. The previous review's directory is what `--since` takes next time. If a run fails before exporting, show its error rather than an earlier review.
