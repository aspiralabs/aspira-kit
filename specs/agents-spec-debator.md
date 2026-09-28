# packages/agents: spec-review-agent

> Historical design, superseded by `specs/agents-spec-review.md`. The debate/audit implementation has been removed.

Status: approved in scope (2026-09-21, verbal, D. Ludemann); text drafted by the agent, awaiting review. Verified end to end 2026-09-21 with a 1-round run (25 model calls, $1.26). Spec contract added 2026-09-24 (verbal, D. Ludemann), verified live 2026-09-25 across ten benchmark runs. Sam's default moved from `openai/gpt-6-astra` to `openai/gpt-6-sol` on 2026-09-25 (verbal, D. Ludemann) after that benchmark: same depth, 45% cheaper, 11% faster.

## Intent

Add `packages/agents/`, a folder of agent packages built on Vercel's eve framework, and ship the first one: `spec-review-agent` (`@aspiralabs/spec-review-agent`) with its `spec-debator` workflow. Given a markdown spec, two agents (Darren, Sam) debate it in writing until they agree on every aspect, then produce an updated spec and a plain-English summary of what they decided and why.

Why: rule zero says no spec, no code. A spec that has survived two adversarial readers is a better contract than one a single author wrote at midnight.

The debate also holds every spec to a floor, the spec contract: an intent, and acceptance criteria written as two checklists, the features that must exist and the tests that must be written to prove them. The tests come first and the code is done when they pass. That is how test-driven development is enforced: the reviewed spec is the test plan.

## Shape

`packages/agents/<name>/` is one pnpm package per agent (`pnpm-workspace.yaml` includes `packages/agents/*`); eve names the agent after the package minus scope. eve's own multi-agent workspace layout (`agents/<name>/agent/`) was tried first and rejected: in 0.63.0 a workflow tool in a workspace member compiles under `workflow//./agents/<name>/agent/tools/...` but registers at runtime under `workflow//./agent/tools/...`, so every call fails with "not registered as a workflow". `spec-review-agent` is one root agent with two declared subagents and one workflow tool.

```
packages/agents/spec-review-agent/agent/
├── agent.ts                      root orchestrator; tool: false (no self-copies)
├── instructions.md               how to take a spec in and hand the docs back
├── hooks/usage.ts                per-call token and cost ledger (shared module)
├── tools/
│   ├── load-repo.ts              defineTool: put a codebase at /workspace/repo for the debaters
│   ├── load-knowledge.ts         re-export of the shared tool in packages/agents/common: guidelines at /workspace/knowledge
│   ├── spec-debator.ts           defineWorkflowTool: the debate loop
│   └── export-debate.ts          defineTool: copy the sandbox artefacts to the host, write cost.md
├── lib/
│   ├── debate.ts                 pure helpers: prompts, schemas (testable without eve)
│   ├── contract.ts               the spec contract: prose for the prompts, checkContract() for the code
│   ├── contract.test.ts          vitest, `pnpm --filter @aspiralabs/spec-review-agent test`
│   ├── repo.ts                   pure helpers: repo source parsing, listing filter, shell commands
│   ├── repo.test.ts              vitest
│   ├── usage.ts                  pure cost aggregation
│   └── usage-hook.ts             the hook mounted on all three agents
└── subagents/
    ├── darren/  agent.ts · instructions.md · sandbox.ts · hooks/usage.ts
    └── sam/     agent.ts · instructions.md · sandbox.ts · hooks/usage.ts
```

