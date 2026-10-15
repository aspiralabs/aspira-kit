---
name: aspira-groomer
description: Groom a Feature card's Idea in rounds before it reaches Ready: Idea, with the official groomer agent. It finds what the repository already has for the idea, asks the product decisions the Idea leaves open, records the answers on the card's Grooming Decisions page and, once the human confirms, writes the Decisions and Terms into the card's Idea and moves the card to Shortlist. By default it runs the groomer as a separate process; with --local the rounds run inside this Claude Code session, in chat. Use for /aspira-groomer or requests to groom an idea or a card.
argument-hint: [<ticket ID | Notion URL>] [--local] [--force-pull] [--force-run] [--guidelines FILE] [--repo DIR] [--take-recommended] [--parent-run RUN:NONCE]
---

# Groomer

This skill only runs the official groomer agent. Its rules live in the agent package, not here: `agent/instructions.md` is the authority for what the agent asks, what it records and how its result is reported, and the round schema and the validators are its `agent/lib/` modules. This file covers mechanics only.

## The ticket is the argument

The first argument is the Feature Board ticket: an ID such as `NOM-4` (any case), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket (two is an error naming them). The board comes from the project's `aspira.json` (`kit init --board`). The groomer writes to the card, so it has no `--no-ticket` mode; a file path is refused. The ticket is pulled into `.work/<id>-<slug>/`: `ticket.md`, the Idea as `idea.md` and the Grooming Decisions page as `groom/trace/decisions.md`. Everything the groomer writes goes to `groom/` in that folder.

The gate (the shared ticket flow) decides which cards run: the Type, the Status and the moves are checked there before any model call, and a refusal says why and who can change it. Relay a refusal as printed; never move the card to make a run possible.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `groomer`, a separate process | subagents of this Claude Code session |
| How the human answers | ticks on the Grooming Decisions page, read by the next run | in this chat, round by round |
| Cost | Vercel AI Gateway, itemized in `groom/run-analysis.md` | this session's usage, not itemized |
| Needs | Node 24, pnpm, screen, the agents' `.env.local` with the Notion token; Docker when loading Notion guidelines | Node 24, pnpm, the Notion MCP (or `--guidelines`) |

Use `--local` to groom in this conversation; use the default to leave the questions on the page for whoever owns the card.

## Default: run the agent

```bash
<skill-dir>/scripts/groomer.sh start [<ticket>] [--force-pull] [--force-run] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--parent-run RUN:NONCE]
```

The launcher does the board work itself, through the shared board module with `NOTION_TOKEN` from the project's `.env.local`: the ticket step before the agent starts (a refusal exits 3 and launches nothing; a board the integration cannot read prints the board URL and the rule to check), and after the agent exits the finish step (the page's ticks, the page write, and on a confirm the Idea summary and the move), appended to the run's log and recorded in `groom/trace/board.json`. `--force-run` clears the marker another run left on the page; use it only when no other run is in progress. With `--guidelines` the launcher runs the agent's CLI on that snapshot; otherwise the agent loads the guidelines from Notion first and refuses to start without the required pages.

`start` prints the run directory (`run:`) and the instructions file. Follow the run with:

```bash
<skill-dir>/scripts/groomer.sh status <run>
<skill-dir>/scripts/groomer.sh wait <run> [--max 1..60]   # `watch` is the same command
```

Both print the agent package and version, the log tail, and from `groom/trace/groom.json` the run status, the Grooming Decisions page and the open question count, then the paths of `groom/trace/decisions.md` and `groom/run-analysis.md`. Call `wait` again until the run has finished; never sleep in a loop yourself.

## `--local`: the rounds in this session

```bash
<skill-dir>/scripts/groomer.sh local [<ticket>] [--force-pull] [--force-run] [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--verify] [--finish] [--take-recommended] [--parent-run RUN:NONCE] [--attach JSON]
```

Each call prints one JSON step and makes no model call. Do what the step says, then call `local` again with the same ticket. `--take-recommended` takes every open question whose branch is not an exit criterion (problem, who, done) as the agent's recommended option instead of waiting on the author; an exit-criterion question, and Confirm, are always asked in chat.

