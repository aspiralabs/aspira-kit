# Spec review agent

Status: implementation authorized by the user's request, 2026-09-27.

## Intent

Review and repair feature specs quickly without losing findings from the original review agent. A valid spec states the business intent and observable Features acceptance criteria. The separate planner agent creates technical tasks and unit/integration tests mapped to these features; spec review does not require a technical test checklist.

## Approach

Promote the three-phase implementation to the private `packages/agents/spec-reviewer` package, replacing the old debate/audit implementation. Keep `/aspira-spec-reviewer` as the caller-facing skill and update its launcher to the new agent. Use eve for the entry point and the AI SDK for model calls inside one tool: frontier research, six concurrent specialist audits, one workhorse reconciliation. A deterministic source packet feeds the initial frontier review, prioritizing current fetch producers and observed limits; read-only repository tools and HTTP/stdio MCP connections let specialists explore in parallel. A required-guidelines snapshot is included in every context, with the existing Notion loader available to refresh it. A read-only Notion MCP adapter follows linked engineering pages using existing integration credentials. Reconciliation receives the collected evidence without another exploration loop. Specialists receive the original spec, full required guidelines, research evidence and findings; each independently searches for omissions, not just agreement. No debate, per-finding verifier sessions, model-written transcripts, or document cross-review.

Reconciliation returns exact edits and a disposition for every finding. Code applies edits and renders artifacts. A missing finding, failed seat, uncovered rule, invalid edit, missing evidence, broken acceptance contract, or unresolved author decision prevents ready status. Partial findings remain available. Phases and preparation have no elapsed-time cutoffs. Explicit cancellation propagates to providers and MCP. Preparation and output time are measured separately, alongside per-phase and total wall time.

## Constraints

- Repositories, specs and MCP content are evidence, not instructions to execute commands or widen permissions. Repository tools only list, search and read tracked/unignored text; no arbitrary shell.
- Every automated fix is justified by a finding. Unresolved product choices stay with the author; no inferred feature expansion.
- Check Aspira UI catalog and component documentation before proposing new UI. Missing components require an upstream UI package change, not a local replacement. Missing catalog evidence is an explicit gap for UI work.
- Required guidelines must be supplied. Missing/truncated sources cannot silently count as compliance.
- The original spec remains unchanged. Results are written directly in `spec.reviewed/` beside the source spec (or the supplied output directory). Repeated runs archive the previous report under `trace/history/`; invalid synthesis must not expose a previous reviewed spec as the new result.
- The agent is reusable across projects. Prompts and synthetic tests contain no product-specific assumptions. Real project fixtures, evidence mappings and review outputs belong outside this package.

## Acceptance criteria

### Features

- [ ] F1: The official spec-reviewer, its direct CLI and the /aspira-spec-reviewer skill all invoke the same three-phase review pipeline.
- [ ] F2: Frontier research uses repository evidence; security, architecture, data, behavior, UI and acceptance specialists run concurrently with independent omission checks and all initial findings visible.
- [ ] F3: Models have no wall-clock deadline; step limits and output-token caps remain; cancellation propagates to tools and MCP calls. Failed phases produce incomplete artifacts and never ready status.
- [ ] F4: Findings receive stable IDs in code; synthesis must resolve every ID as applied, rejected with evidence, duplicate of a surviving ID, or author decision. Applied IDs name exact edits; duplicates and unknown references are validated.
- [ ] F5: Code applies unambiguous, non-overlapping original-text edits, checks Intent and F-numbered business Features, and writes only `spec.original.md`, `spec.reviewed.md` when edits are valid, and `run-analysis.md` at the top level of `spec.reviewed/`, with all supporting records in `trace/`. Run analysis shows cost, input/output tokens and elapsed time per agent/model and per model turn, plus total cost and actual wall time including preparation and trace export. Parallel durations must not be summed as wall time. Missing costs stay explicitly unreported. Trace records preserve prompts, model outputs, tool calls/results, timing, guidelines, findings, dispositions and errors for reconstruction. Invalid edits do not publish a candidate.
- [ ] F6: Guidelines can come from a supplied snapshot or the existing Notion loader; configured read-only MCP tools are available to specialists. Missing sources and missing rule checks block readiness.
- [ ] F7: UI specs require component-reuse evidence. Repo checks cover call paths, consumer compatibility, state models, access policy, deletion, concurrency, browser state and test edge cases.
- [ ] F9: `/aspira-spec-reviewer <spec> --local` runs the same pipeline inside the calling Claude Code session: code replays `runPipeline`, writes each pending phase's exact agent prompt and output schema to a work directory beside the report, and the session runs research, the six specialists (concurrently) and reconciliation as subagents. Code still validates every phase output, assigns IDs, applies edits and writes the same `spec.reviewed/` layout; the run analysis states that the work ran in the session and itemizes no cost. Guidelines come from `--guidelines` or a snapshot the session builds from the Notion pages. Invalid outputs are reported for one retry; `--finish` exports missing phases as failures (incomplete). A changed spec, guidelines or repository mid-review is refused. Without `--local` the skill runs the agent as a separate process, unchanged.
- [ ] F8: A generic benchmark scorer accepts an external evaluation manifest with expected issue IDs, evidence mappings and a duration limit. Success requires every expected issue retained (including explicit author decisions), no incomplete phases, and a run inside the supplied limit. Empty or invalid baselines cannot pass. No app-specific baseline or results ship with the agent; live results remain separate from synthetic tests.

