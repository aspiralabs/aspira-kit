---
'@aspiralabs/ai': patch
---

The planner accepts a spec criterion that keeps behaviour unchanged when a tests task writes a test pinning it, with no implementation task; before, such a criterion could never pass ("No implementation maps to F14", NOM-43). In a default (not `--autonomous`, not `--cloud`) build-feature run, the groomer step runs in the build-feature session instead of a subagent, so its exit-criterion questions and Confirm reach the human; before, a subagent could not ask them and the run always stopped incomplete at grooming.
