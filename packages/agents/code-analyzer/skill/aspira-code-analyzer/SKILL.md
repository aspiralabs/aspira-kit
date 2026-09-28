---
name: aspira-code-analyzer
description: Run every static analyzer a repository uses (ESLint, tsc, Prettier, Biome, Ruff, mypy, gofmt, go vet, cargo clippy, RuboCop and the project's own lint/typecheck scripts), auto-fix, let the official code-analyzer fix the rest, and loop until clean. Use for /aspira-code-analyzer or requests to clean up lint and type errors across a repo with this agent.
argument-hint: <repo-path | github-url | owner/name> [--push]
---

# Static analysis

Call the official `code-analyzer`; do not run the linters or fix diagnostics yourself. It detects the analyzers from the tree, runs them, applies their auto-fixes, hands the remaining error-severity diagnostics to a workhorse model with read/search/exact-edit tools, and repeats until the analyzers are clean, a round changes nothing, or the round/cost cap is hit. It never adds suppressions or edits analyzer configuration.

Use the absolute path to `scripts/code-analyzer.sh` beside this file.

```bash
<skill-dir>/scripts/code-analyzer.sh start <repo-path | github-url | owner/name> [--push] [--ref BRANCH] [--output /absolute/dir] [--max-rounds N] [--fix-warnings]
```

A local path runs the direct CLI on the host and fixes the working tree in place; it needs Node 24, pnpm and the project's toolchain installed. A GitHub repository runs through the eve entry point: it is cloned into the Docker sandbox, fixed there, and committed on a `static-analysis/<timestamp>` branch; the patch lands in the output directory. `--push` additionally pushes that branch and opens a pull request (needs `GITHUB_TOKEN`). The launcher resolves the package via `CODE_ANALYZER_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/code-analyzer`, then its own location.

The launcher detaches the run and prints its run directory. Tell the user it started and where the report will land. Use `status <run-dir>` to check progress, or `wait <run-dir> --max 30` between updates; `watch` is a bounded alias for `wait`. Keep checking until it finishes or the user cancels. Do not retry a finished run on your own: each run is paid.

Results:

- `report.md`: status (`clean`, `partial`, `nothing-detected`, `failed`), stop reason, before/after per analyzer, per-round edits and rejected edits, model cost and wall time, remaining diagnostics.
- `diagnostics.json`, `rounds.json`, `usage.json`, `calls.json`: remaining diagnostics, the per-round record with problems, every model turn, every prompt and result.
- `changes.patch` (remote only): the commit as a patch.

For a local run the output is `<repo>/.static-analysis/`, added to the repo's `.gitignore` on the first run, and the fixes are uncommitted changes in the working tree. Read the report, summarize what was fixed and what remains, list the files the model edited, and tell the user to review the diff: passing static analysis does not prove behavior is unchanged, and no tests were run. `partial` is not clean; say which analyzers still fail or could not run.