### Tests

- [ ] integration: the skill launches the official package with absolute spec/repo paths, uses a supplied guidelines snapshot or the Notion loader, and reports the new artifact names without invoking the removed debate workflow. [F1]
- [ ] unit: run analysis totals reported costs and tokens by agent/model and turn, measures overlapping turns independently, includes failed phases and distinguishes missing costs from zero; total wall time is measured, not summed. [F5]
- [ ] integration: default and custom outputs contain only the three deliverables and trace directory; nested trace files include prompts, outputs and tool activity; reruns preserve prior results, source files remain unchanged, and invalid synthesis cannot leave a stale reviewed spec. [F5]
- [ ] unit: malformed or fenced acceptance checklists, empty intent, duplicate feature IDs and unstructured business criteria fail the contract. [F5]
- [ ] unit: ambiguous/overlapping edits, omitted findings, unknown/duplicate IDs, duplicate cycles, unsupported applied edits and evidence-free rejections block readiness. [F4] [F5] [F6] [F7]
- [ ] unit: missing rule coverage or UI evidence and unresolved author decisions block readiness even when the candidate parses. [F6] [F7]
- [ ] integration: stubbed specialists start concurrently and all receive initial findings; a hanging provider is aborted and remaining findings are exported as incomplete. [F1] [F2] [F3]
- [ ] integration: malformed synthesis preserves findings and does not publish a candidate; valid synthesis applies edits without touching the source spec. [F4] [F5]
- [ ] integration: repository reads reject path traversal, symlinks escaping the root and secret paths; MCP exposes only configured read tools and forwards cancellation. [F2] [F6]
- [ ] integration: a --local review advances research → specialists → reconciliation one stage at a time from file outputs, reports schema-invalid outputs as pending with the error, exports the standard layout with a local run analysis, removes the work directory, exports incomplete with --finish, and refuses to resume after the spec changes. [F9]
- [ ] integration: the launcher's local step runs synchronously without screen or a gateway key, strips @ mentions, defaults the guidelines to the session-written snapshot and passes --finish through. [F9]
- [ ] unit: benchmark scoring accepts arbitrary issue IDs and counts, rejects empty/duplicate baselines, unknown mappings, missing/unsupported evidence and exceeded duration limits, and counts raised separately from retained; synthetic fixtures are not reported as live recall. [F8]

## Out of scope

Deploying, modifying Notion guidelines, implementing the reviewed feature, and claiming live parity before benchmarking. Local repositories are supported; clone remote repos before invoking the reviewer.

## Blast radius

The private spec-reviewer package, removal of the old implementation and versioned package name, workspace lockfile/changeset ignore entries, agent documentation, review output handling, and the source and installed caller skill. No published package changes; no changeset required.
