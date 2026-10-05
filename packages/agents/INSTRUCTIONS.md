# Running the agents

Copy-paste commands for every agent in this directory. All of them assume the `agent` shell function from `README.md` is in your `~/.zshrc`:

```bash
export ASPIRA_KIT="$HOME/path/to/ASPIRA_KIT"

agent() {
  if [ $# -lt 2 ]; then
    echo "usage: agent <name> <prompt>" >&2
    ls -1 "$ASPIRA_KIT/packages/agents" | grep -v '\.md$' | sed 's/^/  /' >&2
    return 2
  fi
  local name=$1; shift
  local dir="$ASPIRA_KIT/packages/agents/$name"
  [ -d "$dir" ] || { echo "agent: no such agent '$name'" >&2; return 1; }
  pnpm -C "$dir" exec eve invoke "$@"
}

agent-dev() { pnpm -C "$ASPIRA_KIT/packages/agents/${1:?usage: agent-dev <name>}" dev; }
```

Without the function, replace `agent <name>` with `pnpm -C $ASPIRA_KIT/packages/agents/<name> exec eve invoke`.

Two rules that apply to every command below:

- **Run them from inside the repo you want reviewed**, so `$PWD` is that repo.
- **Always pass absolute paths.** Relative paths resolve against the agent's package directory, not your shell.

Every agent needs Node 24 and a Vercel AI Gateway key in the shared `.env.local`. The PR reviewer and Notion snapshot loader use Docker; direct spec review with an existing guidelines snapshot does not.

Every agent below also has a skill: `/aspira-<agent>` launches the agent as a separate process, and `/aspira-<agent> --local` runs the same pipeline inside your Claude Code session, with no model call made from the script. Both paths load the Notion engineering rules. The skill carries no rules of its own; the agent's files are the authority. Install the skills and read the pattern under **Skills** in `README.md`.

## spec-writer

Turns an idea (a file, a Notion card or inline text) into a spec: it explores the repository, drafts the spec, then runs the official spec review on the draft.

```bash
agent spec-writer "Write a spec from $PWD/ideas/checkout.md for $PWD"
```

**Skill:** `/aspira-spec-writer <idea.md | Notion URL | "idea text"> [--guidelines FILE] [--repo DIR] [--output DIR]` launches this agent. Add `--local` to run the same pipeline in your Claude Code session from the agent's own files; the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `spec-writer/skill/aspira-spec-writer/`; see **Skills** in `README.md`. Also see `spec-writer/README.md` for outputs and models.

## spec-reviewer

The official reviewer runs frontier research, six concurrent specialist reviews and one reconciliation. It requires a local Git repository and engineering guidelines. The original spec remains unchanged.

```bash
agent spec-reviewer "Review $PWD/specs/feature/spec.md against $PWD; required guidelines snapshot: /absolute/REQUIRED.md"

# Without a snapshot, the eve entry point loads the required guidelines from Notion.
agent spec-reviewer "Review $PWD/specs/feature/spec.md against $PWD"

# Direct CLI with a snapshot, without Docker or the eve router:
pnpm -C "$ASPIRA_KIT/packages/agents/spec-reviewer" review \
  "$PWD/specs/feature/spec.md" "$PWD" /absolute/REQUIRED.md
```

Results are written beside the source in `spec.reviewed/`. Only `spec.original.md`, `spec.reviewed.md` (when edits are valid), and `run-analysis.md` are at the top level, plus the `trace/` directory. Run analysis shows cost and wall time per agent/turn and totals. All findings, decisions, checks, prompts, outputs and tool records are in `trace/`. Prior results move to `spec.reviewed/trace/history/run-*/` on rerun. An incomplete review is not approval; consult `trace/checks.md` and `trace/decisions.md`.

**Skill:** `/aspira-spec-reviewer <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo DIR] [--output DIR]` launches this agent. Add `--local` to run the same pipeline in your Claude Code session from the agent's own files; the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `spec-reviewer/skill/aspira-spec-reviewer/`; see **Skills** in `README.md`. A `--local` review lands in the same `spec.reviewed/` layout, with no itemized cost, and is not independent of the session. See `spec-reviewer/README.md` for MCP setup and model overrides.

## planner

**Skill:** `/aspira-planner /absolute/path/to/spec.reviewed.md [--guidelines /absolute/REQUIRED.md]` launches this agent. Add `--local` to run the same pipeline in your Claude Code session from the agent's own files; the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `planner/skill/aspira-planner/`; see **Skills** in `README.md`.

Or invoke the agent directly to turn a reviewed business spec into concrete implementation tasks and unit/integration test checklists:

```bash
agent planner "Plan implementation of $PWD/specs/feature/spec.reviewed/spec.reviewed.md against $PWD; required guidelines snapshot: /absolute/REQUIRED.md"

pnpm -C "$ASPIRA_KIT/packages/agents/planner" plan \
  "$PWD/specs/feature/spec.reviewed/spec.reviewed.md" "$PWD" /absolute/REQUIRED.md
```

Without a supplied snapshot, the eve entry point loads required guidelines from Notion. Standard reviewed specs produce a sibling `plan.review/` with `plan.reviewed.md`, `run-analysis.md` and `trace/`. Failed or unresolved plans must not be treated as ready to implement. See `planner/README.md` for context, models and validation.

## pr-reviewer

Six specialist reviewers plus an independent verifier review a pull request and settle on one fix list. For a local repo the output lands in that repo at `.pr-review/<branch>/`, and `.pr-review/` is added to its `.gitignore` on the first run.

