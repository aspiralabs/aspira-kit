# Agent runtime

## Intent

Let all Aspira agents finish their work without elapsed-time cutoffs while retaining explicit cancellation and honest cost and wall-time reporting.

## Acceptance criteria

### Features

- [x] F1: Research, specialist review, reconciliation, planning and preparation continue regardless of elapsed time; no agent or delegated session expires on an application timer.
- [x] F2: MCP and Notion reads have no application request deadline and still respond to caller cancellation. Transport and provider errors remain failures.
- [x] F3: Manual cancellation stops pending phases, preserves completed evidence and reports an incomplete result. Cost and wall time remain measured per turn, per agent and in total.
- [x] F4: Both slash-command skills describe uncapped runs. Status polling may return while the detached agent continues. Evaluation measures elapsed time without rejecting a complete review for its duration.

## Implementation and verification plan

- Remove phase budgets, SDK generation timeouts and preparation timers; disable eve session expiration in root agents and declared subagents.
- Add a tracked MCP SDK patch allowing timeout: false; keep the default behavior unchanged for other callers. Forward cancellation to MCP and Notion.
- Use fake-time tests to verify long phases and MCP requests survive their former limits, still complete, and cancel on request. Preserve integration tests for artifact layout and reported usage.
- Update current specs, README files and skill instructions. Run affected package tests, lint and type checks.

## Out of scope

Changing model selection, output/step limits, automatic retry policy, planning scope, or external provider/hosting limits.
