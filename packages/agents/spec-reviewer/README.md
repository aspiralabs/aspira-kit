# Spec review agent

The official private Aspira spec reviewer. The three-phase implementation replaces the original debate/audit agent. Spec: `specs/agents-spec-reviewer.md`.

The reviewer has three model phases: frontier research → six simultaneous specialist reviews → structured reconciliation. Each specialist sees the original spec, all required rules and initial findings, then checks for omissions through its own lens. Security, architecture, data semantics, behavior, UI and acceptance check the supplied spec against repository evidence and engineering guidelines.

A deterministic source packet supplies spec-referenced code, schemas, auth policy and direct imports to the frontier reviewer. It follows literal fetch URLs to current producers, prioritizes them ahead of long documents and extracts source-backed result caps so migrations do not hide existing truncation. Specialists explore the repository and live MCP sources in parallel. A workhorse model reconciles their evidence in one structured response with medium reasoning and an explicit check that requirements survive the rewrite; code validates and renders its edits.

The AI SDK handles review calls inside one eve tool. These are independent model contexts, not eve child sessions: no extra child-session scheduling, verifier-per-finding sessions or model-written transcripts. Defaults use Opus 5.5 for initial research and GPT-6 Sol for specialists and reconciliation. Override them with `SPEC_REVIEW_FRONTIER_MODEL`, `SPEC_REVIEW_SPECIALIST_MODEL` and `SPEC_REVIEW_RECONCILIATION_MODEL`.

Research, parallel audits, reconciliation and preparation have no elapsed-time limit. Calls retain step limits, output caps, no automatic retries, and explicit cancellation passed to providers and MCP. Wall time and cost are measured without terminating slow work.

Code assigns finding IDs, checks every disposition and evidence-gap resolution, applies exact original-text edits and renders artifacts. A missing finding, missing rule coverage, invalid edit, failed phase or missing UI evidence returns `incomplete`. Unresolved product choices return `needs-author`. `ready` means the review checks passed, not that a human approved the spec or its tests were run. Semantic evidence quality remains a model judgment; deterministic checks cannot prove that a proposed fix resolves a business issue.

## Run

Node 24+, dependencies installed with `pnpm install`. The direct CLI needs no Docker or eve server. `pnpm review` loads the shared `.env.local` and optional package `.env.development.local` for MCP/model settings. It accepts a local Git repository and a complete required-guidelines markdown snapshot. The snapshot is loaded once and included in every review context; repo data is indexed once, with paths and line numbers available to read-only tools.

```bash
cd packages/agents/spec-reviewer
pnpm review \
  /absolute/spec.md /absolute/repository /absolute/REQUIRED.md /absolute/output
```

Omit the output argument to write directly in `spec.reviewed/` beside the source spec. A supplied output directory is used directly. Reruns archive the previous report in `<output-directory>/trace/history/run-*/` before publishing the new one. Existing directories without a review trace are not replaced. The source spec is never edited. Exit 0 means ready; exit 1 means incomplete or needs-author. Ctrl-C aborts review calls and preserves already completed findings where possible.

For the eve interface, use the shared agent shell helper or:

```bash
pnpm exec eve invoke "Review /absolute/spec.md against /absolute/repository; required guidelines snapshot: /absolute/REQUIRED.md"
```

Without a supplied snapshot, the eve router calls the existing `load-knowledge` tool using `NOTION_TOKEN`, `KNOWLEDGE_PAGE` and optional `KNOWLEDGE_REQUIRED`. This fallback walks Notion pages and is outside the direct review budget; use a current snapshot for repeat benchmark runs. A `requiredHostFile` from an existing review is accepted. Snapshot provenance/fetch time is preserved in `guidelines.md`; refresh it when guidelines change.

## Calling skill

`/aspira-spec-reviewer <spec.md>` uses `skill/aspira-spec-reviewer/`. Its launcher resolves this official package and starts the three-phase review. Pass `--guidelines /absolute/REQUIRED.md` for the direct CLI, or omit it to load guidelines through eve. `--repo` and `--output` are optional; debate and round flags are removed. It reports `spec.reviewed.md`, `run-analysis.md` and `trace/findings.md` in the output directory.

`/aspira-spec-reviewer <spec.md> --local` runs the same pipeline in the calling Claude Code session instead of this package's models. `pnpm review:local <spec> <repo> <REQUIRED.md> [out] [--finish]` (and the launcher's `local` step) replays `runPipeline` from `agent/lib/local.ts`: it validates phase outputs found in `<out>.local/outputs/`, writes the exact prompt and JSON Schema for each phase still missing to `<out>.local/prompts/`, and stops at that stage. The session runs those phases as subagents and calls it again. When every output is present, it writes the standard report (`trace/review.json` has `mode: "local"`; `run-analysis.md` itemizes no cost) and removes the work directory. It makes no model calls and needs no gateway key or Docker. It is not an independent review: every phase runs on the session's model.

