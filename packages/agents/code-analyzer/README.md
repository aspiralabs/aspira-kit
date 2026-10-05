# Static analysis agent

Private eve agent that brings a repository to a clean static-analysis state. Spec: `specs/agents-code-analyzer.md`.

One eve tool, `static-analysis`, owns the loop. Code detects the analyzers from the tree, runs them, applies the tools' own auto-fixes, parses the remaining diagnostics, batches the error-severity ones by file and hands each batch to a workhorse model (`openai/gpt-6.1-sol` by default, no frontier model) with `read_file`, `search`, `edit_file` and `done` tools. Every edit is an exact, unique replacement inside the repository, validated by guards before it is written: no suppression directives, no edits to analyzer configuration, lockfiles, package manifests, CI files or tests, no emptied files. The loop repeats until the analyzers are clean, a round changes nothing, the round cap or cost cap is reached, or the turn is cancelled. The stop reason is always recorded.

## Where the code runs

Two implementations of one `Executor` interface (`agent/lib/executor.ts`):

- **Local path** → host executor. The directory is fixed in place in the caller's checkout with the project's installed toolchain. The developer already runs these tools there, so no sandbox is added; missing tools are reported, never installed. The path is analyzed as named: a directory inside a repository (one app of several, as in a repo with `apps/web`, `apps/mobile` and no root `package.json`) is the project, detected and fixed on its own, with the git root's `AGENTS.md`/`CLAUDE.md` still given to the fixer. The repository root analyzes the whole repository.
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
pnpm analyze /absolute/repository [--knowledge DIR | --guidelines FILE] [--output DIR] [--max-rounds N] [--max-cost USD] [--fix-warnings]   # local only, no eve or Docker
pnpm exec eve invoke "Run static analysis on /absolute/repository"
pnpm exec eve invoke "Run static analysis on owner/name and open a pull request"
```

Exit 0 means `clean`; anything else exits 1. `/aspira-code-analyzer <source> [--push]` (`skill/aspira-code-analyzer/`) launches the same package detached with `start` / `status` / `wait`.

## `--local`

`pnpm run local /absolute/dir [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--finish]` (`agent/lib/local.ts`, through the skill's `local` command) runs the same loop with the calling Claude Code session as the fix model. Each call is one step and makes no model call. Detection, toolchain probe, setup, auto-fix, analysis, batching and the stop rules are the agent's own code, run on the host. Where `runStaticAnalysis` would call its fix model, the step writes one prompt file per batch (`systemPrompt` and `fixPrompt` from `agent/lib/fixer.ts`, imported from the package on that call, plus a short mapping of `read_file`/`search`/`edit_file`/`done` onto Claude Code tools) and returns them as tasks. The session's subagents edit the files and write the `done` result, which is validated against `doneSchema` with one resend. The next step compares the tree with a snapshot, applies the `edit_file` guards (`changeRejection` in `guards.ts`) to every changed file and reverts what they reject, then continues the loop. `--finish` takes a last analysis and exports; `--no-fix` only detects and analyzes. Local paths only: a remote repository is never run on the host.

The engineering guidelines are required in `--local`. The first step refuses and prints a `knowledge` stage: the Notion index page (`KNOWLEDGE_PAGE`) and required pages (`KNOWLEDGE_REQUIRED`, else load-knowledge's default) from this package's env files, and load-knowledge's page limits. The session fetches them into `<output>/.local/knowledge/` in load-knowledge's layout (`REQUIRED.md`, `INDEX.md`, one file per page), or `--knowledge` names such a folder, or `--guidelines` a `REQUIRED.md` snapshot. Every fix prompt gets `knowledgeSection` from `fixer.ts`; a change to the folder mid-run is refused, and the export copies it to `guidelines/`. The default path has the same requirement; see Engineering guidelines.

## Engineering guidelines

Every run is held to the org's engineering guidelines and none runs without them (`agent/lib/knowledge.ts`). In order: `--knowledge DIR` (tool input `knowledge`), a folder in load-knowledge's layout; `--guidelines FILE` (`guidelines`), a `REQUIRED.md` snapshot; else Notion, walked from `KNOWLEDGE_PAGE` with `NOTION_TOKEN` exactly as the shared `load-knowledge` tool walks it (same helpers, depth and page caps, file names, link rewriting and `REQUIRED.md` from `KNOWLEDGE_REQUIRED`), into a host temp folder. The fixer runs on the host for local and remote repositories, so a host folder serves both. Neither available, or a required page missing, is a refusal before anything runs (CLI exit 2). Every fix prompt carries `knowledgeSection` from `fixer.ts`: `REQUIRED.md` inline, the folder's other pages readable through `read_file` by absolute path (and nothing else outside the repository). The export copies the guidelines to `guidelines/` and records them in `rounds.json`.

## Output

Local runs write to `<analyzed dir>/.static-analysis/` (added to that directory's `.gitignore` on first run); remote runs to the supplied `outputDir` or a temp directory.

- `report.md`: status (`clean`, `partial`, `nothing-detected`, `failed`), stop reason, before/after per analyzer, per-round autofix/diagnostics/edits/rejected edits, model cost and tokens per round, wall time (prepare, loop, publish), files edited, rejected edits with reasons, remaining diagnostics, problems.
- `diagnostics.json`: initial and remaining diagnostics. `rounds.json`: per-round record, problems, detection, timing. `usage.json`: every model turn with tokens and provider cost metadata. `calls.json`: every prompt and outcome. `changes.patch` (remote): the commit.

`partial` is not clean: diagnostics remain or an analyzer could not run. Passing static analysis does not prove behavior is unchanged and no tests are run; the diff is for a human to review.

## Environment

Shared `../.env.local` (symlinked): `AI_GATEWAY_API_KEY`, `GITHUB_TOKEN` for private clones and pushes, `NOTION_TOKEN` and `KNOWLEDGE_PAGE` (and optionally `KNOWLEDGE_REQUIRED`) for the guidelines. Package `.env.development.local` or the environment: `STATIC_ANALYSIS_FIX_MODEL`, `STATIC_ANALYSIS_MAX_ROUNDS` (6), `STATIC_ANALYSIS_MAX_COST_USD` (5), `STATIC_ANALYSIS_WARNINGS`, `STATIC_ANALYSIS_COMMAND_TIMEOUT_MS` (600000), `STATIC_ANALYSIS_BATCH_TIMEOUT_MS` (180000), `STATIC_ANALYSIS_CONCURRENCY` (3), `STATIC_ANALYSIS_GIT_NAME` / `STATIC_ANALYSIS_GIT_EMAIL` for remote commits. See `.env.example`.

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm exec eve info
```

Private package: no changeset.
