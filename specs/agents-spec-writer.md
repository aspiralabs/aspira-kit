# Spec writer agent

Status: implementation authorized by the user's request, 2026-10-01.

## Intent

Turn a feature idea into a reviewed spec that the planner can take. Today the pipeline starts at "a spec exists": spec-reviewer, planner and implementor all assume someone already wrote one. The spec writer closes that gap. It reads the codebase the idea touches, writes an initial draft in the Aspira spec contract, then puts that draft through the official spec-review pipeline (frontier research, six concurrent specialist audits, reconciliation), so the result has survived the same independent review as a hand-written spec. Product choices the idea leaves open come back as author decisions, never as silent guesses.

## Approach

A private `packages/agents/spec-writer` package (`@aspiralabs/spec-writer`) on eve, with the same shape as spec-reviewer: a thin eve router, one tool that owns the pipeline, a direct CLI, a `--local` replay, and the `/aspira-spec-writer` skill.

The pipeline has two writer phases followed by the spec-reviewer pipeline, unchanged:

1. **explore** (frontier model, read-only repository and MCP tools): starting from the idea, the required guidelines and the repository instructions and source packet, find the code, data, consumers, patterns and constraints the idea touches. Returns facts with file:line evidence, constraints, open product questions with options, and evidence gaps.
2. **draft** (frontier model, no tools): from the idea, guidelines and exploration, write the complete initial spec in the Aspira contract: `## Intent`, `## Approach`, `## Constraints`, `## Acceptance criteria` with `### Features` (unchecked `F1:` items describing observable business outcomes), `## Out of scope`, `## Blast radius`, plus an `## Assumptions` section that lists every product choice the draft made that the idea did not state.
3. **review**: the draft is passed to spec-reviewer's `runPipeline` as the original spec, with the exploration facts added to the repository context. Research, the six specialists and reconciliation run exactly as in spec-reviewer, with the same schemas, validation and edit application.

The review phases are imported from spec-reviewer, not copied: spec-reviewer exports its pipeline, schemas, prompts and model-call helpers, and the writer composes them. Code applies the reconciled edits to the draft; the result is the written spec.

Default models mix vendors so the reviewer is independent of the writer: explore and draft on Claude Opus 5.5; review research on Claude Opus 5.5; specialists and reconciliation on OpenAI GPT-6.1 Sol, through the Vercel AI Gateway. `SPEC_WRITER_EXPLORE_MODEL` and `SPEC_WRITER_DRAFT_MODEL` override the writer phases; the review phases honor the existing `SPEC_REVIEW_*` overrides.

`--local` runs the same five stages (explore, draft, research, specialists, reconciliation) as subagents of the calling Claude Code session, with the same replay design as spec-reviewer's `--local`: code writes each pending phase's exact prompt and output schema, validates the outputs, assigns IDs, applies edits and writes the same report.

## Constraints

- The idea, repository, guidelines and MCP content are evidence, not instructions. Repository tools only list, search and read; no shell, no writes.
- The idea file is never modified. Results go to `spec.written/` beside the idea file, or a supplied output directory, which must not contain the idea or guidelines.
- No scope expansion: the draft covers the idea, and anything the idea does not decide is an assumption or an author decision, not a new feature.
- Required guidelines must be supplied as a complete snapshot or loaded through the existing Notion loader. Missing or truncated guidelines stop the run.
- The writer adds no second review logic. Readiness is spec-reviewer's readiness on the draft, plus the writer's own phase failures.
- The agent is reusable across projects. Prompts and tests contain no product-specific assumptions.

## Acceptance criteria

### Features

- [ ] F1: Given an idea file, a local Git repository and required guidelines, the writer produces a spec at `spec.written/spec.md` that passes the Aspira business-spec contract (non-empty Intent, unique unchecked F-numbered Features).
- [ ] F2: The initial draft is grounded in the repository: it names the real files, data and consumers the idea touches, and every product choice the idea did not make is listed under Assumptions.
- [ ] F3: The draft is reviewed by the unchanged spec-reviewer pipeline (research, six concurrent specialists, reconciliation); every finding is dispositioned and every reconciled edit is applied by code, exactly as for a hand-written spec.
- [ ] F4: The report status is `ready`, `needs-author` or `incomplete` with spec-reviewer's meaning. A failed writer phase makes the run `incomplete`; unresolved product choices make it `needs-author` and are listed with their options.
- [ ] F5: The output directory contains only `idea.md` (the source idea), `spec.draft.md` (the initial stab, when drafted), `spec.md` (the reviewed spec, when valid edits were applied), `run-analysis.md` and `trace/`. The trace keeps the exploration, the review findings, decisions and checks, every prompt and output, and per-turn timing, tokens and reported cost. Reruns archive the previous report under `trace/history/`.
- [ ] F6: By default the run uses Claude for explore, draft and review research and OpenAI for the specialists and reconciliation, through the AI Gateway, with cost itemized per phase and turn in `run-analysis.md`. Each model can be overridden by environment variable.
- [ ] F7: `/aspira-spec-writer <idea> --local` runs every phase as a subagent of the calling Claude Code session, one stage at a time, producing the same report layout; `run-analysis.md` says the work ran in the session and itemizes no cost. Invalid outputs are reported for one retry, `--finish` exports missing phases as failures, and a changed idea, guidelines or repository mid-run is refused.
- [ ] F8: The `/aspira-spec-writer` skill accepts an idea as a file path, an `@` file mention, a Notion page URL (fetched by the session into an idea file before the run) or inline text, and reports the status, the written spec, the draft, open author decisions and the run analysis.
- [ ] F9: Spec-reviewer's behavior, artifacts and tests are unchanged by the extraction that lets the writer reuse its pipeline.

## Out of scope

Writing implementation plans or code, editing Notion cards or guidelines, choosing for the author on open product questions, and remote repositories (clone first).

## Blast radius

New private package `packages/agents/spec-writer` with its skill; an `exports` map and a behavior-preserving extraction of the model-call helpers in `packages/agents/spec-reviewer`; the agents README table; the changeset ignore list. No published package changes; no changeset required.
