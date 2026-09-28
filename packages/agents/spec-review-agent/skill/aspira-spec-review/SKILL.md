---
name: aspira-spec-review
description: Review a feature spec against its repository and Aspira engineering guidelines using the official spec-review-agent, then report findings, a reviewed spec, and cost breakdown. Use for /aspira-spec-review or requests to review a spec with this agent.
argument-hint: <spec.md> [--guidelines FILE]
---

# Spec review

Review intent and business acceptance criteria; technical unit/integration test planning belongs to `spec-to-plan`. Call the official `spec-review-agent`; do not perform a second review yourself. It runs frontier research, six parallel specialist reviews, then reconciliation. There is no elapsed-time limit on preparation or review. Loading a fresh Notion guidelines snapshot adds to the measured wait.

Use the absolute path to `scripts/spec-review.sh` beside this file. Run it from the reviewed repository, or pass `--repo /absolute/repository`.

```bash
<skill-dir>/scripts/spec-review.sh start <spec.md> [--guidelines /absolute/REQUIRED.md] [--repo /absolute/repository] [--output /absolute/output]
```

A supplied guidelines snapshot uses the direct CLI. Otherwise the eve entry point loads required guidelines from Notion; that loader requires configured credentials and its Docker sandbox. The launch helper needs Node 24, pnpm, screen, and the agent's shared environment. It resolves the package using `SPEC_REVIEW_AGENT_DIR`, then `$ASPIRA_KIT/packages/agents/spec-review-agent`, then its own package location. Never switch to the removed debate workflow or pass round caps.

The launcher detaches the review and prints its run/log directory. Tell the user it started and where results will go. Use `status <run-dir>` to check progress, or `wait <run-dir> --max 30` between updates; `watch` is a bounded alias for `wait`. The polling wait returns control without stopping the detached agent; keep checking until it finishes or the user cancels. Do not automatically retry failed or incomplete reviews, since that starts another paid run. If launch fails, report the error rather than reviewing manually.

Results are directly in `spec.reviewed/` beside the source spec unless an output directory was supplied:

- `spec.original.md`: unchanged source spec.
- `spec.reviewed.md`: proposed revised spec, only when valid edits were produced.
- `run-analysis.md`: wall time and reported cost per agent and model turn, plus totals.
- `trace/`: all debugging records, including `findings.md`, `decisions.md`, `checks.md`, `review.json`, `usage.json`, `calls.json` and `guidelines.md`. Prompts, outputs, tool activity and errors are retained here.

Reruns archive previous results in `spec.reviewed/trace/history/run-*/`. The source spec remains unchanged. Read the completed report, summarize findings and unresolved decisions, and link the reviewed spec, run analysis and trace/findings.md. `incomplete` or `needs-author` is not approval; consult `trace/review.json` even when the eve command exits successfully. If the process fails before exporting, show its log and do not present an earlier report as the new result.
