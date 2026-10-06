---
'@aspiralabs/kit': minor
'@aspiralabs/agents': minor
'@aspiralabs/agent-common': minor
'@aspiralabs/spec-writer': minor
'@aspiralabs/spec-reviewer': minor
'@aspiralabs/planner': minor
'@aspiralabs/implementor': minor
'@aspiralabs/code-analyzer': minor
'@aspiralabs/pr-reviewer': minor
---

The Feature Board ticket is the argument of every skill. `/aspira-spec-writer`, `spec-reviewer`, `planner`, `implementor`, `code-analyzer` and `pr-reviewer` take a ticket ID such as `NOM-4`, a Notion page URL, or nothing when `.work/` holds one ticket; a file path needs `--no-ticket`. Before any model call a skill checks the ticket's Status against its row of the gate table and refuses, naming the Status it needs and who makes that move, when the Status is another. It pulls the ticket's pages into `.work/<id>-<slug>/` (`ticket.md`, `idea.md`, `spec.md`, `spec.reviewed/spec.reviewed.md`, `plan.review/plan.reviewed.md`, `plan.review/implementation.md`), leaving an unchanged file alone and refusing to overwrite a local file newer than its page without `--force-pull`. The spec writer, planner and implementor claim the card (Dev set, their In Progress status) on start and move it to their In Review status on success, the implementor only once it opened the PR; the reviewers and the analyzer make no move; nothing moves a card to a Ready column. On success each skill pushes its output back to the ticket under a fixed title (Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review); a push failure is reported with the local path and the success move is still made. In `--local` the driver prints a `board` stage before `knowledge` with the actions for the session to perform with the Notion MCP, verifies `ticket.md` between steps and ends with a `--verify` step; a separate-process run does the same through the shared board module with `NOTION_TOKEN`. Every board action lands in the run's trace with the Status before and after, and every report starts with the ticket, the moves, the pages pushed and the working folder.

`kit init --board <Feature Board URL>` writes `aspira.json` (with `--releases` for the Releases page), `kit doctor` checks it, and `kit next [<ticket>]` prints a ticket's Status with the Playbook step, command and owner. `kit playbook` renders the Playbook section of From Idea to Release from the same table.
