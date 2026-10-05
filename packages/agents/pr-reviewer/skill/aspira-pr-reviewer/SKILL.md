---
name: aspira-pr-reviewer
description: Run the official pr-reviewer agent on a pull request (a GitHub PR or a local branch) and report its result. By default it launches pr-reviewer as a separate process; with --local the same agent pipeline runs inside this Claude Code session, using the agent's own instruction files. Use for /aspira-pr-reviewer or requests to review a PR or branch with this agent.
argument-hint: <github-pr | repo-path> [--branch B] [--base main] [--local] [--max-rounds N] [--no-comment]
---

# PR review

This skill only runs the official pr-reviewer agent. What the review does, its rules and how its result is reported are defined by the agent, in the pr-reviewer package:

- `agent/instructions.md`: the orchestrator, the authority for the rules and the report.
- `agent/subagents/<seat>/instructions.md`: each seat and Quinn.
- `agent/lib/review.ts`: the prompts, the output schemas and the verdict.
- `agent/tools/load-knowledge.ts` and the agent's env (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`): which Notion engineering guidelines it loads.

This file covers only how to run the agent, and the agent's files win wherever the two seem to differ. The package README describes the pipeline.

The source is a GitHub PR (`https://github.com/owner/name/pull/123` or `owner/name#123`) or a local repository path. For a local repository, `--branch` names the branch (default: the checked-out one) and `--base` the base (default `main`). A GitHub PR names its own base, so neither flag applies to it. Both modes use `scripts/pr-reviewer.sh` beside this file (use its absolute path) and export the same files.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `pr-reviewer`, a separate eve process | subagents of this Claude Code session |
| Models | as configured in the agent's `agent.ts` files | this session's model, for every seat and Quinn |
| Instructions | the agent's files | the same files, read from disk on every `local` call |
| Guidelines | `load-knowledge` fetches them from Notion | this session fetches the same pages with the Notion MCP |
| Cost | Vercel AI Gateway, itemized in `cost.md` | this session's usage, not itemized |
| Needs | Node 24, pnpm, screen, the agent's `.env.local` | Node 24, pnpm, git, the Notion MCP; `GITHUB_TOKEN` or `gh` for a GitHub PR |

The launcher resolves the package from `PR_REVIEWER_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/pr-reviewer`, then its own location. That package's files are the ones that run.

## Default: launch the agent

```bash
<skill-dir>/scripts/pr-reviewer.sh start <github-pr | repo-path> [--branch B] [--base main] [--max-rounds N] [--no-comment]
```

It detaches the agent in `screen` and prints a run directory. Tell the user it started. Check it with `status <run-dir>`, or with `wait <run-dir> --max 30` between updates. The wait returns without stopping the agent, so keep checking until it finishes or the user cancels. Do not automatically retry failed or incomplete reviews: every run is paid. If the launch fails, report the error. When the run finishes, the log holds the agent's reply; relay it.

## `--local`: run the agent's pipeline in this session

`local` replays the agent's pipeline with this session as the model. It makes no model calls itself. It stands in for the agent's tools: it loads the PR, checks the guidelines, runs the round loop, exports and comments. It prints the next stage, with each turn's prompt assembled at that moment from the agent's own files, and you run those turns as subagents. You are the orchestrator here: read the file named in `orchestrator` in full before the first stage. It is the authority for what you do and how you report. Run the turns as listed and do not edit the prompt files.

```bash
<skill-dir>/scripts/pr-reviewer.sh local <github-pr | repo-path> [--branch B] [--base main] [--max-rounds N] [--no-comment] [--output DIR] [--knowledge DIR] [--finish]
```

Pass the same source and options to every call.

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
2. **Seats.** Once the guidelines are in place, `local` prints `stage: "seats"`, `round: 1` and six tasks. For each task, launch one `general-purpose` subagent with exactly this message, with the task's paths filled in:

   `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`

   Launch all six seat tasks **in one message**, as six parallel subagents, and wait for all six.
3. **Quinn.** Run `local` again. It prints `stage: "verifier"` and one task. Launch one subagent the same way.
4. **Repeat** steps 2 and 3 until the driver says the rounds are done by printing `stage: "documents"`. Whether another round runs is the driver's decision, not yours.
5. **Documents**, then **checks.** Each of these stages has two tasks; launch both in one message. Run `local` between them.
6. **Export.** Run `local` a last time. It writes the review, posts the comment when the agent would, and prints the result. That result includes `orchestrator.text`, the agent's instructions as they are now. Report the review as those instructions say, and add that it ran with `--local`.

A task that comes back with an `error` wrote an output that failed its schema, and the driver has set that output aside. When that happens, send the error back and resend it once: the same message plus the error, to a new subagent. `retry: false` means that turn has already been resent once. After that, or when a subagent cannot finish, run `local ... --finish`. It exports what exists, with the missing turns listed in `missing` and the status `incomplete`, and an `incomplete` export is not a finished review.

The work directory, `<output>.local/`, holds the prompts and outputs between steps and, by default, the guidelines folder. It is removed after export. Every prompt and output is kept in `trace/calls.json` and the guidelines in `trace/guidelines/`. If the branch, the working tree, the PR head or the guidelines change mid-review, `local` refuses to continue; delete the work directory to start again.

`--local` is not independent of this session: every seat and Quinn run on this session's model. Say so when you report a `--local` review.

## Results

A local repository's review goes to `<repo>/.pr-review/<branch>/`. A GitHub PR's review goes to `reviews/<date>-<branch>/` in the pr-reviewer package. `--output` overrides both. Both modes write the agent's files there: `review.md`, `findings.md`, `conversation.md`, `pr.md`, `pr.patch`, `changed_files.txt` and `cost.md`. `--local` adds `trace/`. If a run fails before exporting, show its error rather than an earlier review.
