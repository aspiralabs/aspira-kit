---
"@aspiralabs/agent-common": minor
"@aspiralabs/groomer": minor
"@aspiralabs/spec-writer": minor
"@aspiralabs/spec-reviewer": minor
"@aspiralabs/planner": minor
"@aspiralabs/implementor": minor
"@aspiralabs/code-analyzer": minor
"@aspiralabs/pr-reviewer": minor
"@aspiralabs/build-feature": minor
"@aspiralabs/agents": minor
"@aspiralabs/kit": minor
"@aspiralabs/ui": minor
"@aspiralabs/config": minor
---

KIT-51: running in the session is the default mode of every `/aspira-*` skill, and `--cloud` is the flag for the separate agent. `/aspira-<skill> <ID>` now does what `<ID> --local` did; `--local` is still accepted and means the default. `/aspira-build-feature <ID>` runs every step in the session and `--cloud` runs every step's cloud agent (`--autonomous` is refused with `--cloud`). The Playbook rows, `kit playbook`, the progress notes' Next action and the build-feature resume command print the commands without `--local`; a cloud run's commands carry `--cloud`. The launchers accept `--cloud` and `--local` and refuse the one that contradicts the subcommand.
