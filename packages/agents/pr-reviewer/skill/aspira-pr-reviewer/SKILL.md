---
name: aspira-pr-reviewer
description: Review a pull request (a GitHub PR or a local branch) with the official pr-reviewer pipeline, where six specialist seats (security, performance, architecture, testing, developer experience, design system) argue and Quinn verifies every finding until the fix list settles. Then report the computed verdict and post the review to the GitHub PR. By default it runs pr-reviewer as a separate process; with --local the same pipeline runs inside this Claude Code session. Use for /aspira-pr-reviewer or requests to review a PR or branch with this agent.
argument-hint: <github-pr | repo-path> [--branch B] [--base main] [--local] [--max-rounds N] [--no-comment]
---

# PR review

Six seats review the diff in parallel, each through one lens, then Quinn rules on every finding. Each later round the seats read each other and Quinn's rulings and accept, withdraw or dispute. The loop stops when all seven agree or at the round cap (default 4, at most 10). Nova then writes the fix list, Dex writes the summary, Quinn signs off the fix list and Nova checks the summary. The verdict (`block`, `comment`, `approve`) is computed from the counts. No model chooses it.

The source is a GitHub PR (`https://github.com/owner/name/pull/123` or `owner/name#123`) or a local repository path. For a local repository, `--branch` names the branch to review (default: the checked-out one, whose uncommitted and never-added files count) and `--base` what it is compared against (default `main`). A GitHub PR already says what it is against, so do not pass `--branch` or `--base` with one. Both modes use `scripts/pr-reviewer.sh` beside this file (use its absolute path). They export the same files.

| | Default | `--local` |
| --- | --- | --- |
| Where the model work runs | `pr-reviewer`, a separate eve process | subagents of this Claude Code session |
| Models | six seats on Opus 5.5, Quinn on OpenAI gpt-6-luna | this session's model, for every seat and Quinn |
| Independence | Quinn is a second vendor, and no seat has session context | fresh subagent contexts, same vendor and session |
| Cost | Vercel AI Gateway, itemized in `cost.md` | this session's usage, not itemized |
| Guidelines | loaded from Notion by `load-knowledge` | not loaded; the seats review on the merits |
| Needs | Node 24, pnpm, screen, the agent's `.env.local` | Node 24, pnpm, git; `GITHUB_TOKEN` or `gh` for a GitHub PR |

Use the default when the review should be independent of the person or session that wrote the code. Use `--local` to stay in this session and keep the Gateway bill at zero.

## Default: run the agent

Call the official `pr-reviewer` and do not review the PR yourself.

```bash
<skill-dir>/scripts/pr-reviewer.sh start <github-pr | repo-path> [--branch B] [--base main] [--max-rounds N] [--no-comment]
```

The launcher resolves the package from `PR_REVIEWER_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/pr-reviewer`, then its own location. It detaches the review in `screen` and prints its run directory. Tell the user it started. Check on it with `status <run-dir>`, or with `wait <run-dir> --max 30` between updates. The wait returns control without stopping the agent, so keep checking until it finishes or the user cancels. Do not automatically retry failed or incomplete reviews: every run is paid. If launch fails, report the error and do not review by hand. When it finishes, the log holds the agent's reply: the verdict, the cost, the comment URL and `review.md`.

## `--local`: run the pipeline in this session

Each call to the `local` step makes no model calls. It either prints the next stage as JSON, with each task's exact agent prompt written to a file, or, once every stage is done, exports the review and posts it. You run the tasks as subagents in between. Do not review the PR yourself and do not edit the prompts: the value is that each task gets exactly what the agent's seat gets, which is the seat's system prompt and the prompt from `agent/lib/review.ts`, with the sandbox paths mapped to a local work directory.

```bash
<skill-dir>/scripts/pr-reviewer.sh local <github-pr | repo-path> [--branch B] [--base main] [--max-rounds N] [--no-comment] [--output DIR] [--finish]
```

Pass the same source and options to every call. A step prints `{stage, round, maxRounds, workDir, tasks: [{id, agent, prompt, output, schema}]}`. For every task, launch one `general-purpose` subagent with exactly this message, with the task's paths filled in:

`Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`

1. **Seats.** Run `local`. It prints `stage: "seats"`, `round: 1` and six tasks. Launch all six seat tasks **in one message**, as six parallel subagents. Wait for all six.
2. **Quinn.** Run `local` again. It prints `stage: "verifier"` and one task, Quinn's ruling on the round. Launch one subagent.
3. **Repeat** steps 1 and 2: run `local` and run what it prints, until the driver says the rounds are done by printing `stage: "documents"`. Do not decide yourself whether the seats agree or whether another round is needed. The driver applies pr-debator's rule (all six seats and Quinn agreed, or the round cap).
4. **Documents.** `stage: "documents"` has two tasks, Nova's fix list and Dex's summary. Launch both in one message.
5. **Checks.** Run `local` again. `stage: "checks"` has two tasks, Quinn's sign-off of the fix list and Nova's check of the summary. Launch both in one message.
6. **Export.** Run `local` a last time. It writes the review and, for a GitHub PR, posts it. It prints `status`, `verdict`, `counts`, `agreed`, `rounds`, `openPoints`, `dir`, `written` and `comment`.

A task that comes back with an `error` wrote an output that failed its schema, and the driver has set that output aside. When that happens, send the error back and resend it once: the same message plus the error, to a new subagent. `retry: false` means that turn has already been resent once. Then, or when a subagent cannot finish, run `local ... --finish`. That exports what exists, with the missing turns listed in `missing`, the status `incomplete` and no verdict when there is no fix list. The work directory, `<output>.local/`, holds the prompts and outputs between steps. It is removed after export, and every prompt and output is kept in `trace/calls.json`. If the branch, the working tree or the PR head changes mid-review, `local` refuses to continue. Delete the work directory to start again.

For a GitHub PR, the driver reads the PR and its diff from the GitHub API and makes a depth-1 clone of the PR head in the work directory for the seats to read. It uses `GITHUB_TOKEN` or, without it, `gh auth token`. It posts the review as one comment, or updates the one it posted before, unless `--no-comment` is given. It posts only to the PR it reviewed, never to any other PR. Without a token it reports `posted: false` and the reason. An incomplete review is never posted.

`--local` is not independent of this session: every seat and Quinn run on this session's model, so Quinn is not a second model family and the seats share a vendor with whoever wrote the code in this session. Say so when you report a `--local` review.

## Results

A local repository's review goes to `<repo>/.pr-review/<branch>/`, and `.pr-review/` is added to that repo's `.gitignore` once. A GitHub PR's review goes to `reviews/<date>-<branch>/` in the pr-reviewer package. `--output` overrides both and leaves `.gitignore` alone.

- `review.md`: the summary for the PR author.
- `findings.md`: the fix list, by severity, with Quinn's ruling on each.
- `conversation.md`: every seat's file, every round.
- `pr.md`, `pr.patch`, `changed_files.txt`: what was reviewed.
- `cost.md`: the agent's itemized cost, or, for `--local`, that it ran in this session with no itemized cost.
- `trace/calls.json` (`--local` only): every prompt and output.

Report the verdict, the counts by severity, whether the seats agreed and in how many rounds out of the cap, the open points when they did not agree, the comment URL (or that it was not posted and why), the directory, and `review.md` in full. The verdict is computed from the counts. Do not argue with it or soften it. `incomplete` is not approval. If a run fails before exporting, show its error and do not present an earlier review as the new result. Say which mode produced the review.
