# Spec writer agent

The one spec step (KIT-48). Write mode turns a feature idea into a reviewed spec; review mode (from In Review: Spec, with `specPath`) reviews the answered spec again, so a spec is reviewed once per round and never by a second skill. Spec: `specs/agents-spec-writer.md`.

Write mode is two writer phases followed by the official spec review, unchanged:

1. **explore**: a frontier model with read-only repository and MCP tools finds the code, data, consumers, patterns, rules and open product questions the idea touches (ten tool rounds).
2. **draft**: a frontier model writes the initial spec in the Aspira contract (Intent, Approach, Constraints, Acceptance criteria with F-numbered Features, Assumptions, Out of scope, Blast radius). Every product choice the idea did not make is listed under Assumptions.
3. **review**: the draft goes through spec-reviewer's `runPipeline` (frontier research, six concurrent specialists, reconciliation) as the original spec, with the exploration added to the repository context. Code applies the reconciled edits to the draft.

The review half is imported from `@aspiralabs/spec-reviewer` (`lib/pipeline`, `lib/review`, `lib/models`), not copied, so the writer's review is the reviewer's review. Status means what it means there: `ready`, `needs-author` (open product choices, listed with options in `trace/decisions.md`) or `incomplete`. A failed explore or draft phase makes the run `incomplete`.

Default models: Claude Opus 5.5 for explore, draft and review research; OpenAI GPT-6.1 Sol for the specialists and reconciliation, all through the Vercel AI Gateway. Override the writer phases with `SPEC_WRITER_EXPLORE_MODEL` and `SPEC_WRITER_DRAFT_MODEL`; the review phases read spec-reviewer's `SPEC_REVIEW_*` variables.

## Run

Node 24+, `pnpm install`, and the shared `../.env.local` (symlinked as `.env.local`).

```bash
cd packages/ai/spec-writer
pnpm write /absolute/idea.md /absolute/repository /absolute/REQUIRED.md [/absolute/output]
```

Results go to `spec.reviewed/` beside the idea (or the spec) unless an output directory is given, in the reviewer's layout: `idea.md` and `spec.draft.md` (write mode), `spec.original.md` (review mode), `spec.reviewed.md` (when the review produced valid edits), `run-analysis.md` and `trace/` (exploration, findings, decisions, checks, prompts, outputs, usage). Reruns archive the previous report in `trace/history/`. The idea file is never edited. The CLI exits by run status: exit 0 is ready, 1 incomplete or blocked, 3 refused, 5 needs-author.

The eve entry point loads the required guidelines from Notion when no snapshot is given:

```bash
pnpm exec eve invoke "Write a spec from /absolute/idea.md for /absolute/repository; required guidelines snapshot: /absolute/REQUIRED.md"
```

## Calling skill

`/aspira-spec-writer <idea>` uses `skill/aspira-spec-writer/`. The idea can be a file, an `@` mention, a Notion page URL or inline text; the session writes non-file ideas to `specs/<slug>/idea.md` first. By default (`--cloud` launches the agent instead) every phase runs as a subagent of the calling Claude Code session through `pnpm run write:local <idea> <repo> [--guidelines FILE] [--output DIR] [--finish]` (`agent/lib/local.ts`), stage by stage: explore, draft, research, six specialists, reconciliation (review mode starts at research). Each task names the model it runs on. Without `--guidelines` it first prints a `knowledge` stage naming the Notion pages this agent's `load-knowledge` configuration would load (`KNOWLEDGE_PAGE`, `KNOWLEDGE_REQUIRED`); the session fetches them into `<out>.local/knowledge/` and the driver refuses to start until that folder is complete. Prompts are assembled at each step from `agent/lib/writer.ts` and spec-reviewer's prompt modules; the export records the rules used. It makes no model calls, needs no gateway key, and its report itemizes no cost. It is not an independent review: every phase runs on the session's model.

Symlink the skill directory into your tool's skills directory (for Claude Code, `~/.claude/skills/aspira-spec-writer`); the launcher resolves symlinked package paths.
