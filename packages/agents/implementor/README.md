# Implementor

Builds a feature test-first from a `planner` plan, a spec or a ticket, under the Aspira engineering rules in Notion, running independent tasks in parallel. The agent's procedure is `agent/skills/aspira-implementor/SKILL.md` (eve loads it with `load_skill`) and its system prompt is `agent/instructions.md`. Those two files are the single source of the implementor's rules.

## In Claude Code: `/aspira-implementor`

```bash
ln -sfn "$ASPIRA_KIT/packages/agents/implementor/skill/aspira-implementor" ~/.claude/skills/aspira-implementor
```

The skill (`skill/aspira-implementor/`) only calls the agent:

```
/aspira-implementor <source> [--repo owner/name | --repo DIR] [--ref BRANCH] [--pr]          # launch the agent
/aspira-implementor <source> --local [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial]   # run its procedure here
```

- **Default** launches the `implementor` eve agent detached (`scripts/implementor.sh start|status|wait`). Without `--repo owner/name`, the launcher reads `owner/name` from the current checkout's `origin` and starts from the current branch, which must be pushed. The agent's prompt is the same one the old remote launcher sent.
- **`--local`** runs the agent's procedure in the session on the local checkout and pushes nothing. `scripts/implementor.sh local` steps a driver (`agent/lib/local.ts`) that makes no model calls. The first stage is always `knowledge`: the Notion pages that `load-knowledge` would load under the agent's config (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`, then the topic pages the required pages route to), which the session fetches with the Notion MCP. `--guidelines` supplies a snapshot instead. Then come `plan` (spec or ticket input), `parallelize`, each wave's worker lanes and the orchestrator's `wave-commit`, and `verification`. Each prompt embeds the current bytes of the procedure and instructions, plus the knowledge. The worker brief is the template in the procedure's section 5. Outputs are checked against `agent/lib/local-plan.ts`. A reviewed plan is gated first (`review.json` status, drift against `repoCommit`). The export, `<work dir>/trace/implementation-local.json`, records every prompt and output and the Notion pages used, with their hashes.

  The `verification` stage carries the driver's own findings for the procedure's section 6: the manifest diff between the branch base (the merge base with the default branch, else HEAD when the run started) and HEAD with each addition's native markers and Approved Technologies status (`agent/lib/dependencies.ts`, the page read from the knowledge folder by title), the mid-build notes files under the work directory with the backticked identifiers `git grep -F` no longer finds and the rename it would suggest (`agent/lib/notes.ts`), and the Slop Repo areas (the topic pages the Agent Instructions routing table names). The output must list every addition, account for every notes file (a rewritten one carries the header with a commit SHA and no stale identifier; a deleted one is gone), name an area from that list, and the log must have its `## Dependencies added`, `## Mid-build notes` and `## Proposed Slop Repo entries` sections, the last never empty.

## In the cloud: the `implementor` agent

```bash
# from a session: /aspira-implementor docs/plans/my-feature/plan.review --repo owner/name [--ref develop] [--pr]
agent implementor "Implement docs/plans/my-feature/plan.review in the GitHub repository owner/name"
agent implementor "Implement specs/my-feature.md in the GitHub repository owner/name, starting from branch develop. Push the branch and open a draft pull request."
```

The agent loads its procedure with `load_skill` and adds three tools the cloud needs:

| Tool | What it does |
| --- | --- |
| `checkout-repo` | Clones the GitHub repository into the sandbox at `/workspace/repo` and checks out `implement/<feature>-<timestamp>`. The token is used for the clone and removed from `.git/config`. |
| `load-knowledge` | The shared Notion loader: `/workspace/knowledge/REQUIRED.md`, `INDEX.md` and one file per page. |
| `record-verification` | Takes the final verification in the shape the `--local` driver checks (`agent/lib/local-plan.ts` `VERIFICATION`): the feature table, every dependency the build added with its native and approval flags, every mid-build notes file as rewritten or deleted, and the proposed Slop Repo entries or why there are none. The cloud run has no driver, so this is where the schema applies. |
| `publish-branch` | Pushes the run's own branch (always, so the work leaves the sandbox) and, with `pullRequest: true`, opens a **draft** pull request. Refuses any other branch, uncommitted changes, an empty branch, or a run that has not called `record-verification`. |

Parallel lanes run as copies of the root agent through eve's built-in `agent` tool. Copies share the sandbox, so the skill gives each one a disjoint write scope, and only the root installs, runs git and commits. The agent cannot reach a local path on your machine or a ticket tracker; use `--local` for those. Like the skill, it runs to completion: open decisions become recorded assumptions, and only the stop list blocks work.

Environment: `AI_GATEWAY_API_KEY`, `GITHUB_TOKEN` (clone private repos, push, PR), `NOTION_TOKEN` and `KNOWLEDGE_PAGE`, all in the shared `../.env.local`. `IMPLEMENTOR_MODEL` overrides the model (default `anthropic/claude-opus-5.5`, used by the root and its copies).

## Layout

```text
agent/
  agent.ts                        root agent; keeps the built-in `agent` tool for parallel lanes
  instructions.md                 system prompt: the cloud run's differences
  skills/aspira-implementor/SKILL.md  the procedure (eve load_skill; embedded in every --local prompt)
  tools/                          checkout-repo, record-verification, publish-branch, load-knowledge, glob, grep
  lib/github.ts                   pure repo/branch/token helpers
  lib/checkout-state.ts           session state: what was cloned, so publish pushes only that
  lib/verification-state.ts       session state: the recorded final verification, so publish refuses without it
  lib/dependencies.ts             manifest diff since the branch base; native and Approved Technologies flags
  lib/notes.ts                    mid-build notes: identifiers checked with git grep, renames, sentence removal, SHA header
  lib/local.ts                    the --local step driver
  lib/local-knowledge.ts          the knowledge stage: pages from the agent's knowledge config
  lib/local-plan.ts               --local output schemas and plan/lane coherence checks
skill/aspira-implementor/
  SKILL.md                        the Claude Code skill: mechanics only
  scripts/implementor.sh          start | status | wait (agent) and local (driver step)
scripts/local.ts                  CLI for one --local step (`pnpm run implement:local`)
```

## Verification

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm run info
```

Tests cover repository parsing, the clone (against a local bare repository, no token left in git config), branch naming, the push guard, the pinned rules in the agent files, the skill (no rule text, names the agent files), the launcher (stubbed pnpm and screen), the manifest diff with its native and approval flags on a fixture repository, the notes rewrite on a fixture repository, the verification schema (the three fields, the justification), the `record-verification` tool's schema, and the `--local` driver: refusing to start without knowledge, a page list from the agent config, prompts that embed and follow the live agent files, a refused mid-run knowledge change, the gate, and a full wave run with schema retries, the verification checks against the tree and export. They do not run a model. This agent is private; its package needs no changeset.
