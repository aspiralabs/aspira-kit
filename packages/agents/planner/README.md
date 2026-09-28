# Spec-to-plan

Converts a reviewed business spec into a concrete implementation plan. Research reads the current repository, engineering guidelines and configured read-only MCP sources. The planner turns that evidence into ordered file changes, wiring instructions, unit/integration test cases and verification commands. It never implements code or executes planned commands.

## Run

Use Node 24+ and install workspace dependencies with `pnpm install`.

```bash
pnpm -C /absolute/ASPIRA_KIT/packages/agents/planner plan \
  /absolute/feature/spec.reviewed/spec.reviewed.md \
  /absolute/repository /absolute/REQUIRED.md
```

An optional fourth argument selects an output directory. The default is `plan.review/` beside the input spec. For the standard `spec.reviewed/spec.reviewed.md` artifact, `plan.review/` is a sibling of `spec.reviewed/`, keeping the spec report's top level clean.

The eve entry point accepts the same inputs:

```bash
pnpm -C /absolute/ASPIRA_KIT/packages/agents/planner exec eve invoke \
  "Plan implementation of /absolute/feature/spec.reviewed/spec.reviewed.md against /absolute/repository; required guidelines snapshot: /absolute/REQUIRED.md"
```

Without a snapshot, the eve router uses `load-knowledge` and its `requiredHostFile`. That loader needs the existing Notion integration credentials and Docker sandbox. The direct CLI with a snapshot needs neither Docker nor an eve server. Both use the shared environment and optional `.env.development.local`.

## Calling skill

Use `/aspira-planner /absolute/path/to/spec.reviewed.md`. Add `--guidelines /absolute/REQUIRED.md` for the direct CLI; otherwise the skill uses the Notion-loading eve entry point. `--repo` and `--output` are optional.

The skill source is `skill/aspira-planner/`. Install it by linking that directory into your tool's skills directory, keeping future updates synchronized. Its launcher supports `start`, `status`, and bounded `wait`/`watch` commands.

## Context and models

Configure `MCP_READ_CONNECTIONS` from `.env.example` for read-only Notion/Aspira UI access. Use `pnpm mcp:check` to probe the connections. UI plans require actual successful catalog and component-document reads. Secrets stay in environment variables. A Codex connector is not automatically inherited by this runtime.

Research defaults to Opus 5.5 with seven tool steps. Planning defaults to GPT-6 Sol. Override with `SPEC_PLAN_RESEARCH_MODEL` and `SPEC_PLAN_MODEL`. Research, planning and preparation have no elapsed-time limit; manual cancellation remains available. There are no automatic retries.

## Output

```text
plan.review/
  plan.reviewed.md
  run-analysis.md
  trace/
```

The plan contains exact create/modify/delete targets, named symbols, technical instructions, dependencies, source evidence and completion outcomes. Separate unit and integration checklists specify setup, action and assertions. Every business criterion maps to implementation and tests; implementation depends on prior test-writing tasks. Final verification follows implementation.

`run-analysis.md` shows reported cost, tokens and wall time per agent/model turn, plus measured totals. Parallel durations are not summed as wall time. Eve routing and prior guideline loading are excluded; absent cost metadata remains unreported.

`trace/` holds the original spec, guidelines, research, structured plan, checks, model prompts/outputs, tool activity, usage and source commit/dirty state. Reruns preserve the previous report under `trace/history/`. The source spec is unchanged.

`ready` means structural/evidence checks passed, not that tests ran or a human approved the plan. Product decisions yield `needs-author`; missing evidence, invalid tasks, failed calls or missing UI documentation yield `incomplete`. A returned draft prominently shows that status. When no structured plan is produced, only analysis and trace are exported. CLI exit 0 means ready; exit 1 means incomplete/needs-author. Revalidate repository context before building; source quotes and structural checks do not prove semantic correctness.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm exec eve info
```

Tests use synthetic specs and fake model calls. They establish orchestration, validation and output behavior, not live model quality or speed. This agent is private; its package needs no changeset.
