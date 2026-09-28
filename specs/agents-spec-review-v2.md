# packages/agents: spec-review-agent v2, research, audit, mediate

> Historical design, superseded by `specs/agents-spec-review.md`. The debate/audit implementation has been removed.

Status: drafted 2026-09-27 by the agent from five benchmark runs on one spec, awaiting review. Supersedes the two-seat debate loop in `specs/agents-spec-debator.md` as the default; the loop stays available behind `SPEC_REVIEW_MODE=debate` until v2 has beaten it three times.

## Intent

Make spec review fast and complete at the same time. Today one frontier model (Darren, Opus 5.5) and one fast model (Sam, Sol-fast) debate a spec for three or four rounds. Five runs on the same spec show where the time and the misses come from, and neither is the debate itself:

- A frontier model given the project gotchas and the org's review rules produces 13 to 22 grounded findings in about 90 seconds for 35 cents. That step is cheap and reliable.
- Every long run was one fast-model call reasoning to a 29,000-token ceiling after ingesting the rules, four to thirteen minutes each, in a different round every time. The serial rounds mean one such call stalls everything.
- Every miss was an attention failure, not a knowledge failure. One head holding many rules can skip ambiguous domain terms, weaken access-control requirements during agreement, or overlook concurrency.
- Product choices that belong to the spec's author (must Phase 0 paginate?) were settled five different ways in five runs by whichever seat conceded first.

v2 keeps what worked and removes the serial loop. The frontier model researches first and mediates last. In between, a set of fast, narrow seats each audit the spec against one group of rules using the research dossier as evidence, in parallel, and a verifier checks every finding against the code. Nothing runs in rounds. A seat that stalls is reported and skipped, not waited for. Choices that are the author's are listed for the author, not settled.

Success: on an externally supplied benchmark, a run retains at least 87% of expected issues, ends inside six minutes wall clock, and costs no more than the two-seat loop on the same inputs. Keep project-specific fixtures and results outside this repository; see `specs/agents-spec-review-v2.benchmark.md` for the protocol.

## Shape

Same package, one new workflow tool, four new subagents, two new pure modules. Darren and Sam remain; Sam becomes the verifier.

```
packages/agents/spec-review-agent/agent/
├── tools/
│   ├── spec-debator.ts         v1 loop, unchanged, behind SPEC_REVIEW_MODE=debate
│   ├── spec-audit.ts           NEW defineWorkflowTool: research → audit → verify → mediate
│   └── export-debate.ts        also exports dossier.md and checks.md; checks rule coverage and carry-through
├── lib/
│   ├── audit.ts                NEW pure: seat table, rule-group mapping, prompts, output schemas, coverage and carry-through checks
│   └── dossier.ts              NEW pure: dossier section shape, identifier extraction from a spec
└── subagents/
    ├── darren/                 researcher and mediator (frontier)
    ├── sam/                    verifier (fast, other vendor)
    ├── finn/   facts           NEW fast seat
    ├── nova/   data flow       NEW fast seat
    ├── ava/    security        NEW fast seat
    └── bea/    blast radius    NEW fast seat
```

Reba, the tests and contract seat, is Darren in the mediation phase: the contract check is deterministic already, and test proposals need the whole picture.

### Seats and rule groups

The org's review rules live in Notion (Review Verification, prefix `REV`) and reach the sandbox through `load-knowledge` as `REQUIRED.md`. v1 handed every seat the whole file and asked for a Checks line per rule; the fast model then reasoned about all 23 at once. v2 gives each seat only its group, inlined into its prompt, with the rule text verbatim.

| Seat | Model (default, env override) | Rule group (REV page headings) | Also reads |
| --- | --- | --- | --- |
| Darren | `anthropic/claude-opus-5.5`, `DARREN_MODEL` | all, as researcher; `Writing the finding` as mediator | AGENTS.md Gotchas, the whole repo |
| Finn | fast, `SEAT_MODEL` | `Existence and usage`, `Current behavior` | dossier identifier table |
| Nova | fast, `SEAT_MODEL` | `Data flow completeness` | dossier call graph and consumers |
| Ava | fast, `SEAT_MODEL` | `Security and authorization` | dossier auth policy and sibling routes |
| Bea | fast, `SEAT_MODEL` | `Blast radius and compatibility` | dossier callers and clients |
| Sam | `openai/gpt-6-sol-fast` at `minimal` reasoning, `SAM_MODEL` / `SAM_REASONING` | none; verifies every finding | the code each finding cites |

`SEAT_MODEL` defaults to `anthropic/claude-haiku-4.5`. The rule-group mapping is `SEAT_RULES` (JSON, seat name to heading list) so a renamed Notion heading is a config change, not a code change. A heading in `SEAT_RULES` that is not in `REQUIRED.md` fails the run at load, the same way a missing required page does.

