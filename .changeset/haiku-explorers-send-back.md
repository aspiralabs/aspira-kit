---
'@aspiralabs/ai': minor
---

Explorers run on Haiku, and a spec review phase that breaks a checked rule gets one send-back instead of ending the run.

- The spec writer's and the planner's explore phases default to `haiku` in session runs (`spec-writer.explore`, `planner.explore`; aspira.json `models` still overrides them) and to `anthropic/claude-haiku-4.5` in the cloud (`SPEC_WRITER_EXPLORE_MODEL`, `SPEC_PLAN_EXPLORE_MODEL`). Review specialists stay on Sonnet; draft, research, planning and reconciliation on Opus.
- A review lens whose checks rows leave out one of its assigned rules, or research leaving out a rule no lens owns, is sent back once with the missing rules named, before the coverage check counts "Uncovered guideline". A reconciliation whose bookkeeping fails (a duplicate or rejected finding carrying edits, an edit no finding cites, unknown or duplicate gap resolutions, a candidate that breaks the spec contract) is sent back once with those problems. A second miss is the run problem it was before. In a session run the send-back is its own task (`outputs/<phase>.sent-back.json`), so the refused output stays on disk. On SCOOP-7 each of these ended a finished review incomplete and cost a full rerun (about 1.3M tokens).
