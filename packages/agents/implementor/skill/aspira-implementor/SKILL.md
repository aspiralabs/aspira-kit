---
name: aspira-implementor
description: Implement a feature test-first under the Aspira engineering rules in Notion, from a planner plan, a spec or a ticket, with the official implementor agent. By default it launches the implementor agent on the GitHub repository and reports back; with --local the agent's own procedure runs inside this Claude Code session on the local checkout, with subagents for the parallel lanes. Use for /aspira-implementor or requests to implement, build or execute a plan, spec or ticket.
argument-hint: <plan.review | plan.reviewed.md | spec.md | ticket> [--local] [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr] [--max-parallel N] [--serial] [--guidelines FILE]
---

# Aspira implementor

This skill calls the `implementor` agent. It does not carry the agent's rules. The authority is the agent's own files in `packages/agents/implementor/`:

- `agent/skills/aspira-implementor/SKILL.md`: the procedure (eve loads it with `load_skill`; `--local` embeds it in every prompt).
- `agent/instructions.md`: the agent's system prompt, which covers the cloud run.

Do not build from memory of either file and do not summarize them into a prompt. The driver hands each task the current text of both files.

Both modes use `scripts/implementor.sh` beside this file (use its absolute path). A leading `@` on the source is dropped.

| | Default | `--local` |
| --- | --- | --- |
| Where the work runs | the `implementor` eve agent, a separate process | this session as orchestrator, subagents as lane workers |
| Repository | a GitHub repository, cloned by the agent; it pushes an `implement/` branch | the local checkout; nothing is pushed |
| Notion rules | `load-knowledge` | the `knowledge` stage: you fetch the listed pages with the Notion MCP, or pass `--guidelines` |
| Tickets | not supported unless the request carries the ticket text | fetch it, restate it as a spec, then build that spec |
| Needs | Node 24, pnpm, screen, the agent's `.env.local` | Node 24, pnpm, git, the Notion MCP (or `--guidelines`) |

Use the default for unattended builds on GitHub. Use `--local` for a local checkout, a ticket, or to keep the build in this session.

## Default: launch the agent

```bash
<skill-dir>/scripts/implementor.sh start <path-in-repo> [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr]
```

With `--repo owner/name` (or a GitHub URL), the source is a path inside that repository. Without it, the launcher uses the repository of the current directory: it reads `owner/name` from the `origin` remote and starts from the current branch. It refuses a source that is not committed and pushed, since the agent can only see what is on GitHub. `--pr` asks the agent for a draft pull request.

The launcher resolves the agent from `IMPLEMENTOR_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/implementor`, then its own location. It detaches the run in `screen` and prints a run directory. Tell the user it started. Check on it with `status <run-dir>`, or `wait <run-dir> --max 30` between updates, until it finishes or the user cancels; waiting does not stop the agent. Do not retry a failed run automatically, because every run costs model time. If the launch fails, show the error and do not build by hand. When it finishes, relay the agent's report from the log.

## `--local`: run the agent's procedure in this session

```bash
<skill-dir>/scripts/implementor.sh local <plan.review | plan.reviewed.md | spec.md> [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--finish]
```

Each `local` call makes no model call. It prints one JSON stage, and you do what it lists, then call `local` again with the same source and options. Repeat until it prints `"pending": false`.

For a ticket, fetch it with whatever tracker tool the session has, restate it as the procedure says for ticket input, write it to `<repo>/.implement/<key>/spec.md`, and pass that path.

1. **`knowledge`** (always first; nothing else runs without it). The stage lists `pages` from the agent's own knowledge configuration (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`): the index page, the required pages, and, once those are in, the topic pages they route to. Fetch every page with `present: false` using the Notion MCP (by `url`, or by `title` when there is no URL). Write each to `knowledgeDir`, at `file` when given, else `<title in kebab case>.md`. Start each file with the `pageHeader` line filled in, followed by the page content exactly as fetched. Then run `local` again; it may list more pages. When all are present, the driver writes `REQUIRED.md` the way `load-knowledge` does. If a page cannot be fetched, stop and say so. With `--guidelines FILE` (a `REQUIRED.md` snapshot), this stage is skipped and the run records that live Notion was not read.
2. **Model stages.** Each lists `tasks: [{id, agent, prompt, output, schema}]`.
   - `agent: "orchestrator"`: do it yourself, in this session. Read `prompt` in full and follow it. It contains the agent's procedure and instructions and says which of their sections apply to this stage. Write the JSON result to `output`.
   - `agent: "worker"`: launch one `general-purpose` subagent per task, all of a stage's worker tasks in one message, with exactly this message: `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`
   - The stages come in this order: `plan` (spec or ticket input only), `parallelize`, then for each wave `wave` (its worker lanes, at most `--max-parallel` at a time) and `wave-commit` (yours), then `verification`. A reviewed plan is gated by the driver first; `refused` or `blocked` ends the run with the reason.
3. **Errors.** A task with an `error` wrote an output that failed its schema or the driver's checks, and the driver set it aside. Fix it once (for a worker, resend the same message plus the error to a new subagent). `retry: false` means it has already been resent. Then, or when a task cannot finish, run `local ... --finish`, which exports what exists as `incomplete` with the missing stages listed.

The run directory `<work dir>/implementation.local/` holds the knowledge, prompts, outputs and state between steps. If the source or the knowledge folder changes mid-run, `local` refuses to continue; delete the run directory to start again. On export the driver writes `<work dir>/trace/implementation-local.json` (every prompt and output, the gate, and the Notion pages used with their hashes) and removes the run directory.

`--local` runs on this session's model, so the workers are not independent of the session that may have written the spec. Say so in the report.

## Report

Relay the agent's report (default) or the final `verification` result and `implementation.md` (`--local`): status, branch, commits, the feature table, deviations with rule IDs, assumptions, blockers, the pull request link if any, and which mode produced it. The next steps are `/aspira-code-analyzer`, then `/aspira-pr-reviewer`. A refused, blocked or incomplete run is not a finished build; say what stopped it.
