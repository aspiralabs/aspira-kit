# Every list handed to a human is sorted, explained and comes with a recommendation

## Intent

In the NOM-4 run the author read 32 spec findings, answered 3 author decisions from prose in a trace file, resolved 4 planner questions in chat, and read four full PR review reports. Nothing was ranked, nothing was explained in plain words, and no open question came with a suggested answer. The human is the slowest part of the flow and will stay so; the agents' output has to be shaped for that reader. Everything found is still reported: there is no cap.

## Acceptance criteria

### Features

- [ ] F1: **Sorted by severity, everywhere.** Every rendered list of findings (`spec-reviewer` `trace/findings.md` and the findings section of `spec.reviewed.md`; `spec-writer` the same; `pr-reviewer` `findings.md`, `review.md` and the PR comment; `planner` `trace/checks.md` problems) is ordered critical, high, medium, low, info, and within a severity by the order the verifier confirmed them. The skills' reports to the session, and the session's report to the person, keep that order. Nothing is dropped: the count in the header equals the number of items.
- [ ] F2: **Each finding carries a plain-English explanation.** Every finding gets a **What this means** paragraph of at most three sentences for a reader who knows the product but not the code: what a user or the team would see go wrong, in ordinary words, with any technical term defined in the sentence that uses it. It comes after the title and before the evidence. The existing verified evidence (file, line, check, replacement text; Review Verification REV-022) stays as it is.
- [ ] F3: **Each open decision carries a recommended answer.** Every item an agent leaves to the author (`spec-reviewer` and `spec-writer` author decisions in `trace/decisions.md` and `review.json` `authorDecisions`; `planner` `decisions` in `trace/review.json`; `implementor` assumptions it chose conservatively) is written as: the question in one sentence; the options; **Recommended:** one option with one sentence of reasoning; **Why it is yours to decide** in one sentence. The agent's own choice when it had to proceed (the implementor's assumptions) is marked as the recommended option already taken, so the human can reverse it rather than discover it.
- [ ] F4: **Decisions are answerable in place.** `trace/decisions.md` renders each decision with a checkbox per option, the recommended one first, so the author can tick an answer in the file (or on the Notion page the ticket-flow spec pushes it to). The skill reads ticked answers on the next run of the same stage (`spec-reviewer` rerun on a resolved spec; `planner` rerun) and records them as the author's decisions in `review.json` with `decidedBy: 'author'`.
- [ ] F5: **The session reports the same way.** Every skill's `SKILL.md` report instructions say: present findings in severity order with their plain-English line first and the evidence available on request; present every open decision with its recommended answer; never summarise away an item. The skill-rules tests pin those sentences in each agent's `instructions.md`, not in `SKILL.md`.

### Tests

- [ ] unit, per agent: a fixture with findings in mixed severities renders in the fixed order with equal counts in header and body.
- [ ] unit, per agent: the finding schema requires `whatThisMeans` (string, 1 to 3 sentences, no backticked token longer than one word without a definition in the same sentence) and the renderer places it before the evidence.
- [ ] unit, per agent that leaves decisions: the decision schema requires `options` (at least two), `recommended` (one of the options) and `whyYours`; the renderer writes the checkbox form with the recommended option first; the parser reads a ticked option back and sets `decidedBy: 'author'`.
- [ ] unit: the skill-rules tests pin the report sentences in each `instructions.md`, and `SKILL.md` does not restate them.
- [ ] integration: `spec-reviewer --local` on the NOM-4 spec fixture: the author ticks one decision in `trace/decisions.md`, reruns, and `review.json` shows it decided by the author with no new author decision for it.

## Implementation and verification plan

- Extend the finding and decision schemas in each agent's `agent/lib/` (spec-reviewer `review.ts` first; spec-writer imports it; planner `plan.ts`; pr-reviewer `review.ts`; implementor's assumptions in its report schema). Models produce `whatThisMeans`, `options`, `recommended`, `whyYours`; renderers sort and format; parsers read the checkboxes.
- Severity ordering is one shared helper in `packages/agents/common` with the five levels; every renderer uses it.
- Prompts: the seat and reconciliation prompts ask for the new fields with the plain-English rule stated once; no change to what counts as a finding.
- Run every package's `test`, `typecheck` and `lint`; rerun the spec-reviewer benchmark (`specs/agents-spec-reviewer.benchmark.md`) to confirm raised and retained counts did not move.

## Out of scope

Capping or collapsing findings. Changing severity definitions. Auto-applying a recommended decision.
