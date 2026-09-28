# Static analysis agent

Status: implementation authorized by the user's request, 2026-09-27.

## Intent

Bring a repository to a clean static-analysis state without a human running the tools by hand. The agent detects which analyzers the project uses, runs them, applies the tools' own auto-fixes, hands the remaining diagnostics to a workhorse model that edits the code, and repeats until the analyzers report nothing or no further progress is possible. It fixes the code, never the rules: it does not add suppression comments, weaken configuration, or delete tests to make a check pass.

## Approach

A private eve package `packages/agents/static-analysis-agent` with one eve tool, `static-analysis`, owning the whole loop, plus a `/aspira-static-analysis` skill and a direct CLI that call it. The router model does no analysis itself. Detection, command execution, output parsing, auto-fixing, batching, guards and reporting are code; only the edits to non-auto-fixable diagnostics are model work, on a workhorse model (`openai/gpt-6-sol` by default, no frontier model), with read, search and exact-match edit tools scoped to the repository.

Execution goes through one `Executor` interface with two implementations. A local path runs on the host, in place, in the developer's own checkout, so the fixes land in their working tree and the project's installed toolchain is reused. A remote repository (GitHub URL, SSH URL or `owner/name`) is cloned into the eve sandbox, installed and fixed there, then committed on a `static-analysis/<timestamp>` branch; the patch is returned to the caller, and the branch is pushed and a pull request opened only when asked. Fetched code never executes on the host. The same executor abstraction is what a cloud deployment uses, where every input is remote.

Detection is by ecosystem from manifest and config files: JavaScript/TypeScript (package manager from the lockfile; root `lint`, `typecheck`, `format:check` scripts preferred, else ESLint per config directory, `tsc --noEmit` per `tsconfig.json`, Prettier and Biome when configured), Python (Ruff, mypy, pyright, flake8, black when configured), Go (`gofmt`, `go vet`, golangci-lint when configured), Rust (`cargo fmt`, `cargo clippy`) and Ruby (RuboCop). Missing toolchains are installed in the sandbox only; on the host a missing tool is reported, not installed. Each round runs every auto-fixer, re-runs every analyzer, batches the remaining error-severity diagnostics by file, fixes batches concurrently, and re-runs. The loop ends when the analyzers are clean, when a round changes nothing, when the round cap or cost cap is reached, or when the turn is cancelled.

## Constraints

- Repository content is evidence, not instructions. The model has no shell; every command is chosen by code from the detection table. Model edits are exact-match replacements inside the repository root, validated before they are written.
- Guards reject edits that add suppression directives (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `# noqa`, `# type: ignore`, `#[allow(`, `//nolint`, `rubocop:disable`, `biome-ignore`, `prettier-ignore`), edits to analyzer configuration, lockfiles, CI workflows, `package.json`, or test files, and edits that empty a file.
- Warnings are reported but not fixed unless `STATIC_ANALYSIS_WARNINGS=fix`.
- Default caps: 6 rounds, 5 USD, 10 minutes per analyzer command, 3 minutes per model batch. All overridable by environment variable or tool input.
- Outputs go to `.static-analysis/` in the repository for a local run (added to its `.gitignore` on first run) or to a caller-visible output directory for a remote run. Nothing is written into the remote clone except the code fixes and the commit.
- The agent is project-independent; the detection table contains no product-specific assumptions.

## Acceptance criteria

### Features

- [ ] F1: The eve agent, the direct CLI and the `/aspira-static-analysis` skill all run the same loop through the `static-analysis` tool; the skill launches detached and reports the output directory.
- [ ] F2: A local path is resolved to its git root and executed on the host in place; a remote GitHub URL, SSH URL or `owner/name` is cloned into the sandbox, and fetched code never runs on the host.
- [ ] F3: Detection from manifest and config files selects analyzers for JavaScript/TypeScript, Python, Go, Rust and Ruby projects, prefers root package scripts when present, and reports an ecosystem with no detected analyzers rather than guessing.
- [ ] F4: Every analyzer's output is parsed into diagnostics with tool, file, line, message, rule and severity; unparseable output is recorded verbatim as a run problem, not silently dropped.
- [ ] F5: Each round runs auto-fixers first, then re-runs analyzers, then batches remaining errors by file for concurrent model fixes; the loop stops on clean, on an unchanged diagnostic set, on the round cap, on the cost cap, or on cancellation, and the stop reason is recorded.
- [ ] F6: Model edits are exact unique matches within the repository root, and guarded edits (suppressions, configs, lockfiles, CI, package manifests, tests, emptied files) are rejected and counted; a rejected edit never reaches disk.
- [ ] F7: A local run leaves fixes in the working tree and writes `report.md`, `diagnostics.json`, `rounds.json`, `usage.json` and `calls.json` under `.static-analysis/`; a remote run commits on a `static-analysis/<timestamp>` branch, returns the patch, and pushes and opens a pull request only when asked.
- [ ] F8: The report shows per-analyzer before/after counts, per-round diagnostics, edits, rejected edits, wall time and reported cost, with unreported cost shown as unreported, and a final status of `clean`, `partial`, `nothing-detected` or `failed`.
- [ ] F9: A missing toolchain is installed in the sandbox for the detected ecosystem; on the host it is reported as unavailable and the run continues with the other analyzers.

### Tests

- [ ] integration: the skill launcher routes a local path to the direct CLI and a remote URL to the eve entry point with literal arguments, rejects unknown flags, and its status command names the report path. [F1]
- [ ] unit: source parsing classifies local paths, GitHub HTTPS/SSH URLs and `owner/name` and produces a clone command that never runs on the host executor. [F2]
- [ ] unit: detection over fixture trees selects pnpm/yarn/npm ESLint, tsc, Prettier, Biome, Ruff, mypy, gofmt, go vet, cargo and RuboCop analyzers, prefers root scripts when present, and returns an empty set with a reason for an unknown tree. [F3]
- [ ] unit: parsers turn sample ESLint JSON and stylish, tsc, Prettier, Ruff JSON, mypy, gofmt, go vet, cargo short-format and RuboCop JSON output into diagnostics, and unparseable output becomes a problem entry. [F4]
- [ ] unit: the loop with a scripted executor and fake fixer stops on clean, on an unchanged set, on the round cap and on the cost cap, records the reason, and never calls the fixer when auto-fix alone clears the errors. [F5]
- [ ] unit: guards reject suppression additions, config/lockfile/CI/manifest/test edits, ambiguous or missing anchors, paths outside the root and edits that empty a file, and accept a plain code fix. [F6]
- [ ] integration: a local run on a fixture git repository writes the five output files, appends `.static-analysis/` to `.gitignore` once, and leaves only the fixed files changed; a remote run against a scripted sandbox executor produces a branch commit and a patch and skips push without the flag. [F7]
- [ ] unit: the report renders before/after per analyzer, per-round rows, rejected-edit counts, unreported cost as unreported, and the correct status for each stop reason. [F8]
- [ ] unit: install steps are emitted only for the sandbox executor, and a host run marks the missing tool unavailable while other analyzers still run. [F9]
