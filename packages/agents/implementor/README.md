# Implementor

Builds a feature test-first from a `planner` plan, a spec or a ticket, under the Aspira engineering rules in Notion, running independent tasks in parallel. The procedure is the `aspira-implementor` skill. This package mounts that skill so it can also run unattended in the cloud.

## In Claude Code: `/aspira-implementor`

```bash
ln -sfn "$ASPIRA_KIT/packages/agents/implementor/agent/skills/aspira-implementor" ~/.claude/skills/aspira-implementor
```

`/aspira-implementor @my-spec.md` builds that spec in the repository of the current directory, start to finish, without stopping for confirmation. Open decisions become assumptions recorded in `implementation.md` and listed in the summary. It stops only for an `incomplete` reviewed plan, a Notion/project rule conflict, an irreversible or high-risk decision (destructive migrations, auth, payments, security, unplanned dependencies) or an unreadable source, and builds everything else first.

```
/aspira-implementor <source> [--repo DIR | --repo owner/name] [--ref BRANCH] [--pr] [--max-parallel N] [--serial] [--guidelines FILE]
```

| Source | Repository | What happens |
| --- | --- | --- |
| `plan.review/` or `plan.reviewed.md` | local (cwd or `--repo DIR`) | Gates on `trace/review.json` (`ready` only) and builds `trace/plan.json`. |
| a spec file (`@my-spec.md`) | local | Drafts `plan.json`/`plan.md` in `implementation/` beside the spec and builds it straight away. |
| a ticket (`ENG-123`, `owner/name#45`, a tracker URL) | local | Fetches it through whatever tracker MCP (or `gh`) the session has, restates it as a spec with F-IDs in `.implement/<key>/`, drafts the plan, builds. |
| a plan or spec path inside the repo | `--repo owner/name` or a GitHub URL | Hands off to the `implementor` agent via `scripts/implement-remote.sh` and relays its report. |

Every mode then does the same thing. It loads Agent Instructions and the matching topic pages from Notion (falling back to the plan's `trace/guidelines.md`). It splits the plan into waves and lanes by dependency and by which files each task writes, and fans the lanes out to subagents. Each lane writes its tests first, sees them fail, then implements until they pass. The session verifies and commits each wave, and keeps `implementation.md` in the work directory as the record.

## In the cloud: the `implementor` agent

```bash
# from a session: /aspira-implementor docs/plans/my-feature/plan.review --repo owner/name [--ref develop] [--pr]
agent implementor "Implement docs/plans/my-feature/plan.review in the GitHub repository owner/name"
agent implementor "Implement specs/my-feature.md in the GitHub repository owner/name, starting from branch develop. Push the branch and open a draft pull request."
```

The agent loads the same skill with `load_skill` and adds three tools the cloud needs:

| Tool | What it does |
| --- | --- |
| `checkout-repo` | Clones the GitHub repository into the sandbox at `/workspace/repo` and checks out `implement/<feature>-<timestamp>`. The token is used for the clone and removed from `.git/config`. |
| `load-knowledge` | The shared Notion loader: `/workspace/knowledge/REQUIRED.md`, `INDEX.md` and one file per page. |
| `publish-branch` | Pushes the run's own branch (always, so the work leaves the sandbox) and, with `pullRequest: true`, opens a **draft** pull request. Refuses any other branch, uncommitted changes or an empty branch. |

Parallel lanes run as copies of the root agent through eve's built-in `agent` tool. Copies share the sandbox, so the skill gives each one a disjoint write scope, and only the root installs, runs git and commits. The agent cannot reach a local path on your machine or a ticket tracker; use the skill for those. Like the skill, it runs to completion: open decisions become recorded assumptions, and only the stop list blocks work.

Environment: `AI_GATEWAY_API_KEY`, `GITHUB_TOKEN` (clone private repos, push, PR), `NOTION_TOKEN` and `KNOWLEDGE_PAGE`, all in the shared `../.env.local`. `IMPLEMENTOR_MODEL` overrides the model (default `anthropic/claude-opus-5.5`, used by the root and its copies).

## Layout

```text
agent/
  agent.ts                        root agent; keeps the built-in `agent` tool for parallel lanes
  instructions.md                 cloud-only differences; everything else is in the skill
  skills/aspira-implementor/SKILL.md  the skill, the single source for both runtimes
  skills/aspira-implementor/scripts/implement-remote.sh  session launcher for remote repositories
  tools/                          checkout-repo, publish-branch, load-knowledge, glob, grep
  lib/github.ts                   pure repo/branch/token helpers
  lib/checkout-state.ts           session state: what was cloned, so publish pushes only that
```

## Verification

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm run info
```

Tests cover repository parsing, the clone (against a local bare repository, no token left in git config), branch naming, the push guard, the skill contract and the remote launcher (stubbed pnpm and screen). They do not run a model. This agent is private; its package needs no changeset.