```bash
# A GitHub PR by URL (GITHUB_TOKEN in the environment for private repos)
agent pr-reviewer "Review https://github.com/owner/name/pull/123"

# A GitHub PR by shorthand
agent pr-reviewer "Review owner/name#123"

# The branch checked out in this repo against main, capped at 2 rounds
agent pr-reviewer "Review the branch $(git branch --show-current) in $PWD against main, cap it at 2 rounds"

# A specific branch against a different base
agent pr-reviewer "Review the branch feat/checkout in $PWD against develop"

# Against the spec the feature was built from: every seat reads it and can raise spec findings
agent pr-reviewer "Review the branch feat/checkout in $PWD against main, the spec is $PWD/specs/checkout.md"

# Let it run to the default 4 rounds
agent pr-reviewer "Review the branch feat/checkout in $PWD against main"

# Write the output somewhere else
agent pr-reviewer "Review the branch feat/checkout in $PWD against main, write the output to /tmp/checkout-review"

# Terminal UI
agent-dev pr-reviewer
```

Reviewing the checked-out branch includes your uncommitted and untracked files. Naming any other branch reviews committed history only.

**Skill:** `/aspira-pr-reviewer <github-pr | repo-path> [--branch B] [--base main] [--max-rounds N] [--no-comment]` launches this agent. Add `--local` to run the same pipeline in your Claude Code session from the agent's own files; the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `pr-reviewer/skill/aspira-pr-reviewer/`; see **Skills** in `README.md`. A `--local` review exports the same files; Quinn then runs on the session's model, so it is not a second vendor.

## code-analyzer

Detects the repository's analyzers (project `lint`/`typecheck`/`format:check` scripts, ESLint, tsc, Prettier, Biome, Ruff, mypy, pyright, flake8, black, gofmt, go vet, golangci-lint, cargo fmt/clippy, RuboCop), runs them, applies their auto-fixes, hands the remaining errors to a workhorse model with read/search/exact-edit tools, and loops until clean or no further progress. It never adds suppressions or edits analyzer configuration, lockfiles, CI or tests.

```bash
# A local checkout: fixed in place on the host, report in <repo>/.static-analysis/
agent code-analyzer "Run static analysis on $PWD"

# Direct CLI, no eve or Docker (local repositories only)
pnpm -C "$ASPIRA_KIT/packages/agents/code-analyzer" analyze "$PWD" [--max-rounds 3] [--fix-warnings]

# A GitHub repository: cloned into the sandbox, fixed there, committed on static-analysis/<timestamp>
agent code-analyzer "Run static analysis on owner/name"

# ...and push the branch + open a pull request (GITHUB_TOKEN with write access)
agent code-analyzer "Run static analysis on owner/name and open a pull request"
```

Status `clean` means every analyzer passed; `partial` means diagnostics remain or an analyzer could not run; `nothing-detected` means no supported ecosystem. Review the diff before merging: passing static analysis does not prove behavior is unchanged, and no tests are run. Caps: 6 rounds and 5 USD by default (`STATIC_ANALYSIS_MAX_ROUNDS`, `STATIC_ANALYSIS_MAX_COST_USD`); model `STATIC_ANALYSIS_FIX_MODEL` (default `openai/gpt-6.1-sol`).

**Skill:** `/aspira-code-analyzer <repo | subdirectory | url | owner/name> [--push]` launches this agent. Add `--local` to run the same pipeline in your Claude Code session from the agent's own files; the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `code-analyzer/skill/aspira-code-analyzer/`; see **Skills** in `README.md`. A subdirectory is accepted, so a repository with several apps and no root `package.json` can be analyzed one app at a time.

## implementor

Builds a `planner` plan, a spec or a ticket test-first, running independent tasks in parallel. Its procedure is `implementor/agent/skills/aspira-implementor/SKILL.md`, which eve loads with `load_skill`, and its system prompt is `implementor/agent/instructions.md`.

```bash
# The agent: clones the GitHub repository, builds on implement/<feature>-<timestamp> and always pushes that branch
agent implementor "Implement docs/plans/feature/plan.review in the GitHub repository owner/name"
agent implementor "Implement specs/feature.md in the GitHub repository owner/name. Push the branch and open a draft pull request."
```

**Skill:** `/aspira-implementor <plan.review | spec.md> [--repo owner/name] [--ref BRANCH] [--pr]` launches this agent. Add `--local` to run the same pipeline in your Claude Code session from the agent's own files; the first stage is `knowledge`, where the session fetches the Notion rules (or pass `--guidelines`). Source: `implementor/skill/aspira-implementor/`; see **Skills** in `README.md`. Without `--repo`, the launcher builds the current checkout's GitHub `origin` from the current branch, which must be pushed. `--local` builds the local checkout and pushes nothing. It also takes a ticket, which the session first restates as a spec. Review the result with `pr-reviewer`.

## Checking an agent is healthy

```bash
pnpm -C $ASPIRA_KIT/packages/agents/spec-writer exec eve info
pnpm -C $ASPIRA_KIT/packages/agents/spec-reviewer exec eve info
pnpm -C $ASPIRA_KIT/packages/agents/planner exec eve info
pnpm -C $ASPIRA_KIT/packages/agents/pr-reviewer exec eve info
pnpm -C $ASPIRA_KIT/packages/agents/code-analyzer exec eve info
pnpm -C $ASPIRA_KIT/packages/agents/implementor exec eve info
```

Each should report `Compile ready` and `Diagnostics 0 errors`.
