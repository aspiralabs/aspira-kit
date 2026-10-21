---
'@aspiralabs/build-feature': minor
'@aspiralabs/code-analyzer': minor
'@aspiralabs/spec-writer': minor
'@aspiralabs/spec-reviewer': minor
'@aspiralabs/groomer': minor
'@aspiralabs/planner': minor
'@aspiralabs/implementor': minor
'@aspiralabs/pr-reviewer': minor
'@aspiralabs/agent-common': minor
'@aspiralabs/agents': minor
'@aspiralabs/kit': minor
---

KIT-48: cut build-feature working time. SIFT-11 spent 10.8 hours working, 5.7 of them in subagents; this release removes the waste the run telemetry showed.

- **Code analyzer on a ticket fixes only the branch's changed files.** Auto-fix and the model fix run on the files the ticket branch changed against `origin/main` (or `main`), with per-file commands (`eslint --fix <files>`, `prettier --write <files>`, ruff, black, gofmt, rubocop); diagnostics in untouched files are reported as pre-existing in `report.md` and `diagnostics.json`, never fixed and never a reason to end incomplete. `--no-ticket` keeps the whole tree.
- **One spec step.** `/aspira-spec-writer` is the one spec skill: from Ready: Idea it explores, drafts and runs the one specialist review on the draft; from In Review: Spec it reviews the answered spec again (`spec.reviewed/spec.reviewed.md`, or `spec.md`) with no move. Its output is `spec.reviewed/` in the reviewer's layout plus `spec.md`; it pushes Spec, Spec Reviewed and, for needs-author, Spec Review Decisions. The Playbook row for In Review: Spec runs the spec writer. `@aspiralabs/spec-reviewer` is a library only: its skill, eve agent and local driver are gone, and `kit init` removes the old `aspira-spec-reviewer` skill folder.
- **Parallel exploration.** An idea that names two or more repository areas gets one explorer per area, launched in one message, and the explorations merge; the draft, research and reconciliation prompts are held to the packet (no re-exploration, at most five confirming reads).
- **One pre-built packet per run.** build-feature writes `.work/<id>-<slug>/packet.md` before each step (the repository map, aspira.json facts, the ticket's files, the guidelines folder) and passes `--packet` to the spec writer and the planner, which put it in front of every phase's context.
- **Guidelines built once per ticket.** build-feature walks Notion into `.work/<id>-<slug>/knowledge/` on the first step and, before every later step, compares the pages by hash: unchanged, the step gets the folder (`--guidelines <dir>/REQUIRED.md`, or `--knowledge <dir>`); any page changed, the whole folder is rebuilt. Without a token or `KNOWLEDGE_PAGE` every step loads its own, as before.
- **One consolidated grooming round.** Round 1 asks every question the idea needs across every branch and closes the rest; the driver refuses a round 1 that leaves a branch neither asked nor closed. A second round happens only when an answer invalidates other questions.
- **Model routing per task.** Every task a `local` stage prints names its `model` (opus, sonnet or haiku); the orchestrating session launches each task's subagent on it. Research and reconciliation on opus, explorers and specialists on sonnet, the analyzer's fixes on haiku; the pr-reviewer's seats follow its own model map. Fable stays the orchestrator.
