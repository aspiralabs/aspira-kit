# Improvements

Follow-ups for the agent pipeline, from a review of [pstack-claude](https://github.com/michael-denyer/pstack-claude) on 2026-09-28. Each item says what it is, why, and how we would know it worked. Items are experiments unless marked decided; the measurement decides whether they stay.

Source: pstack's ideas that fit our narrower, typed pipeline. Declined from the same review: the 31-skill routing hub, principle files cited per reply, the Graphite stack machinery, the ten-lane plan checker, and prose taste rules. Our `plan.json` contract is the better bet.

## Done

- **Rule-pinning tests.** Every agent package has `scripts/skill-rules.test.ts`: one row per rule, a reason and the sentence in `SKILL.md` or `instructions.md` that carries it. Dropping the sentence fails the test with the reason attached. Rewording is fine: update the phrase, keep the reason. Add a row whenever a rule earns its place through a mistake.

## Decided, not yet done

- **spec-reviewer: reconciliation on Opus.** The six specialists run on GPT-6.1 Sol and are reconciled by Sol, so the filter shares the specialists' blind spots. Move the reconciliation phase to Opus 5.5. One config change, no new cost.

## spec-reviewer

The risk in a spec review is noise, not misses: the first real run raised 36 findings on one spec, and the author reading them is the bottleneck. Multi-model is worth it here only as a way to tell real findings from taste.

- **Two families inside each lens, round one only.** Keep the six lenses. Run the specialist phase on two vendors (twelve calls instead of six). Code already assigns finding IDs and validates dispositions, so "raised by one family or two" becomes a computed field on each finding, not a model's opinion.
  - Measure: the report records author decisions. Compare the acceptance rate of two-family findings against lone findings across a handful of runs (the `score` script is the place). Keep the second pass only if agreement predicts acceptance; then use it to rank and collapse the list.
  - Scope it: diversity likely pays only on the judgment lenses (acceptance, behavior). Security, data and UI are rule and MCP driven and would mostly return the same answer twice.
  - The second family must be a different vendor, not a different Claude tier. The independence claim rests on that.
  - Local mode (`--local`) runs on one session model by design and already says so. None of this applies there.

## pr-reviewer

Already right: the six seats run on Opus 5.5 and Quinn, the verifier, runs on GPT-6 Luna. Quinn can reject but not add, so the only cost of a same-family panel is coverage.

Priority order:

1. **Show what Quinn rejected.** Rejected findings are excluded from `review.md` and survive only in the round files and `conversation.md`. Add a short section to `review.md` listing each rejected finding with Quinn's one-line reason. The human can then overrule a bad rejection. No model cost.
2. **Record the commit the verdict applies to.** Write the head SHA (and base SHA) into `review.md` and `findings.md`. A push after the review is then visibly unreviewed. Later: distinguish what the verdict rests on (typecheck, unit tests, live driving, verifier blocked, verifier failed), and treat "verifier blocked" as not a pass.
3. **Round one on two families.** Discovery happens in round one; rounds two to four prune. Run the six seats on two vendors in round one only, merge into one list, and keep the debate rounds single family.
   - Measure: tag each finding with the family that raised it. If Quinn confirms second-family-only findings at about the same rate as Opus findings, they are real misses and the pass stays. If Quinn rejects most, it is noise; drop it.
   - Cheaper variant: one generalist seat on a non-Anthropic model with the full rubric, alongside the six lenses. One extra call per round, but loses the lens focus.

Additional proposal from the follow-up discussion:

- **Judge causality, not just finding location.** Quinn's current instructions reject findings about code the PR does not change. That prevents unrelated cleanup, but could also reject a regression in an unchanged caller caused by a changed helper. Accept findings that demonstrate a failure caused by the diff, including downstream effects; continue rejecting unrelated pre-existing problems. Pair this with the blast-radius evidence ladder below.
  - Measure: use cases where a changed helper breaks an unchanged caller, alongside cases with unrelated existing defects. The reviewer should retain the former and reject the latter, with source evidence connecting the change to the failure.
  - Source: [pstack blast-radius](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/blast-radius/SKILL.md).

## planner

- **Compare designs before detailing the implementation.** The planner grounds tasks in repository evidence, but its prompts do not explicitly require competing designs. For changes involving shared state, ownership, schemas or public APIs, explore at least two structurally different approaches before choosing files, tasks and tests. Compare types, interfaces, module boundaries and tradeoffs. Record why the chosen approach fits the business criteria and existing code.
  - Scope it: routine changes should use existing patterns without a mandatory design contest. Apply this when a consequential architectural choice is still open.
  - Measure: compare implementation rework, design-related review findings and planning cost with the current process. More design prose alone is not success.
  - Source: [pstack architect](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/architect/SKILL.md).

## implementor

- **Repo-local `verify` driver skill.** The final verification task runs tests, typecheck, lint and build, but never drives the real app. pstack's `create-verification-skill` generates a project skill with five parts: launch (with the ready signal and teardown), doctor (one read-only "is this instance worth driving" check), drive (real selectors and commands from the repo), evidence (what to capture and where it survives cleanup), cleanup (kill what you started, never by name). Plus a per-feature map. Fits as a `kit add verify` template; the implementor's section 6 then drives one mapped feature when the skill exists.
  - Follow-up clarification: section 6 currently asks the implementor to look at UI work if the app can run and a browser is available. The gap is a repeatable procedure with observable outcomes and retained proof. For saving a recipe, exercise creation through the UI, reload, find it in the library, reopen it and verify its contents. Check persisted side effects as well as visible state. A blocked or inconclusive run must remain distinct from a pass.
  - Measure: introduce a wiring or persistence defect that unit tests miss and confirm that driving the mapped feature catches it. This is the first priority from the follow-up discussion.
  - Source: [pstack create-verification-skill](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/create-verification-skill/SKILL.md).
- **Evaluate isolation for parallel workers.** The current dependency graph and file write scopes address overlapping edits, but workers still share a checkout. A test can observe another worker's unfinished code; caches and generated output can also collide. Compare separate worktrees or exclusive branches with the current shared-checkout approach for suitable lanes, followed by integration and verification by the orchestrator.
  - Scope it: isolation adds setup and integration costs. Keep serial execution for tightly coupled work; do not assume every lane benefits from a worktree.
  - Measure: check whether worker tests remain reproducible while another lane is mid-edit, and compare interference failures, integration failures and total elapsed time.
  - Source: [pstack feature playbook](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/poteto-mode/playbooks/feature.md).
- **Retry by failure mode for lanes.** Cap or out-of-memory: respawn with smaller scope. Network drop: retry as is. Tool error: retry on a different model. Unknown: retry once. Two retries, then mark the task blocked and build around it. One paragraph in the skill.
- **Brief upgrades.** Add a TIMEBOX line to the worker brief (on expiry, return partial findings and stop). Audit one sampled worker brief per wave against the template, since brief quality decays late in a run.
- **Evidence labels in the report.** Every claim in the summary carries its label: measured, inferred, or guess. Cheap, and it stops a prediction reading as a result.

## Across the pipeline

- **Reflect step after a run.** Mine the run's log and transcript for lessons and propose entries for `pitfalls.md`, the slop register, or a project `## Gotchas`. Route anything enforceable to a lint rule or test instead of prose. Proposals only; the human applies. Today the register is fed by hand.
- **Evidence ladder for blast-radius.** The persona should grade each safety claim: you said so, you pointed at a line, you walked the failure, you ran it, you reproduced it. Report where each claim stopped, and prove the one fact the change is safe because of by running code.
- **Evaluate agent changes against outcomes.** Extend the spec reviewer's existing raised-versus-retained benchmark to measure false positives, unnecessary work, implementation rework and meaningful defects caught. Compare prompt, model and reviewer-count changes on ordinary-looking tasks. Keep scoring criteria out of candidate context, blind judges to model and variant identity, and check actual tool traces and artifacts instead of self-reported compliance. Include human review of disputed judgments.
  - Measure: does another reviewer catch confirmed defects, does another debate round improve the decision, and does a stronger planner reduce implementation rework enough to justify its cost? Preserve recall while measuring noise; fewer findings alone is not improvement.
  - Source: [pstack evaluation playbook](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/poteto-mode/playbooks/eval.md).

## Adoption boundaries

These follow-up proposals strengthen the existing spec-reviewer → planner → implementor → pr-reviewer pipeline. They do not imply a need for more agent roles. Prioritize runtime proof and evaluation of the agents already built.

Avoid copying mandatory workflow steps without evidence of benefit. For example, pstack routes code crossing a function boundary through architecture exploration; that trigger is too broad for routine Aspira work. Apply expensive exploration and review where the consequences justify them. Source: [pstack workflow rules](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/poteto-mode/SKILL.md).
