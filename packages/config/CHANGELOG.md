# @aspiralabs/config

## 0.6.0

## 0.5.5

## 0.5.4

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

### Minor Changes

- c6e7dcf: `@aspiralabs/config` is eslint, tsconfig and prettier only. Its `agent/` folder is gone: the rules live in Notion (Engineering Central), the `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and settings templates now ship in `@aspiralabs/kit` (`templates/agent/`), and the session hooks in `@aspiralabs/kit/hooks/`. The `./agent/*` export is removed.

  The managed block that `kit init` writes into a project's `AGENTS.md`, and the session-start hook, are pointers only: Agent Instructions for the rules, From Idea to Release and its Playbook for the process and "what is the next step", the Slop Repo and the kit gap pages for lessons. They restate no rule. `kit init` drops settings entries that still point at the retired config hook path.

  Feature work has one layout in every project: a gitignored `.work/<id>-<slug>/` per ticket, pulled from the Notion ticket and never committed. `kit init` adds `.work/` to `.gitignore` instead of creating `specs/`; `kit doctor` checks the ignore line and fails on a committed `specs/`, `docs/plans` or `docs/working-feature` folder.

## 0.4.2

### Patch Changes

- 30e68da: Agents: the planner researches deeply and plans list test files, not their helpers. Research has its own role and is sent back while it has turns left; the repository snapshot includes the installed kit configuration; the Notion read tool reads linked databases such as Approved Technologies; planning gets the full text of the guideline pages research read; model calls are never timed out and long structured answers are streamed. The implementor creates test-only fixtures and helpers itself.

## 0.4.1

### Patch Changes

- 99fa55e: Agents follow one skill pattern: every agent has an `aspira-<agent>` skill that launches it, `--local` runs the same pipeline inside a Claude Code session from the agent's own instruction files, and the Notion engineering rules are mandatory on every path. Adds `aspira-pr-reviewer`, `--local` for planner and code-analyzer, and code-analyzer subdirectory support. See `packages/agents/README.md`.

## 0.4.0

## 0.3.0

### Patch Changes

- 9e1b4e5: The AGENTS.md template gets a Gotchas section for project facts that contradict a reasonable assumption. The spec-reviewer's debaters read the project's AGENTS.md or CLAUDE.md, Gotchas first, before writing a finding, and the org's Review Verification rules (REV) in Notion say the same.
- 9e1b4e5: Rule zero names the business spec contract: intent and observable feature acceptance criteria are the floor. The spec-reviewer enforces this contract; technical test design belongs in the implementation plan.
- 9e1b4e5: Separate business acceptance criteria in feature specs from technical tasks and test-first unit/integration checklists in implementation plans.

## 0.2.1

## 0.2.0

### Patch Changes

- 239e049: `@aspiralabs/ui`: the 43 JSX ternaries that came over from SAAS_BOILER are rewritten (lookup maps, early-return helpers, precomputed props) and the package-level lint exemption is removed, so the org's no-ternary rule now holds inside the ui package. No rendered output changes. `@aspiralabs/config`: first two agent guides, `table-pagination` and `choosing-a-selector`.

## 0.1.0

### Minor Changes

- d898b86: Initial release: the ui library with tokens, docs, and MCP server; shared eslint, tsconfig, prettier, and agent config; the kit CLI.