1. **Board** (first). `stage: "board"` lists the board work for this session to perform with the Notion MCP, as data in `actions`: `resolve` (write `ticket.md` in the given `format`), `pull` (write the page to the named file as plain markdown), `mark` (append the run paragraph to Grooming Decisions, creating the page when the card has none) and `move`. Perform every action, update `ticket.md` as each `then` says, and call `local` again. Never move a card anywhere a stage does not list.
2. **Knowledge.** The engineering guidelines are mandatory: without them the driver refuses to start and prints `stage: "knowledge"` with `knowledge.dir`, `knowledge.root`, `knowledge.required`, `maxDepth`, `maxPages` and any `problems`. Build that folder with the Notion MCP: `INDEX.md` (the `root` page), one file per linked page (kebab-case title, starting `<!-- <title> · <url> -->`), and `REQUIRED.md` (every `required` page in order, each as `# <page title>`, then `<!-- <url> -->`, then its full content, separated by `---`). If a page is truncated or cannot be fetched, stop and say so. With `--guidelines`, pass the same snapshot to every call.
3. **Round.** `stage: "round"`, one task. Launch one `general-purpose` subagent with: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.` A task that comes back with an `error` wrote a round the driver refused: send the error back once.
4. **Answers.** `stage: "answers"`: print the `report` (round zero) and every question of `questions` in chat verbatim and in order, each with its options, the recommended one and why it is the human's to decide; ask the Confirm question last when `confirm` is true. Write the human's answers to the `answers` file exactly as the `note` says. The driver refuses an unknown id or an answer that is not one of the options, naming the file and the id; fix the file from the human's words, never by guessing.
5. **Summary** (a confirm round). `stage: "summary"`, one task, launched the same way. The driver refuses a summary that does not match the record, naming the file and the reason.
6. **Board** (end of the round). First a `pull` of Grooming Decisions into `groom.local/page-<n>.md`; then the rendered page `groom/trace/decisions.md` with the actions to perform (`unmark`, `replace` append-first, and on a confirm `resolve`, `write-idea` and `move`). Perform them in order, fetch the page again into `groom.local/page-<n>.md`, then run `local <ticket> --verify`. Report any `notes` (a page tick the chat answer overrode, a block the page parser could not read).
7. Repeat from step 3 for the next round until the run status is `confirmed` or `stopped`. `--finish` ends the current round as incomplete when the session cannot go on; `--verify --finish` ends the run's local state whatever its status.

The working files are `groom.local/` (knowledge, prompts, answers, fetched pages) and `.local/groomer/`, kept between rounds and removed when a confirmed or stopped run verifies.

## Run telemetry

Every run of this skill on a ticket writes one telemetry file, `.work/<id>-<slug>/telemetry/<run-id>.json` (OpenTelemetry JSON: the run, its rounds and subagents, with timings, tokens, tool calls and cost where they are measured), and attaches it to the end of the ticket page when the Feature Board rules list it (BOARD-003). A telemetry failure is a notice beside the result: it never changes the run's status, the card's move or the exit code.

- **Default.** The launcher does it all: `ticket.ts start` prints `run-id=` and `run-started=`, and the finish step after the agent exits writes the file from them and attaches it. Nothing to do here.
- **`--local`.** The session reports its own usage, since only it sees its subagents:
  1. Record the wall-clock start and end (ISO 8601) of every subagent you launch in the round, with the total tokens, tool uses and duration the Agent tool reports for it, and its model when you know it.
  2. Every pending step on a ticket prints `sessionUsage` with a `file` and a `runId`. Before the call that ends the round (the one that prints the end-of-round `board` stage), write that `file` (`groom/trace/session-usage.json`) as JSON: `{"runId": "<runId>", "subagents": [{"label": "…", "startedAt": "…", "endedAt": "…", "totalTokens": 0, "toolUses": 0, "wallMs": 0, "model": "…"}]}`, one entry per subagent in launch order. `label` is a short name of your own (`research`, `lane A`), never the task's description or prompt text. Leave out a number you do not have; never guess one. Without the file the run's telemetry records the subagents as missing.
  3. The export's `board.actions` then end with two telemetry actions. `read` (`target: "board-rules"`): fetch the Feature Board rules page with the Notion MCP (`notion-fetch`, read-only) and write it to `file` as plain markdown, one rule per line. `attach`: only when one line of the rules you saved contains every string of `onlyIf`, attach `file`, as `name`, in one file block at the end of the ticket page `page`: `notion-create-attachment` for a file of at most 200 KiB, otherwise `notion-create-file-upload`, then `notion-update-page`. Attach no other file, to no other page, and never edit or delete another block.
  4. Pass the result to the verify step: `local <ticket> --verify --attach '{"blockId":"<the new block id>"}'`, or `--attach '{"error":"<why>"}'` when the rules do not allow it or the attach failed. A missing, refused or failed attach is a notice in the verify output, never a failed verify.
- **`--parent-run <run-id>:<nonce>`** (a step of an `/aspira-build-feature` run, which prints it on the step's command). Skip all of the above: the run writes no usage report, reads no rules and attaches nothing; build-feature records the step in its own telemetry. Pass `--parent-run` unchanged on every call of the launcher, `start` or `local`, `--verify` included. A malformed value, or one that does not name the pending step of the build-feature run on the ticket, is refused (exit 3) naming `--parent-run`.
- **`--no-ticket`** runs write no telemetry.

Each round of the groomer is its own run: the round's end writes its file and the next round gets a new run id, so write the report once per round, with the `runId` that round's steps print, and pass `--attach` to that round's `--verify`.

## Reporting

Start the report with the ticket ID and title, the Status before and after, the Grooming Decisions URL and the working folder. The rest of the report follows `agent/instructions.md`. Say which mode produced it.
