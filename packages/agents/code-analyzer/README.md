# Static analysis agent

Private eve agent that brings a repository to a clean static-analysis state. Spec: `specs/agents-code-analyzer.md`.

One eve tool, `static-analysis`, owns the loop. Code detects the analyzers from the tree, runs them, applies the tools' own auto-fixes, parses the remaining diagnostics, batches the error-severity ones by file and hands each batch to a workhorse model (`openai/gpt-6.1-sol` by default, no frontier model) with `read_file`, `search`, `edit_file` and `done` tools. Every edit is an exact, unique replacement inside the repository, validated by guards before it is written: no suppression directives, no edits to analyzer configuration, lockfiles, package manifests, CI files or tests, no emptied files. The loop repeats until the analyzers are clean, a round changes nothing, the round cap or cost cap is reached, or the turn is cancelled. The stop reason is always recorded.

## Where the code runs

Two implementations of one `Executor` interface (`agent/lib/executor.ts`):

- **Local path** → host executor. The repository is fixed in place in the caller's checkout with the project's installed toolchain. The developer already runs these tools there, so no sandbox is added; missing tools are reported, never installed.
- **GitHub URL, `git@` URL or `owner/name`** → sandbox executor. The repository is cloned into the eve sandbox (Docker locally, Vercel Sandbox when deployed), missing toolchains are installed there, and the fixes are committed on a `static-analysis/<timestamp>` branch. The patch is written to the output directory; `push: true` also pushes the branch and opens a pull request (`GITHUB_TOKEN`). Fetched code never executes on the host.

The model never has a shell in either mode. Commands come from the detection table in `agent/lib/analyzers.ts`.

## Detection

| Ecosystem | Trigger | Analyzers (check → fix) |
| --- | --- | --- |
| JavaScript/TypeScript | `package.json` | root `lint` / `typecheck` / `format:check` scripts when present (their eslint `--fix` still runs per config dir); otherwise ESLint per config directory (`--format json` → `--fix`), `tsc --noEmit` per `tsconfig.json` (`-b` for solution files), Prettier when configured (`--check` → `--write`), Biome (`check --reporter=github` → `--write`). Package manager from the lockfile. |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `ruff.toml` | Ruff always (`check --output-format json` → `--fix`); `ruff format`, black, mypy, pyright, flake8 when configured. |
| Go | `go.mod` | `gofmt -l` → `gofmt -w`, `go vet ./...`, golangci-lint when configured. |
| Rust | `Cargo.toml` | `cargo fmt --check` → `cargo fmt`, `cargo clippy -D warnings`. |
| Ruby | `Gemfile` + RuboCop | `rubocop --format json` → `rubocop -a`. |

Warnings are reported, not fixed, unless `STATIC_ANALYSIS_WARNINGS=fix` or `fixWarnings: true`.

## Run

```bash
cd packages/agents/code-analyzer
pnpm analyze /absolute/repository [--output DIR] [--max-rounds N] [--max-cost USD] [--fix-warnings]   # local only, no eve or Docker
pnpm exec eve invoke "Run static analysis on /absolute/repository"
pnpm exec eve invoke "Run static analysis on owner/name and open a pull request"
```

Exit 0 means `clean`; anything else exits 1. `/aspira-code-analyzer <source> [--push]` (`skill/aspira-code-analyzer/`) launches the same package detached with `start` / `status` / `wait`.

## Output

Local runs write to `<repo>/.static-analysis/` (added to the repo's `.gitignore` on first run); remote runs to the supplied `outputDir` or a temp directory.

- `report.md`: status (`clean`, `partial`, `nothing-detected`, `failed`), stop reason, before/after per analyzer, per-round autofix/diagnostics/edits/rejected edits, model cost and tokens per round, wall time (prepare, loop, publish), files edited, rejected edits with reasons, remaining diagnostics, problems.
- `diagnostics.json`: initial and remaining diagnostics. `rounds.json`: per-round record, problems, detection, timing. `usage.json`: every model turn with tokens and provider cost metadata. `calls.json`: every prompt and outcome. `changes.patch` (remote): the commit.

`partial` is not clean: diagnostics remain or an analyzer could not run. Passing static analysis does not prove behavior is unchanged and no tests are run; the diff is for a human to review.

## Environment

Shared `../.env.local` (symlinked): `AI_GATEWAY_API_KEY`, `GITHUB_TOKEN` for private clones and pushes. Package `.env.development.local` or the environment: `STATIC_ANALYSIS_FIX_MODEL`, `STATIC_ANALYSIS_MAX_ROUNDS` (6), `STATIC_ANALYSIS_MAX_COST_USD` (5), `STATIC_ANALYSIS_WARNINGS`, `STATIC_ANALYSIS_COMMAND_TIMEOUT_MS` (600000), `STATIC_ANALYSIS_BATCH_TIMEOUT_MS` (180000), `STATIC_ANALYSIS_CONCURRENCY` (3), `STATIC_ANALYSIS_GIT_NAME` / `STATIC_ANALYSIS_GIT_EMAIL` for remote commits. See `.env.example`.

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm exec eve info
```

Private package: no changeset.