Keep installed skill copies synchronized with this directory, or symlink the skill directory into your tool's skills directory. The launcher resolves symlinked package paths. Model overrides use `SPEC_REVIEW_*`; legacy `V3_*` overrides remain accepted as fallbacks.

## MCP and UI

The current local checkout has a gitignored `.env.development.local` connecting both this repo’s built UI server and the Notion adapter. Both live connections were verified. For other machines, configure them from `.env.example`.

`MCP_READ_CONNECTIONS` is a JSON array of read-only allow-lists. See `.env.example` for HTTP bearer auth and local stdio examples. Specialists share these connected tools; research and reconciliation contexts receive collected source evidence. Configure actual tool names from your server; an unavailable configured tool fails preparation. MCP payloads are treated as evidence and oversized responses are marked truncated. Tokens stay in environment variables.

A UI review must include successful `list_components` and `get_component` reads; a model merely claiming it read the docs is insufficient. The local Aspira UI MCP server works over stdio (`node /absolute/path/to/@aspiralabs/ui/bin/mcp.js`). Use the version installed by the reviewed project when possible, and build it first when pointing at this source repository. Calls can list components, retrieve their docs, search, read tokens and patterns. UI work without catalog/component evidence cannot be marked ready. Missing components call for an upstream UI kit change.

The included `scripts/notion-mcp.ts` is a small read-only MCP adapter over the existing Notion REST integration. It exposes `list_guidelines` and `read_guideline`, using `NOTION_TOKEN` and `KNOWLEDGE_PAGE`. Reads are scoped to the configured engineering index and pages discovered through its links, cached within a run, and carry source/fetch provenance. It exposes no write tools. Stdio connections forward secrets only through the configured `envVars` allow-list.

This is separate from the official hosted Notion OAuth MCP and from a Codex connector. No new Codex connection is needed with the existing integration. You can alternatively configure an HTTP MCP endpoint and its runtime credentials. Check both live connections with `pnpm mcp:check`. The required-guidelines snapshot remains mandatory; live MCP lets specialists follow relevant topics without crawling the entire project before every review.

## Artifacts and evaluation

The top level contains only `spec.original.md`, optional `spec.reviewed.md`, `run-analysis.md` and `trace/`.

`run-analysis.md` reports total wall time and reported cost, with separate tables per agent/model and per model turn. Each turn records a start offset, elapsed time, input/output tokens, cost and completion status. Parallel durations overlap; total wall time is measured from runner entry through trace export, excluding the final summary writes and atomic publication. Preparation, review and export timing are shown separately. Eve routing and any guideline loading before runner entry are outside this measurement. Missing cost reports are not treated as free calls.

`trace/` contains `findings.md`, `decisions.md`, `checks.md`, `review.json`, `guidelines.md`, `usage.json` and `calls.json`. Findings remain available when synthesis fails. The review record preserves phase timings, model IDs, source commit/dirty flag, gaps and dispositions. Call traces preserve the system prompt, phase prompts, outputs and errors. Turn records preserve message context, model text, tool calls/results, timings, tokens and provider cost metadata so the sequence can be reconstructed. Interrupted providers may not report all usage.

The candidate uses `F1:` business acceptance IDs. Each criterion describes an observable outcome, including permissions and relevant failure cases. Technical unit/integration test checklists are generated by `planner`, which maps them back to these IDs and orders tests before implementation. Existing technical test notes are retained as planning input. Legacy guideline wording requiring test checklists inside the spec is superseded by this workflow split; other engineering requirements still apply.

Evaluation is project-independent. Keep real project specs, baselines, mappings and run artifacts in the reviewed project or another directory outside this package. Unit tests use synthetic inputs; they do not establish live review recall or latency.

Supply an external evaluation manifest with your expected issue IDs and human-reviewed evidence mappings:

```json
{
  "expectedIssueIds": ["ACCESS-1"],
  "mappings": [
    {"id":"ACCESS-1","findingId":"R2","raisedQuote":"exact text from finding","resolutionQuote":"exact candidate or author-decision text"}
  ]
}
```

```bash
pnpm score /absolute/run-directory /absolute/evaluation.json
```

Success requires every expected issue retained, a complete run and elapsed time below the supplied limit. Empty or duplicate expected IDs are invalid. Scoring separates raised from retained findings and verifies that quoted evidence exists; a human must judge whether the quotes actually resolve each issue. Optional `additionalEvidence` rows support issues spanning several findings, with every row required to have retained evidence. Mappings must be reviewed again for each run. A partially resolved author finding can retain a safeguard in the candidate and its remaining choice in the decision; either artifact can provide evidence. See `specs/agents-spec-reviewer.benchmark.md` for the evaluation protocol.

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm exec eve info
```

A single eve tool is one replay unit: an interruption before the tool completes may cause a new paid run if explicitly retried. Archived output directories preserve prior artifacts. This package is private and does not require a changeset.