A rule the seats do not cover is a gap in the rules, not in the seats. Two are known and are prerequisites for the benchmark: a rule for concurrent writes (two hearts at once must not 500) and a rule for browser state (search, sort and filter survive reload and back). Both go on the REV page before the first benchmark run.

## The pipeline

Input is unchanged: a spec path or pasted spec, an optional codebase via `load-repo`, and `load-knowledge` always. `spec-audit` takes what `spec-debator` took, minus `maxRounds`, plus `seatTimeoutMs` (default 180,000).

1. **Research.** Darren reads `REQUIRED.md`, the repo's `AGENTS.md` or `CLAUDE.md` with its Gotchas, the spec, and every prerequisite spec the spec names. Darren writes `/workspace/dossier.md` (shape below) and `/workspace/audit/darren.md`, his own findings in v1's finding format. One model session, roughly 90 seconds by today's numbers. Darren does not write Checks; the seats do.
2. **Audit.** Finn, Nova, Ava and Bea run in parallel. Each gets the spec, the dossier, the Gotchas, Darren's findings, and its own rule group verbatim. Each returns a structured result (schema below) and writes `/workspace/audit/<seat>.md`. A seat confirms a Darren finding by id rather than restating it, adds its own, and fills one row per rule in its group. A seat that has not returned by `seatTimeoutMs` is recorded as `timed out` in `checks.md`; the run proceeds without it.
3. **Verify.** For every finding from Darren and the seats, Sam reads the code at the path and line cited, and rules `confirmed`, `adjusted` (with what moved and why), `rejected` (the code does not say that, or the spec already says it), or `duplicate` (names the id that survives). Findings are batched per source seat so Sam runs in parallel with itself, five sessions at once. Sam raises no findings. A finding with no file and line, and no spec quote, is rejected without reading further.
4. **Mediate.** Darren reads everything: dossier, all seat files, Sam's rulings. He dedupes, applies Sam's rulings, and sorts every surviving finding into one of two bins. **Settled**: the fix follows from the code or the rules, and goes into the spec. **Author's call**: two valid fixes exist and choosing between them is a product or scope decision, or the spec is silent on something only the author can answer. Author's calls are not settled by Darren; they go into `decisions.md` under `## Decisions for the author`, each with the options and what each costs. Darren then writes `spec.updated.md` and `decisions.md` as v1 does. Sam cross-checks `spec.updated.md` against the findings as v1 does.
5. **Export.** `export-debate` copies `spec.md`, `dossier.md`, `checks.md`, `conversation.md` (research, then each seat, then Sam, then mediation, concatenated), `spec.updated.md`, `decisions.md`, `cost.md`, `usage.jsonl`. It runs three deterministic checks and returns them: the spec contract (as today), **rule coverage** (every rule id in every seat's group has a row in that seat's result, or the seat is marked timed out), and **carry-through** (every finding Sam confirmed or adjusted appears by id in `decisions.md`, and every settled one is reflected in `spec.updated.md` by the spec text the finding proposed or a line naming the finding). A dropped finding is listed, not silently lost. This is the fix for a check that fired and a finding that was quietly generalized away.

No rounds. Total model sessions: Darren twice, four seats once, Sam five plus one, so about twelve, all but two on fast models, and the four seats plus Sam's five run concurrently.

### The dossier

`dossier.md` is what makes fast seats reliable: they check evidence instead of hunting for it. Sections, each a table or list with file and line:

- **Identifiers**: every backticked path, symbol, route, config key and env var the spec names; whether it exists; how many places import, call or render it, with the search that was run. This is the deterministic references check the loop never had, done by the researcher with `rg`.
- **Call paths**: for each thing the spec changes, the chain from UI to fetch to route to query, with limits, defaults and ordering found along it.
- **Producers and consumers**: every response shape the spec touches, who produces it, who consumes it, and which consumers cannot redeploy with the server.
- **Shared components**: every caller of each shared component the spec touches and the props each passes.
- **Auth and siblings**: the auth policy entry for every route touched or relied on, and the most similar existing route with the filters it applies.
- **State and enums**: every enumerated value the spec filters on, the columns that make up that state, the helper that decides it, and every code path that transitions it.
- **Prerequisites**: every other spec or helper named, its status, and whether it provides what this spec assumes.
- **Gotchas**: the project's Gotchas section verbatim.

Darren fills what the spec makes relevant and writes `none` for a section that does not apply. A seat may run its own searches when the dossier is thin, and says so in the row.

### Seat output

Each seat returns, and writes as markdown:

