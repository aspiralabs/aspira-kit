# Implementor agent and /aspira-implementor skill

## Intent

Build a feature test first, under the Aspira engineering rules in Notion, from one of three sources: the plan the `planner` agent produces (`plan.review/` with `trace/plan.json`), a spec file, or a ticket from a connected tracker. The repository is local, or a GitHub repository built by the cloud agent. The procedure is a skill, `/aspira-implementor`, that runs in a Claude Code session. The `implementor` agent exists only so the same skill can run unattended in the cloud: it mounts the skill and supplies what a cloud run lacks (a repository checkout, the Notion guidelines and a way to publish a branch). The skill replaces greenfield-gary for Aspira projects.

## Constraints

- One skill source, `packages/agents/implementor/agent/skills/aspira-implementor/SKILL.md`, used by both runtimes. Claude Code links to it; the eve agent loads it with `load_skill`. No second copy that can drift.
- `/aspira-implementor @spec.md` runs to completion in the current directory's repository without asking for confirmation. Open decisions are settled conservatively and recorded as assumptions. Work stops only for an `incomplete` reviewed plan, a rule conflict, an irreversible or high-risk decision, or an unreadable source, and everything that does not depend on the blocker is built first.
- The plan is the contract. A reviewed plan marked `incomplete` is refused. A spec or ticket is built directly: the skill drafts a plan in the same shape as `plan.json` (tasks, tests, dependencies, evidence) and does not add scope the source does not state. Scope beyond the plan is reported, not built.
- A ticket is restated as a spec with numbered criteria before planning (rule zero). Tickets come from whatever tracker MCP or CLI the session has; no tracker is hardcoded.
- Guidelines come from Notion as they do for the other agents: `Agent Instructions` routes to the topic pages, the planner's `trace/guidelines.md` snapshot is the baseline, and a conflict between a project instruction and a Notion rule stops the run. The project's `AGENTS.md`/`CLAUDE.md` and its Gotchas are read before any code.
- The skill decides how much to parallelize from the plan itself: explicit `dependsOn`, shared write targets, shared hot files (manifests, lockfiles, barrels, schemas, migrations) and task size. Parallel workers never share a write target, and only the orchestrator installs dependencies, runs git and commits.
- Tests are written and seen failing before implementation, and implementation tasks pass their own test commands before the next wave starts. Suppressions, skipped tests and weakened assertions are never a way to green.
- Cloud runs work on a clone inside the eve sandbox. The GitHub token stays in the app runtime and never reaches the model's shell. Every cloud run pushes only its own `implement/` branch, so the work leaves the sandbox; a pull request is opt-in and always a draft.
- Agents do not import sibling agents. Shared helpers come from `@aspiralabs/agent-common`.

## Acceptance criteria

### Features

- [ ] F1: `/aspira-implementor <plan>` builds a `ready` plan in a local repository and refuses `incomplete` plans. For `needs-author` plans it records the open decisions as assumptions and builds.
- [ ] F8: `/aspira-implementor <spec file>` in a local repository drafts a grounded test-first plan beside the spec and builds it without stopping for confirmation. `@` file mentions are accepted and the current directory's repository is the default.
- [ ] F9: `/aspira-implementor <ticket>` in a local repository fetches the ticket through a connected MCP or CLI, restates it as a spec with numbered criteria, records its gaps as assumptions, then plans and builds it. Commits carry a `Ticket:` trailer.
- [ ] F10: `/aspira-implementor <path> --repo owner/name` hands a plan or spec path inside that GitHub repository to the `implementor` agent through a detached launcher, and relays its report.
- [ ] F2: Before any code, the skill loads the Notion engineering rules (Agent Instructions plus the topic pages for the task's area), the planner's guidelines snapshot, the project's AGENTS.md/CLAUDE.md and Gotchas, and the Aspira UI component docs when the plan touches UI.
- [ ] F3: The skill shows a parallelization plan (waves, lanes, write scopes and the reason for each split) derived from the plan's dependencies and file overlap. It runs independent lanes as parallel subagents and runs small or fully serial plans in the session.
- [ ] F4: Every lane writes its tests first, confirms they fail for the planned reason, then implements until its task commands pass. Workers edit only files in their write scope and report anything else as a blocker.
- [ ] F5: The orchestrator verifies each wave itself: changed files stay within declared scopes, task commands are re-run, and the wave is committed with a `Spec:` trailer (`Ticket:` for a ticket). A failed task stops its dependents and the run reports the blocker.
- [ ] F6: The run ends with the plan's verification commands, a feature-to-test table and a progress log (`implementation.md` in the work directory: `plan.review/`, `implementation/` beside a spec, or `.implement/<key>/` for a ticket) that records task status, commits, deviations with rule IDs and blockers.
- [ ] F7: The `implementor` eve agent runs the same skill against a GitHub repository in its sandbox, loads Notion guidelines with `load-knowledge`, and works on an `implement/<slug>-<timestamp>` branch. It always pushes that branch so the work leaves the sandbox, and opens a draft pull request only when asked.

## Verification plan

- Unit: repository parsing, clone command, token redaction, branch naming and the push guard (refuses any branch outside `implement/`). [F7]
- Unit: the clone leaves no token in the sandbox's git config. [F7]
- Integration: `eve info` compiles the agent with the skill, `load-knowledge`, `checkout-repo` and `publish-branch` and reports 0 diagnostics. [F7]
- Integration: the skill file is the one the Claude Code link resolves to, and it names the three sources, the gate, standards, plan drafting, parallelization, TDD, wave verification and report steps. [F1] [F2] [F3] [F4] [F5] [F6] [F8] [F9]
- Integration: the remote launcher passes a repo-relative source, ref and PR choice to the official agent, and rejects local paths, without a paid run. [F10]
- Manual: real runs of `/aspira-implementor` on a small ready plan, a spec and a ticket. [F1] [F3] [F4] [F5] [F6] [F8] [F9]
- Validation: tests, lint and typecheck pass for the new package.

## Out of scope

Deploying the agent to Vercel, editing Notion pages, reviewing the resulting diff (that is `pr-reviewer`), fixing plans (that is `planner`), and merging pull requests.

## Blast radius

New private package `packages/agents/implementor`; the changeset ignore list; the agents README and INSTRUCTIONS; the workspace lockfile. No published package changes.
