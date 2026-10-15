---
'@aspiralabs/agent-common': minor
'@aspiralabs/groomer': minor
'@aspiralabs/spec-writer': minor
'@aspiralabs/spec-reviewer': minor
'@aspiralabs/planner': minor
'@aspiralabs/implementor': minor
'@aspiralabs/code-analyzer': minor
'@aspiralabs/pr-reviewer': minor
'@aspiralabs/build-feature': minor
'@aspiralabs/agents': minor
'@aspiralabs/kit': minor
---

Every skill now ends its run in one of five statuses — `ready`, `needs-author`, `incomplete`, `refused` or `blocked` — instead of each skill's own word (`complete`, `clean`, `confirmed`, `stopped`, `partial`, `nothing-detected`, `failed`). A launcher's exit code is 0 only for `ready`; every other status exits non-zero and carries the status word and a reason in its JSON. `readRunStatus` (`@aspiralabs/agent-common/lib/run-status`) still reads every old per-skill word, mapped onto its new status and reason code, so a record written before this change keeps resolving.

Every `--local` driver writes `.work/<id>-<slug>/progress.md` after each stage: the ticket, its outputs, what finished, decisions taken, open issues and the one Next action to run, so a fresh session or a human can see where a ticket stands without re-reading the whole run folder. `groomer`'s, `code-analyzer`'s and `pr-reviewer`'s `--local` knowledge stage now loads and verifies the engineering guidelines folder itself instead of asking the session to fetch it over the Notion MCP.

build-feature's PR bodies (and the --local Step 8 note) gained a shared Summary/Evidence/Merge Danger renderer (`@aspiralabs/agent-common/lib/pr-body`): a file tree of the branch's changed files, every implementation task's red/green evidence grouped by feature ID (tailed and redacted), and a one-way/two-way door call for a native dependency or a migration path. build-feature itself now routes on the five statuses, runs each step through its own launcher script instead of the Playbook slash command, and reports its own run status (`buildRunStatus`, one of the five words, never its internal `stopped`/`finished` run-state bookkeeping words).

Every `/aspira-*` launcher skill (and `/aspira-build-feature`) is now `disable-model-invocation: true`: invoke it with its slash command or its launcher script directly, never by asking the model to decide to call it.

**Breaking for projects.** Rerun `kit init` after upgrading, to pick up the updated skill files. A non-`ready` run now exits non-zero where it used to exit 0 for some old words (`confirmed`, `complete`, `clean`): a CI step or script that only checked for a crash, not the status word, will now see those stops as failures. `--local` runs need `NOTION_TOKEN` in the project's `.env.local` for the skills whose knowledge stage now self-fetches (`groomer`, `code-analyzer`, `pr-reviewer`); without it they report `blocked` instead of printing a session fetch stage.