```
## <Seat> (<lens>)

### Checks
| Rule | Verdict | Evidence | Finding |
| REV-014 | ran | auth.config.ts:43 lists export with no permission | A1.2 |
| REV-015 | ran | sibling /search applies blockedAuthorSqlFilter at search/route.ts:111; favorites route omits it | A1.3 |
| REV-016 | skipped | no relationship created by this spec | |

### Findings
**A1.2 — <title>.** Spec: "<quote>". Evidence: <file:line>. Fix: <the exact spec text to add or change>.

### Confirms
D1.4, D1.5 — <one line each on what the seat checked>
```

Verdict is `ran`, `skipped` with a reason, or `no finding` with the evidence that cleared it. Finding ids are `<SEAT letter>1.<n>`. The structured result mirrors the table so coverage is checked by code, not by reading.

### Checks carry through

`checks.md` is the union of every seat's table plus Sam's ruling per finding and the mediation bin. One place to see, per rule, whether it ran, what it found, whether the finding survived verification, and where it landed. A person reading it can tell in one pass which rules did work this run and which never fire, which is how the REV page gets pruned or extended.

## Speed budget

The target is six minutes wall clock on the benchmark. Budget by phase, from measured v1 numbers: research 90 seconds, audit 60 (parallel, fast models), verify 60 (parallel), mediate and write 90, cross-check and export 30. Slack: 30 seconds.

The known failure is a fast model reasoning to its output ceiling. Three mitigations, in order: seats get one rule group and a dossier, so there is less to reason about; the verifier runs at `minimal` reasoning; and `seatTimeoutMs` bounds what any one seat can cost the run. eve has no per-call output cap or timeout, so the bound is a workflow race against a sleep, and a seat that loses the race is reported, not killed. Its session may finish later and its ledger entries still count in `cost.md`.

## Cost accounting

Unchanged: `hooks/usage.ts` on every agent, `cost.md` by agent and by session. `cost.md` gains a `Timed out` column so a seat that missed the budget is visible next to its spend.

## Skill

`/aspira-spec-review` runs `spec-audit` by default. `--debate` runs the v1 loop. The `watch` subcommand's turn lines become phase lines: `research done`, `audit: finn, nova landed`, `verify done`, `documents written`.

## Out of scope

- Changes to `pr-review-agent`. It already has the seat-plus-verifier shape; if v2 proves out, aligning the two is its own spec.
- Editing the REV page from the agent. Rules are written by people; `checks.md` tells them what to write.
- Interactive follow-up with the author on their decisions. They are listed; the person answers in the spec.
- Evals with real models beyond the one benchmark spec named here.
- Removing `spec-debator`. It stays until v2 has beaten it on three specs.

## Acceptance criteria

### Features

- [ ] `spec-audit` exists as a workflow tool in `spec-review-agent`, takes what `spec-debator` takes minus `maxRounds` plus `seatTimeoutMs`, and the orchestrator calls it by default; `SPEC_REVIEW_MODE=debate` selects `spec-debator` instead.
- [ ] Darren's research phase reads `REQUIRED.md`, the repo's `AGENTS.md` or `CLAUDE.md`, the spec, and every prerequisite spec the spec names, then writes `/workspace/dossier.md` with the eight sections above, each filled or marked `none`, every claim with a file and line or the search that was run.
- [ ] Darren's research phase writes `/workspace/audit/darren.md` with findings in the v1 format and no Checks section.
- [ ] Finn, Nova, Ava and Bea exist as hidden subagents on `SEAT_MODEL` (default `anthropic/claude-haiku-4.5`), each prompted with the spec, the dossier, the Gotchas, Darren's findings, and only its rule group, with the rule text inlined verbatim from `REQUIRED.md`.
- [ ] `SEAT_RULES` maps each seat to REV page headings; a heading that does not exist in `REQUIRED.md` fails the run before any seat runs, naming the heading and the headings that do exist.
- [ ] The four seats run concurrently and each returns the structured result mirroring its Checks table, Findings and Confirms, and writes `/workspace/audit/<seat>.md` in the shape above.
- [ ] A seat that has not returned within `seatTimeoutMs` is recorded as `timed out` in `checks.md` and `cost.md`, and the run proceeds to verification without it.
- [ ] Sam verifies every finding from Darren and the seats, batched by source seat and run concurrently, ruling `confirmed`, `adjusted`, `rejected` or `duplicate` with the file and line read; a finding with no file, line or spec quote is rejected unread; Sam raises no findings.
- [ ] Sam runs at `minimal` reasoning by default for verification (`SAM_REASONING` overrides).
- [ ] Darren's mediation phase applies Sam's rulings, dedupes, and bins every surviving finding as settled or author's call; author's calls appear in `decisions.md` under `## Decisions for the author` with the options and their costs, and are not written into `spec.updated.md` as settled.
- [ ] `spec.updated.md` meets the spec contract and names, for every settled finding, the spec text that resolves it.
- [ ] `checks.md` lists every rule in every seat's group with the seat's verdict and evidence, Sam's ruling on any finding it produced, and the mediation bin.
- [ ] `export-debate` returns `coverage` (rule ids with no row, per seat, empty when complete or the seat timed out) and `carryThrough` (confirmed or adjusted finding ids absent from `decisions.md`, and settled ids absent from `spec.updated.md`), and the orchestrator reports both when non-empty.
- [ ] `export-debate` writes `dossier.md` and `checks.md` alongside the v1 files, and `conversation.md` concatenates research, each seat, Sam, and mediation in that order.
- [ ] `cost.md` gains a `Timed out` column per session.
- [ ] The REV page carries a rule for concurrent writes and a rule for browser state before the benchmark run, and `SEAT_RULES` assigns them.
- [ ] `/aspira-spec-review` runs `spec-audit` by default, `--debate` runs the loop, and `watch` prints phase lines.
- [ ] Benchmark: on an externally supplied spec and pinned repository, one run retains at least 87% of the externally defined expected issues, completes in six minutes or less wall clock, and costs no more than the original two-seat loop on the same inputs.

