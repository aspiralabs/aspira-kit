---
name: aspira-code-analyzer
description: Run every static analyzer a repository uses (ESLint, tsc, Prettier, Biome, Ruff, mypy, gofmt, go vet, cargo clippy, RuboCop and the project's own lint/typecheck scripts), auto-fix, let the official code-analyzer fix the rest, and loop until clean. Works on a whole repository or one app inside it. By default it runs code-analyzer as a separate process; with --local the analyzers still run from the agent's code and this Claude Code session is the fix model. Use for /aspira-code-analyzer or requests to clean up lint and type errors across a repo with this agent.
argument-hint: <repo-path | app-dir | github-url | owner/name> [--local] [--push]
---

# Static analysis

This skill only calls the official `code-analyzer`: do not run the linters or fix diagnostics yourself. The agent's rules (what the fix model may change, what counts as clean, how to report) live in its own files: `agent/instructions.md` in the code-analyzer package is the authority for how a run is reported, and `agent/lib/fixer.ts` holds the fix model's prompt. This file describes only the mechanics.

Both modes use `scripts/code-analyzer.sh` beside this file (use its absolute path). It resolves the package from `CODE_ANALYZER_AGENT_DIR` (kit development only; the report says so), then the installed `@aspiralabs/code-analyzer` under the project's `node_modules`, then its own location. A launcher that resolves to a kit checkout prints one line saying it is running kit source, not the installed version. Every `start`, `status` and `local` output names the agent package and version that ran (`agent:` line, or `agent` in the JSON), and an export records it in `trace/agent-version.json`.

A local path is analyzed as the directory you name. For a repository with several apps and no root `package.json` (for example `apps/web`, `apps/mobile`, `services/infra`), name the app directory, and run once per app. The repository root still works and is analyzed as a whole. Output goes to `<that directory>/.static-analysis/` unless `--output` says otherwise.

| | Default | `--local` |
| --- | --- | --- |
| Analyzers, auto-fix, loop and stop rules | the agent, in a separate process | the agent's code, run by the `local` step |
| Fix model | the agent's workhorse model through the AI Gateway | subagents of this session, given the fixer's prompts |
| Engineering guidelines | required: loaded from Notion by the agent, or `--knowledge` / `--guidelines` | required: fetched by this session with the Notion MCP, or `--knowledge` / `--guidelines` |
| Sources | local path or GitHub repository | local path only |
| Cost | Gateway, in `usage.json` | this session's usage, not itemized |

## Default: run the agent

```bash
<skill-dir>/scripts/code-analyzer.sh start <repo-path | app-dir | github-url | owner/name> [--knowledge DIR | --guidelines FILE] [--push] [--ref BRANCH] [--output /absolute/dir] [--max-rounds N] [--fix-warnings]
```

A local path runs on the host and changes the working tree in place; it needs Node 24, pnpm and the project's toolchain. A GitHub repository is cloned and fixed in the agent's sandbox and its patch lands in the output directory; `--push` asks the agent to push a branch and open a pull request (needs `GITHUB_TOKEN`).

The agent loads the engineering guidelines from Notion with `NOTION_TOKEN` and `KNOWLEDGE_PAGE` from its env. `--knowledge DIR` gives it a guidelines folder instead (`REQUIRED.md`, `INDEX.md`, one file per page, as `load-knowledge` writes it) and `--guidelines FILE` a `REQUIRED.md` snapshot. Without any of them the run refuses and exits non-zero; report that, do not work around it.

The launcher detaches the run and prints its run directory. Tell the user it started and where the report will land. Check on it with `status <run-dir>`, or `wait <run-dir> --max 30` between updates (`watch` is an alias), until it finishes or the user cancels. Do not relaunch a finished run on your own: each `start` is paid. If launch fails, report the error and do not lint by hand.

## `--local`: the session is the fix model

```bash
<skill-dir>/scripts/code-analyzer.sh local <repo-path | app-dir> [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--finish]
```

Each `local` call is one step and makes no model call. Pass the same path and options on every call. It prints JSON:

1. **Knowledge.** The first call prints `stage: "knowledge"` with `refused`, the folder `dir`, the Notion index `page`, the `required` page titles, `maxDepth` and `maxPages`, all read from the agent's own configuration. Fetch them with the Notion MCP and write them into `dir` the way the agent's `load-knowledge` lays them out: `INDEX.md` is the index page; one markdown file per page linked below it, up to `maxDepth` levels and `maxPages` pages; `REQUIRED.md` is the `required` pages in order, each under its own `# <title>` heading. Or pass `--knowledge` with a folder already in that shape, or `--guidelines` with a `REQUIRED.md` snapshot. If `page` is null, ask the user for one of them; do not run without one. The driver refuses every step until the folder is complete, and refuses to continue if it changes mid-run.
2. **Fix stages.** A step prints `stage: "fix"`, `round`, `maxRounds`, `parallel`, `root`, `orchestrator` and `tasks: [{id, prompt, output, files, diagnostics}]`. Before printing it, the driver already ran the auto-fixes and the analyzers. For every task, launch one `general-purpose` subagent with exactly this message, at most `parallel` at a time, all in one message when they fit:

   `Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.`

   When they have all finished, run `local` again. Do not edit the prompts or fix anything outside the tasks: each prompt is the fixer's own prompt from `agent/lib/fixer.ts`, built on that call, and the next step checks every changed file against the agent's edit guards and reverts what they reject.
3. **Repeat** until the step prints `pending: false`. Do not decide yourself whether another round is needed; the driver applies the agent's stop rules and round cap.

A task that comes back with an `error` wrote an output that failed the fixer's schema; the driver has set it aside. Resend it once to a new subagent with the same message plus the error. `retry: false` means it was already resent. Then, or when a subagent cannot finish, run `local ... --finish`: it takes a last analysis and exports, listing the missing tasks in `missing`.

`--no-fix` only detects and analyzes: no dependency install, no auto-fix, no fix stage. Use it for a read-only check; with `--output` outside the repository nothing is written there. The work directory is `<output>/.local/`; it is removed after export, and every prompt and output is kept in `calls.json`. A remote repository is refused: use `start`.

## Results

`report.md`, `diagnostics.json`, `rounds.json`, `usage.json` and `calls.json` in the output directory, plus `guidelines/` (the rules the run was held to) and, for a remote run, `changes.patch`. A local path's output folder is added to that directory's `.gitignore` once, unless `--output` was given to `local`.

Report the run the way the agent's `agent/instructions.md` says (the `orchestrator` path the `local` step prints, read in full; in `--local` the finished step returns its text as `orchestrator.text`). Say which mode produced the run and which directory was analyzed. In `--local`, the fix model was this session, so say so.
