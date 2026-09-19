# Review orchestrator

The orchestrator is code, not a model. It runs the gates, seats the reviewers, bounds the debate, computes the tier, and writes the report. It has no opinion. This file exists so the shape of the review is documented next to the seats it runs.

## Order

1. Gates: typecheck, lint, build. Fail closed.
2. In parallel: debate (critic and author alternate until they agree), security seat, UI seat.
3. Blast radius: deterministic floor, then the agent may raise.
4. Report: settled findings, unsettled findings, tier, recommendation.

## Stopping rules for the debate

- The debate ends when both seats agree: every finding accepted by the author or withdrawn by the critic.
- A safety cap (default 10 rounds, `--max-rounds`) stops two models from circling. Anything still disputed at the cap is unsettled and goes to a human. The cap is a failure of the debate, not a verdict.
- Agreement ends the debate. It does not approve the diff. Gates, the UI seat, the security seat, and the tier still decide the recommendation.

## Recommendation

- `merge` when gates are green, no blockers, nothing unsettled, and tier is low.
- `human-review` when tier is medium or high, or anything is unsettled.
- `block` when gates are red or a blocker is settled against the diff.
