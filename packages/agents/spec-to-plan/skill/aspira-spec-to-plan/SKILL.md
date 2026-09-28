---
name: aspira-spec-to-plan
description: Turn a reviewed business spec into concrete implementation tasks and unit/integration test checklists by calling the Aspira spec-to-plan agent. Use for /aspira-spec-to-plan or requests to generate an implementation plan with this agent.
---

# Spec to plan

Call the `spec-to-plan` agent; do not implement the feature or generate a competing plan yourself. It researches the current repository and engineering guidelines, then produces a test-first implementation plan mapped to the spec's business criteria.

Use the absolute path to `scripts/spec-to-plan.sh` beside this file. Run from the target repository, or pass `--repo`:

```bash
<skill-dir>/scripts/spec-to-plan.sh start <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

With a complete guidelines snapshot, the launcher uses the direct CLI. Otherwise it uses the eve entry point to load required guidelines from Notion, which needs configured integration credentials and the loader's Docker sandbox. The helper needs Node 24, pnpm, screen and the agent environment. It resolves the agent through `SPEC_TO_PLAN_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/spec-to-plan`, then its own package location.

The helper detaches the run and prints its run/log directory. Tell the user where results will go. Check with `status <run-dir>` or `wait <run-dir> --max 30`; `watch` is a bounded alias for `wait`. The polling wait returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Research, planning and preparation have no elapsed-time limit; fresh guideline loading adds time. Do not automatically retry incomplete or failed runs, since retries incur additional model cost. Report launch errors rather than planning manually.

The output is `plan.review/` beside the input spec. For `spec.reviewed/spec.reviewed.md`, it is a sibling of `spec.reviewed/`. An explicit `--output` overrides that location.

- `plan.reviewed.md`: file-level tasks, dependencies, unit/integration checklists and verification commands. Omitted if no structured plan was produced.
- `run-analysis.md`: reported cost and wall time per agent/turn, plus totals.
- `trace/`: original spec, guidelines, research, structured plan, validation results, prompts, outputs, tool activity and prior reports under `history/`.

Read `trace/review.json` to determine `ready`, `needs-author` or `incomplete`; eve process success alone is not plan approval. Summarize unresolved decisions and blockers, and link the plan and run analysis. If the run fails before export, show its log and do not present a previous report as current. No planned tests or implementation commands have been executed.