- Darren runs on Claude, Sam on OpenAI, both through the Vercel AI Gateway. Same brief, different model; disagreement comes from the back-and-forth, not from assigned lenses.
- Both subagents share the root's sandbox (`defineSandbox(({ parent }) => parent.sandbox)`). The record is one file per turn under `/workspace/debate/`, names sorting in debate order, so two turns running at once never write the same file; `export-debate` stitches the folder into `conversation.md` on the host.
- Neither subagent is model-visible (`tool: false`). Only the workflow calls them, via `ctx.agent()`.
- Each round is a fresh child turn. eve's workflow `ctx.agent()` returns only the child's output; the runtime mints child ids internally and does not surface them, so continuing a child across rounds is not available. The debate folder is the memory, by design.
- Models and effort are per-run env: `DARREN_MODEL` / `SAM_MODEL` / `ORCHESTRATOR_MODEL` (resolved at session start), `DARREN_REASONING` / `SAM_REASONING` for debate turns and `*_WRITE_REASONING` for document turns (resolved per step from a `[turn: debate]` or `[turn: document]` marker on the prompt's first line), and `DEBATE_MODE=alternating|simultaneous` (read in a workflow step). Defaults: the shipped pair, provider-default effort, alternating.

## The loop

Input: `{ spec?: string, specPath?: string, title?: string, repoPath?: string, repoLabel?: string, maxRounds?: number }` (default 4, bounds 1..20). One of `spec` (markdown, verbatim) or `specPath` (a host path, read in a workflow step) is required.

## Codebase context

A spec is argued against the code it would land in. When the person names a codebase, the root calls `load-repo({ source })` before the workflow. A GitHub URL (optionally `/tree/<ref>`) or `owner/name` is shallow-cloned inside the shared sandbox (`GITHUB_TOKEN` from the environment for private repos; the token stays in the clone command and never in a result). A local path is listed on the host, git-tracked plus untracked-but-not-ignored files when it is a git repo, else everything minus `node_modules`, build output, and the like; the listing is filtered, tarred, and extracted in the sandbox. Either way it lands at `/workspace/repo`; the tool returns `{ path, label, fileCount, topLevel, skipped? }` and the root passes `path`/`label` to the workflow as `repoPath`/`repoLabel`.

The filter exists because `git ls-files -o` reports a nested repository (a git worktree, a vendored checkout, Claude Code's `.claude/worktrees/*`) as one directory entry, and tar walks a directory entry, `node_modules` and all. So: directory entries are never shipped, files over 2 MB are never shipped (the debaters read source, and nothing that size is source), tar runs with `--no-recursion` as a second guard, and the tarball is capped at 256 MB compressed with a running check. Skips are reported in `skipped` as one line per kind, naming the directories and the five largest files. A tree that still exceeds the cap fails with that same description, not a buffer dump.

With a repo loaded, every debate turn tells the debater where the code is and that findings about feasibility, blast radius, naming, or existing behaviour must cite a file path from it. The transcript header records the repo label and commit. The updated-spec writer verifies any file, component, or name it writes in exists in the repo. The debaters read; they never modify or run the code.

On Vercel only the GitHub form works; local paths are a laptop feature.

## Engineering guidelines

The org's guidelines live in Notion, one page per topic under an Engineering index page with an "Agents start here" page beneath it. `load-knowledge`, a shared tool in `packages/agents/common` mounted by both agents, walks that tree through Notion's markdown endpoint (`GET /v1/pages/{id}/markdown`, API version 2026-03-11) and writes it into the sandbox at `/workspace/knowledge`: the index as `INDEX.md`, each page as `<slug>.md` with a provenance header (title, source URL, fetch time, truncation flag), child-page tags rewritten to local links. Breadth-first, three levels deep, eighty pages at most; a page that fails to load is reported in `skipped`, one left unvisited by the caps in `notLoaded`. `NOTION_TOKEN` and `KNOWLEDGE_PAGE` configure it; unset, it returns `configured: false` and the orchestrator runs without guidelines and says so.

The orchestrator calls it before every debate and passes `path` to the workflow as `knowledgePath`. Every debate turn, the confirmation turn, and the updated-spec write then carry a guidelines section: read the index first, then "Agents start here", then what the spec touches; a guideline beats a preference; a spec or a proposed fix that contradicts one is a finding citing the file; where the guidelines are silent, argue on the merits. This is how org decisions that the debates kept re-deriving (pagination shape, favorite state, status models, entitlement enforcement) become lookups.

## Spec contract

The minimum a spec must carry, stated once in `lib/contract.ts` and used both as prose in the prompts and as a deterministic check:

- `## Intent`, non-empty.
- `## Acceptance criteria` (the heading `## Acceptance` is also accepted on input) with two checklists directly under it:
  - `### Features`: `- [ ]` items, one per behaviour the feature needs to be complete.
  - `### Tests`: `- [ ]` items, one per test to write, each prefixed `unit:` or `integration:`. Both kinds must appear. At minimum one test per feature, then the edge cases.

Other sections are welcome; these are the floor. Enforcement has three layers:

1. `checkContract(spec)` runs on the input in the workflow body (pure, so replay-safe). Its report goes into both round 1 prompts; every problem is a round 1 finding with the text that fixes it.
2. Every debate turn carries the contract and a test-coverage instruction: walk features against tests, propose a test for any feature without one, then invent edge-case tests (empty and boundary inputs, failure paths, concurrency, permissions, unicode and locale, retries). A debater may not return `agreed: true` while the spec with accepted findings applied would fail the contract.
3. The updated-spec writer must emit the exact headings, converting whatever the original used, and must turn every accepted test proposal into a `### Tests` item. The cross-review of `spec.updated.md` checks the contract again. `export-debate` runs `checkContract` on both `spec.md` and `spec.updated.md` (the workflow cannot reach the sandbox) and returns `contract: { input, updated }`; the orchestrator reports one line on it and, if the updated spec fails, lists the problems and says it is not ready to build from.

The check sees headings and checkboxes only. Whether the items are any good is the debaters' job.

1. Round 1: Darren saves the spec verbatim to `/workspace/spec.md` and writes `/workspace/debate/00-header.md`; both write their round 1 review from the spec text in the prompt.
2. Each turn: read `spec.md` and the whole debate folder, write a `## Round N — <name>` section (responses to the other's findings as accept/dispute with a reason, new findings with stable ids `D1.1`/`S2.3`…, position, status) to `round-NN-<name>.md`, and return structured output `{ agreed, openPoints, note }`.
3. Alternating mode: Darren then Sam; the round ends after Sam. Simultaneous mode: both at once, each answering the other's previous round; `agreed` then means every finding the seat ever raised is closed, it accepts everything the other side raised, and it raised nothing new. When exactly one seat agrees in a simultaneous round, the other gets one sequential confirmation turn (it has not yet seen the acceptances written alongside its own section): it reads the record, writes `round-NN-<name>_confirm.md`, may raise nothing new, and returns its status. Both agreed after that ends the debate; otherwise the next round runs. The result carries `confirmations`.
4. Stop when both report `agreed: true` in the same round, or when `maxRounds` is reached.
5. Final: Darren writes `/workspace/spec.updated.md`, Sam writes `/workspace/decisions.md`, in parallel. Then each reviews the other's document against `conversation.md` and corrects factual drift, in parallel.
6. Return `{ agreed, rounds, openPoints, files }`.

If the cap is hit, both documents are still written. `decisions.md` carries an `## Unresolved` section and the updated spec marks those items as open questions. The tool reports `agreed: false`. Hitting the cap is a failure of the debate, not a result.

The root agent then calls `export-debate`, which reads the four files from the sandbox and writes them to the host: next to the spec in `<name>.debate/` when a `specPath` was given, else `debates/<date>-<slug>/` in the package. It also aggregates the usage ledger into `cost.md` (tokens and Gateway-reported USD per agent, plus the raw `usage.jsonl`) and clears the ledger. The root replies with the outcome, the cost line, the file paths, and the decisions document.

## Claude Code skill

`skill/aspira-spec-review/` in the package is a Claude Code skill, so `/aspira-spec-review <spec.md> [--rounds N]` runs this agent from a session with its defaults. The spec is resolved from the session's directory, and that directory's git root is the codebase the debaters read. `scripts/spec-review.sh start` preflights (env file, Docker, `screen`, no live `eve invoke` or `eve dev` for this agent), moves workflow state with `running` records aside so they are not resumed and billed, and launches `eve invoke` in a detached `screen` session, because a debate outlives a tool call's time cap and a killed invoke leaves runs to resume. `watch` prints one line per debate turn as it lands in the sandbox (read with `docker exec`), with the spend so far from `usage.jsonl`, so a Claude Code Monitor streams the debate into the session while the session stays free. `wait` blocks up to nine minutes for harnesses without one, and `status` never blocks. All three print the agent's reply once the run has exited. The skill never kills a run. It finds the agent through `SPEC_REVIEW_AGENT_DIR`, then `$ASPIRA_KIT`, then its own location in the package, so a copy under `~/.claude/skills/` works too.

## Cost accounting

A `step.completed` hook, mounted on the root and on both subagents, appends one JSON line per model call to `/workspace/usage.jsonl` in the shared sandbox (via shell append, so concurrent Darren/Sam steps do not clobber each other). Hook failures are swallowed: losing a cost line must not fail a turn. `costUsd` comes from the AI Gateway per call; calls without a reported cost are counted and the total is labelled a lower bound.

## Out of scope

- Publishing the package or wiring it into the `kit` CLI. It is `private: true`, repo-local, in the changeset `ignore` list.
- A frontend, channels beyond the default eve HTTP/TUI channel, deployment to Vercel.
- Evals with real models. A deterministic smoke eval may come later.
- Using `@aspiralabs/config/agent/personas/debater.md` verbatim: that persona argues a diff against a spec. The spec-debator personas argue the spec itself. Shared rules (evidence, the spec is the contract, concede when out of evidence) are carried over.

## Acceptance criteria

### Features

- [ ] `pnpm --filter @aspiralabs/spec-review-agent typecheck`, `lint`, and `test` pass; `pnpm check` at the root still passes.
- [ ] `pnpm --filter @aspiralabs/spec-review-agent exec eve info` discovers agent `spec-review-agent` with tools `spec-debator`, `export-debate`, `load-repo`; subagents `darren`, `sam`, both hidden; a `usage` hook on all three.
- [ ] `load-repo` with a public GitHub URL and with a local git path both put the tree at `/workspace/repo` (no `._*` AppleDouble files, no `node_modules`) and report a commit hash.
- [ ] `load-repo` on a local git repo containing a nested repo or worktree (for example `.claude/worktrees/*` with `node_modules` inside) ships only the outer tree, names the skipped directory in `skipped`, and finishes in seconds.
- [ ] `load-repo` on a local tree with a file over 2 MB ships everything else and names the file and its size in `skipped`.
- [ ] With a repo loaded, `conversation.md` findings cite file paths from it.
- [ ] Running the agent with a small spec by path produces `<name>.debate/` next to it with `conversation.md` (alternating rounds), `spec.updated.md`, `decisions.md`, and `cost.md` with a non-zero USD total; the reply reports `agreed`, `rounds`, cost, and the contract line.
- [ ] The loop terminates at `maxRounds` when the two never agree, and still writes both documents.
- [ ] Given a spec with no `## Acceptance criteria`, round 1 of `conversation.md` contains a finding for it from Darren, and `spec.updated.md` has `## Intent`, `## Acceptance criteria`, `### Features`, and `### Tests` as `- [ ]` checklists with both `unit:` and `integration:` items.
- [ ] Given a spec whose tests checklist only restates its features, `conversation.md` contains proposed edge-case tests that are not in the input, and they appear in `spec.updated.md` under `### Tests`.
- [ ] `export-debate` returns `contract.input` and `contract.updated`, and the orchestrator's reply carries one line on them.
- [ ] With `NOTION_TOKEN` and `KNOWLEDGE_PAGE` set, `load-knowledge` writes `/workspace/knowledge/INDEX.md` plus one file per child page, links between them resolve to local files, and `conversation.md` cites at least one guideline file when the spec touches a topic the guidelines cover.
- [ ] With either var unset, `load-knowledge` returns `configured: false`, the debate runs, and the reply's last line says the guidelines were not loaded.
- [ ] `conversation.md` on the host is the debate folder's files in name order: header, then `round-01-darren`, `round-01-sam`, `round-02-darren`, and so on, in both modes.
- [ ] With `DEBATE_MODE=simultaneous`, each round's two child turns overlap in `usage.jsonl` timestamps and neither debater's file is overwritten by the other.
- [ ] With `DEBATE_MODE=simultaneous`, a round in which exactly one seat agrees is followed by one confirmation turn for the other seat, recorded as `round-NN-<name>_confirm.md` in the transcript right after that seat's round file, and the debate ends there if it confirms.
- [ ] With no reasoning env vars set, both debaters run debate and document turns at `low` and Sam runs on `openai/gpt-6-sol-fast`; a seat's env var overrides its turn kind, and `provider-default` hands the effort back to the provider. The cross-review is a drift check: it edits only dropped, reversed, invented, or side-taking text, and leaves contract structure to the export check.
- [ ] With `DARREN_REASONING=low` and `DARREN_WRITE_REASONING` unset, Darren's debate turns and its updated-spec turn run at different efforts (observable as a drop in output tokens per debate call against an unchanged write turn).

- [ ] `/aspira-spec-review <spec.md>` in a Claude Code session started in a repo runs this agent with that repo loaded and the default cap, and reports the agent's reply when the run exits. `--rounds N` passes a cap.
- [ ] `spec-review.sh start` refuses, with a message and no launch, when the spec is missing, `--rounds` is outside 1..20, the env file is missing, Docker is down, or a run for this agent is live. It does not refuse for a live run of a different agent.
### Tests

- [ ] unit: `checkContract` passes a spec with a non-empty intent and both checklists, including one with `unit:` and one with `integration:` items.
- [ ] unit: `checkContract` reports a missing `## Intent`, and separately an empty one.
- [ ] unit: `checkContract` reports a missing acceptance section and stops there (no subsection problems for a section that does not exist).
- [ ] unit: `checkContract` accepts `## Acceptance` and matches all headings case-insensitively.
- [ ] unit: `checkContract` reports a missing `### Features` and a missing `### Tests` under the acceptance section.
- [ ] unit: `checkContract` reports a subsection with prose or plain bullets but no `- [ ]` items.
- [ ] unit: `checkContract` accepts `[x]`, `[X]`, `*` and `+` bullets, and indented items.
- [ ] unit: `checkContract` reports a tests checklist with no unit item, and one with no integration item.
- [ ] unit: `checkContract` ignores a `### Tests` heading that sits under a different `##` section.
- [ ] unit: `checkContract` finds `Features` and `Tests` at any heading depth below the acceptance heading.
- [ ] unit: `checkContract` on a spec with no headings at all reports both top-level problems.
- [ ] unit: `renderContractReport` renders the passing line, and one bullet per problem otherwise.
- [ ] unit: `selectEntries` keeps files in order, skips directory entries, skips files over `MAX_FILE_BYTES` recording their size, skips non-files, and drops empty paths.
- [ ] unit: `describeSelection` is empty with nothing skipped, names skipped directories, lists skipped files largest first with sizes, and caps the list at five with an "and N more".
- [ ] unit: `parseRepoSource` handles a GitHub URL with `/tree/<ref>`, `owner/name`, and absolute and relative local paths.
- [ ] unit: `modelFor`, `modelsFrom`, `reasoningFor` (both turn kinds, every eve level, invalid ignored, case and whitespace tolerant), `debateModeFrom` (default alternating), and `lastUserText` (string and text-part content).
- [ ] unit: `roundFile` zero-pads and sorts in debate order after the header; `confirmFile` sorts right after the same seat's round file and before the next round; `turnKindOf` reads the marker and defaults to debate.
- [ ] unit: `confirmPrompt` is a debate turn, names the confirmation file, names the other seat, and forbids new findings.
- [ ] unit (in `packages/agents/common`): `pageIdFrom` reads dashed, bare, and URL-embedded ids and rejects a URL without one; `childPagesOf` lists page tags in order and ignores databases; `fileFor` slugifies under the knowledge folder and keeps colliding titles distinct; `rewriteLinks` maps fetched pages to local files and leaves others as URLs; `renderPage` prefixes provenance and flags truncation.
- [ ] unit: every prompt starts with its turn marker; turns name their own round file and the folder, never `conversation.md`; only Darren saves the spec and header in round 1; the simultaneous wording appears only in that mode.
- [ ] integration: `load-repo` against a local repo with a nested worktree returns `skipped` naming it and a `fileCount` matching the outer tree. (Manual; needs Docker.)
- [ ] integration: a 1-round live run on a spec missing its acceptance criteria ends with `contract.updated.conforms === true` in the export result and the contract line in the reply. (Manual; costs money.)
- [ ] integration: a 1-round live run on a spec whose tests only restate its features yields new `unit:` or `integration:` items in `spec.updated.md` that are absent from `spec.md`. (Manual; costs money.)
- [ ] integration: `spec-review.sh` rejects each bad input above, finds the agent from the package and from a copy with `ASPIRA_KIT` set, errors clearly from a copy without it, detects a live invoke for this agent only, and `status` prints running, the agent's reply on exit 0, and the log tail on a non-zero exit. (Manual; no model calls.)
- [ ] integration: `spec-review.sh watch` on a live run prints one line per turn file in order with a rising spend, then the agent's reply, and exits. (Manual; rides on a live run.)
- [ ] integration: `/aspira-spec-review` on a small spec with `--rounds 1` ends with the reply relayed and `<name>.debate/` next to the spec. (Manual; costs money.)

## Blast radius

New package only. `pnpm-workspace.yaml` gains `packages/agents/*`. Root `package.json` scripts are unchanged: `typecheck` and `lint` (`pnpm -r`) now include the agent; `build` and `test` filter on `./packages/*` and do not, so the agent's vitest suite runs only through its own `test` script. The spec contract adds one sentence to rule zero in `@aspiralabs/config/agent/constraints.md` (a config patch), so every project on the kit sees the same floor the agent enforces. `.changeset/config.json` ignores it. Requires Node 24 (already the local version) and an AI Gateway credential (`eve dev` `/login` with a Vercel account, or `AI_GATEWAY_API_KEY`).