### Tests

- [ ] unit: `dossier.ts` extracts every backticked path, symbol and route from a spec, once each, and ignores fenced code blocks and prose words in backticks that contain spaces.
- [ ] unit: `audit.ts` builds each seat's prompt with exactly its rule group's text from a `REQUIRED.md` fixture, including a rule whose body spans several lines, and no other group's rules.
- [ ] unit: `audit.ts` rejects a `SEAT_RULES` value naming a heading absent from the fixture with an error that lists the missing heading and the headings present; accepts case and whitespace differences in headings.
- [ ] unit: `audit.ts` coverage check reports the rule ids with no row per seat; a fixture with every id present reports empty; a timed-out seat reports empty with `timedOut: true`.
- [ ] unit: `audit.ts` carry-through check reports a confirmed finding id absent from `decisions.md`, an adjusted id absent from it, and a settled id whose proposed text and id are both absent from `spec.updated.md`; ids that are present, and rejected or duplicate ids, are not reported.
- [ ] unit: seat output schema rejects a Checks row whose verdict is not `ran`, `skipped` or `no finding`, a `ran` row with empty evidence, and a `skipped` row with no reason.
- [ ] unit: the mediation prompt names both bins, forbids settling an author's call, and requires `## Decisions for the author` in `decisions.md` when any exist and its absence when none do.
- [ ] unit: the research prompt names the Gotchas file, the dossier sections, and `REQUIRED.md`, and tells Darren not to write a Checks section.
- [ ] unit: the verifier prompt tells Sam to reject a finding with no file, line or spec quote without reading further, and to raise no findings.
- [ ] unit: `debateModeFrom`-style resolution of `SPEC_REVIEW_MODE` returns `audit` by default, `debate` for `debate`, and `audit` for anything else.
- [ ] unit: `cost.md` renders a `Timed out` column and marks the session that the workflow reported as timed out.
- [ ] unit: `conversation.md` stitching orders research, seats alphabetically, Sam, mediation, and omits a timed-out seat's file when absent.
- [ ] integration: the workflow with stubbed seats where one seat never returns proceeds after `seatTimeoutMs`, marks that seat timed out in `checks.md`, and still writes `spec.updated.md` and `decisions.md`.
- [ ] integration: the workflow with stubbed seats where Sam rejects a Darren finding produces a `decisions.md` that does not contain that finding and a `carryThrough` result that is empty.
- [ ] integration: the workflow with stubbed seats where Sam confirms a finding that mediation omits reports that id in `carryThrough`, and the orchestrator's reply names it.
- [ ] integration: the workflow with two seats proposing conflicting fixes for the same spec line produces one entry under `## Decisions for the author` with both options and no corresponding change in `spec.updated.md`.
- [ ] integration: `load-knowledge` followed by `spec-audit` with `SEAT_RULES` naming a bogus heading fails before any seat session starts, and the ledger shows only the research session's calls or none.
- [ ] integration: a run with `SPEC_REVIEW_MODE=debate` produces v1's files and no `dossier.md` or `checks.md`.
- [ ] integration: `export-debate` on a fixture sandbox reports contract, coverage and carry-through together, and writes all eight files.
- [ ] integration: an external benchmark run is scored against its expected issue IDs and meets the three thresholds in the last Feature; record the score, wall clock, cost and date in that external evaluation workspace.

## Blast radius

Package-local plus the skill. No published package changes and no changeset: `@aspiralabs/spec-review-agent` is private. Two new REV rules on the Notion page, written by a person. `packages/agents/README.md` gains the new tool and subagents. The v1 loop and its tests are untouched.

The benchmark file `specs/agents-spec-review-v2.benchmark.md` is the list of 30 issues from the five runs, one line each with the rule that should catch it, and is the fixture the last two acceptance items score against. It is written with this spec.
