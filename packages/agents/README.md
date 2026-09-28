# packages/agents

All agents run without application wall-clock cutoffs, including preparation, model phases, MCP/Notion reads and eve session expiration. Manual cancellation, failure reporting and cost/time measurement remain. Provider or host failures can still end a request. Short launcher waits poll status without stopping the detached agent.

The tracked `@modelcontextprotocol/sdk` patch in `patches/` adds `timeout: false` for agent MCP requests; omitted timeouts keep the SDK default for other consumers. Keep its regression tests passing when upgrading the SDK.


Aspira Labs agents, built on [eve](https://vercel.com/eve). One package per agent, all repo-local: not published, not installed by `kit`.

| Package | Agent | Spec | State |
| --- | --- | --- | --- |
| `packages/agents/spec-review-agent` | `spec-review-agent` | `specs/agents-spec-review.md` | official three-phase reviewer |
| `packages/agents/spec-to-plan` | `spec-to-plan` | `specs/agents-spec-to-plan.md` | implementation and test planning |
| `packages/agents/pr-review-agent` | `pr-review-agent` | `specs/agents-pr-review.md` | working |
| `packages/agents/static-analysis-agent` | `static-analysis-agent` | `specs/agents-static-analysis.md` | detect, run, auto-fix, model-fix, loop until clean |
| `packages/agents/implementor` | `implementor` | `specs/agents-implementor.md` | cloud runner for the `/aspira-implement` skill: builds a plan test-first, parallel lanes |

## How an agent is selected

There is no agent-name flag. `eve` walks up from the working directory to the nearest app root (a package with an `agent/` directory) and loads the one root agent it finds there. One package, one root agent, no ambiguity — which is why every command in these READMEs is `pnpm --filter @aspiralabs/<name> exec eve <cmd>`: the filter sets the directory, and the directory is the choice. `eve invoke --agent <name>` selects from eve's `agents/<name>/` workspace layout, which this repo does not use.

Why not that layout: in eve 0.63.0 a workflow tool inside a workspace member compiles under one id (`workflow//./agents/<name>/agent/tools/...`) and registers at runtime under another (`workflow//./agent/tools/...`), so every call fails with "not registered as a workflow". A single `agent/` per package sidesteps it, and eve names the agent after the package (minus scope). Revisit when eve fixes it.

## Running one from anywhere

Two forms, and the difference matters:

```bash
# Anywhere on the machine, including ~ : point pnpm at the package directory.
pnpm -C /path/to/ASPIRA_KIT/packages/agents/pr-review-agent exec eve invoke "who are you?"

# Inside the monorepo only: name the package and let pnpm find it.
pnpm --filter @aspiralabs/pr-review-agent exec eve invoke "who are you?"
```

`--filter` resolves package names against the workspace, so it needs the working directory to be *inside* the monorepo. Run it from your home directory and pnpm finds no workspace root, tries to enumerate everything under `~`, and dies on macOS-protected directories:

```
Error: ERR_PNPM_WORKSPACE_WALK_ERROR
 × finding workspace projects
   Failed to walk workspace projects under /Users/you: ... Library/Application Support/
   CallHistoryTransactions: Operation not permitted (os error 1)
```

`-C` (alias `--dir`) skips workspace resolution entirely — it just runs in the directory you name. That is the form to use from an unrelated repo, from `~`, or in a script.

The ergonomic version, once per machine:

```bash
# ~/.zshrc
export ASPIRA_KIT="$HOME/path/to/ASPIRA_KIT"

agent() {
  if [ $# -lt 2 ]; then
    echo "usage: agent <name> <prompt>" >&2
    ls -1 "$ASPIRA_KIT/packages/agents" | grep -v '^README.md$' | sed 's/^/  /' >&2
    return 2
  fi
  local name=$1; shift
  local dir="$ASPIRA_KIT/packages/agents/$name"
  [ -d "$dir" ] || { echo "agent: no such agent '$name'" >&2; return 1; }
  pnpm -C "$dir" exec eve invoke "$@"
}

agent-dev() { pnpm -C "$ASPIRA_KIT/packages/agents/${1:?usage: agent-dev <name>}" dev; }
```

Then, from anywhere — including inside the repo you want reviewed:

```bash
agent spec-review-agent "Review $PWD/specs/feature/spec.md against $PWD"
agent                     # no args: lists the installed agents
agent-dev spec-review-agent
```

Either way the package directory is what selects the agent — eve loads the one root agent under the app root it finds from the working directory, and both `-C` and `--filter` set that directory for you. There is no agent-name flag to get wrong.

Whichever form you use, **relative paths in your prompt resolve against the package directory, not your shell's** — the review tools resolve paths from the agent package. Pass absolute paths and the question disappears.

Package scripts (`dev`, `info`, `typecheck`, `lint`) need no `exec`: `pnpm -C <dir> dev`. Anything else on the eve CLI goes through `exec eve <cmd>`.

## Adding an agent

`pnpm-workspace.yaml` already globs `packages/agents/*`, so the steps are:

1. Write the spec first (`specs/agents-<name>.md`). Rule zero in `packages/config/agent/constraints.md`: no spec, no code.
2. `mkdir packages/agents/<name>` and copy `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, and `.env.example` from an existing agent, plus an `agent/` with `agent.ts`, `instructions.md`, and `channels/eve.ts`. Then edit `package.json` (name `@aspiralabs/<name>`, version `0.1.0`, description). Take the agent whose shape is closer to what you are building.
3. Add `@aspiralabs/<name>` to `ignore` in `.changeset/config.json`. Repo-local packages are never versioned by the release flow, and a package missing from that list breaks `changeset version`.
4. `pnpm install`, then `pnpm --filter @aspiralabs/<name> exec eve info` to confirm eve discovers it with 0 diagnostics.
5. `cp .env.example .env.local` in the new package and put an AI Gateway key in it. Every package needs its own; `.env.local` is gitignored.

Root `typecheck` and `lint` (`pnpm -r`) pick the package up for free. Root `build` and `test` filter on `./packages/*` and skip it.

## Shared conventions

Every agent package looks the same from the outside: `dev`, `build`, `typecheck`, `lint`, `info` scripts; `@aspiralabs/config` for eslint and tsconfig; `private: true`; Node 24.

Inside `agent/`, the convention `spec-review-agent` sets and the next agent should follow:

| Path | What goes there |
| --- | --- |
| `agent.ts` | the root agent: model, description. Routes, does not do the work |
| `instructions.md` | the system prompt |
| `tools/` | one file per tool, `defineTool` or `defineWorkflowTool`. Runtime glue only |
| `lib/` | the logic the tools call. Pure, no eve imports, testable without a runtime |
| `subagents/<name>/` | specialists, `tool: false` so only a workflow can reach them |
| `hooks/` | `step.completed` and friends, usually a one-line re-export from `lib/` |
| `channels/eve.ts` | the default HTTP/TUI channel |

Agents do not import each other. Shared logic that two agents need goes in `@aspiralabs/config`, not in a sibling agent package.

## Shared secrets: `packages/agents/.env.local`

One env file for every agent. Each agent's `.env.local` is a symlink to `packages/agents/.env.local`, and eve loads it from the agent's folder as usual. `packages/agents/.env.example` lists the keys: the AI Gateway key, an optional GitHub token, and the Notion connection token and guidelines page for `load-knowledge`. An agent-specific override goes in `<agent>/.env.development.local`, which eve loads with higher priority; a shell variable on the command line beats both. A new agent joins with `ln -s ../.env.local <agent>/.env.local`.

## Shared tools: `packages/agents/common`

`@aspiralabs/agent-common` holds tools and pure helpers every agent can mount. An agent takes it as a workspace dependency and re-exports a tool from its own `agent/tools/`, which is where eve looks:

```ts
// agent/tools/load-knowledge.ts
export { default } from '@aspiralabs/agent-common/tools/load-knowledge'
```

| Tool | Mounted by | What it does |
| --- | --- | --- |
| `load-knowledge` | spec-review-agent, pr-review-agent | Loads the org's engineering guidelines from Notion into the sandbox at `/workspace/knowledge` as markdown, `INDEX.md` first, one file per page. Needs `NOTION_TOKEN` and `KNOWLEDGE_PAGE` in the agent's `.env.local`; without them it reports `configured: false`; the spec reviewer requires guidelines and reports a blocker. `KNOWLEDGE_REQUIRED` names the pages every agent must read in full; they are concatenated into `REQUIRED.md`, returned as `requiredFile`, and a missing one is an error. |

Helpers and their tests live in `common/src/lib/`, so a shared helper is tested once. The spec reviewer owns its three-phase pipeline and per-phase cost report; the PR reviewer owns its separate review loop.

## Spec to implementation workflow

`spec-review-agent` reviews intent and business acceptance criteria. `spec-to-plan` reads the reviewed spec and creates concrete technical tasks with mapped unit/integration test checklists. `/aspira-implement` (or the `implementor` agent in the cloud) writes those tests first, then implements the plan, running independent tasks in parallel. Both planning agents use shared read-only repository/MCP access and run-analysis/trace infrastructure in `agent-common`.
