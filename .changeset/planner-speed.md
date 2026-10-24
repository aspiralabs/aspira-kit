---
"@aspiralabs/ai": minor
---

Planner speed and model experiments.

- `aspira.json` `models` takes a reasoning effort as well as a model (`{ "model", "effort" }`), and `<step>.<phase>` keys set the tasks inside a step (`planner.planning`, `spec-writer.explore`, `implementor.worker`, …). Unset keys keep the defaults.
- Plans can `move` a file or a whole directory in one change; the planner's checker and the implementor's target check follow the move, so later tasks name files at their new paths.
- A planner correction pass returns only the tasks and tests it changes, merged into the plan, instead of rewriting the whole plan.
- Planning keeps each change's instructions and each test to its intent, so the plan is shorter to write and to read.
