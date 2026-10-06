# Ticket-aware skills: the board drives the flow

## Intent

Every `/aspira-*` skill takes a Feature Board ticket as its argument, checks the ticket's Status before it starts, makes its own two board moves, pulls the ticket's pages into the ticket's working folder and pushes its output back as child pages. The Notion ticket is the record; the repo folder `.work/<id>-<slug>/` is a working copy anyone can rebuild. A human still makes every move into a Ready column and merges every PR.

Why: in the NOM-4 run (2026-09-30 to 2026-10-05) every board move and every pull or push was done by hand in chat. Statuses were skipped, cards moved before work started, "Ready: Spec" did not mean the spec was plannable, and the run log stopped halfway. A skill that owns its own moves cannot drift from the board, and "what is the next step" becomes a question the ticket's Status answers.

## Acceptance criteria

### Features

- [ ] F1: **The ticket is the argument.** Every skill (`spec-writer`, `spec-reviewer`, `planner`, `implementor`, `code-analyzer`, `pr-reviewer`) accepts as its first argument a ticket: a board ID such as `NOM-4` (case-insensitive), a Notion page URL, or nothing, in which case the one folder under `.work/` that holds a `ticket.md` is the ticket. Two or more such folders with no argument is an error naming them. A file path still works for a repository with no board when `--no-ticket` is given; the run's report and trace record `ticket: none`. Without `--no-ticket`, a file path is an error that names the flag.
- [ ] F2: **The board is configured once per project.** `kit init --board <Feature Board URL>` writes `aspira.json` at the repository root with `board` (the Feature Board data source URL) and, when given, `releases` (the product's Releases page URL). `kit doctor` fails when `aspira.json` is missing or `board` is not a Notion URL. The skills and `kit next` read it. A project without a board has no `aspira.json`, and every skill then requires `--no-ticket`.
- [ ] F3: **One shared board module.** `packages/agents/common/src/lib/board.ts` is the only code that talks to the Feature Board. It offers: `resolveTicket(idOrUrl)` (by ID property or page URL; returns ID, title, URL, Status, Type, Priority, Area, Dev, PR, the Idea body, and the child pages by title); `moveTicket(page, from, to)` (refuses when the current Status is not `from`); `setProperty(page, name, value)` (Dev, PR); `pushPage(page, title, markdown)` (creates the child page with that title or replaces the content of the existing one; one page per title); `pullPage(page, title)` (the child page as plain markdown). It uses `NOTION_TOKEN` from the agent environment and the same request helpers as `knowledge.ts`. No skill, driver or agent tool calls the Notion API directly.
- [ ] F4: **Deterministic converters, both ways.** `packages/agents/common/src/lib/notion-markdown.ts` converts Notion markdown to plain markdown (unescapes `\*`, `\_`, `\[`; `<table>` to pipe tables; callouts to block quotes; mentions to links; drops nothing silently: an unsupported block becomes an HTML comment naming its type) and plain markdown to Notion blocks (headings 1 to 3, paragraphs, bulleted and numbered lists, checkboxes, fenced code with language, pipe tables, block quotes, bold, italic, inline code, links). A round trip of the NOM-4 reviewed spec and plan through both directions changes no heading, list item, table cell or code line. Unit tests cover each block type and the round trip.
- [ ] F5: **Pull builds the working folder.** Before any model stage, a skill writes `.work/<id>-<slug>/` where `<id>` is the ticket ID in lower case and `<slug>` is the title as a slug: `ticket.md` (ID, URL, Status, Type, Priority, Area, Dev, PR, pulled-at time, the Idea body), `idea.md` (the Idea body alone), `spec.md` from the child page **Spec**, `spec.reviewed/spec.reviewed.md` from **Spec Reviewed**, `plan.review/plan.reviewed.md` from **Plan**, `plan.review/implementation.md` from **Implementation**, each only when that page exists. A file the local folder already has and the page has not changed since (compared by the page's last-edited time recorded in `ticket.md`) is left alone. A local file newer than its page is not overwritten; the skill stops and says which file, unless `--force-pull` is given.
- [ ] F6: **Each skill owns exactly two moves and never a third.** The gate and moves per skill are:

  | Skill | Refuses unless Status is | On start | On success | On failure or incomplete |
  | --- | --- | --- | --- | --- |
  | spec-writer | Ready: Idea | In Progress: Spec, Dev set to the agent | In Review: Spec | stays In Progress: Spec |
  | spec-reviewer | In Review: Spec | no move | no move | no move |
  | planner | Ready: Spec | In Progress: Plan, Dev set | In Review: Plan | stays In Progress: Plan |
  | implementor | Ready: Plan | In Progress: Implementation, Dev set | PR opened and PR property set, then In Review: Implementation | stays In Progress: Implementation |
  | code-analyzer | In Progress: Implementation or In Review: Implementation | no move | no move | no move |
  | pr-reviewer | In Review: Implementation, with PR set | no move | no move | no move |

  A skill never moves a card to a Ready column, to Released, or backwards. A rerun of a skill whose card is already in its own In Progress status (a retry after a failure) proceeds without a start move. A refusal happens before any model call, costs nothing, and prints the ticket, its current Status, the Status the skill needs, and who makes that move (for a Ready column: "a human, after approving the <spec | plan>"). The implementor without `--pr` ends in In Progress: Implementation and says that opening the PR is the remaining step.
- [ ] F7: **Push puts every output on the ticket.** On success each skill pushes, with these fixed titles: spec-writer `Spec` (from `spec.md`); spec-reviewer `Spec Reviewed` (from `spec.reviewed/spec.reviewed.md`) and `Spec Review Decisions` (from `spec.reviewed/trace/decisions.md`, only when the status is `needs-author`); planner `Plan` (from `plan.review/plan.reviewed.md`); implementor `Implementation` (from `plan.review/implementation.md`); pr-reviewer `PR Review` (from `review.md`, in addition to the PR comment). Trace folders are never pushed. Pushing replaces the page's content and keeps its URL. A push failure after the work succeeded is reported with the local path that holds the output, and the board move for success is still made.
- [ ] F8: **`--local` does the board work through the session.** The `local` driver of every skill prints a `board` stage before `knowledge`, listing the reads and writes to perform as data (`{ action: 'resolve' | 'pull' | 'move' | 'set' | 'push', ... }`), the way the `knowledge` stage lists pages. The session performs them with the Notion MCP and writes the results (`ticket.md`, pulled files) into the working folder; the driver verifies `ticket.md` shows the expected Status before continuing and refuses otherwise. At the end the driver prints the success or failure moves and pushes for the session to perform, then verifies the Status once more. The default (separate process) path performs the same actions itself through `board.ts` with `NOTION_TOKEN`. Both paths record every board action, with the Status before and after, in the run's trace.
- [ ] F9: **`kit next` answers "what is the next step".** `pnpm kit next [<ticket>]` reads `aspira.json`, resolves the ticket (or the one in `.work/`), and prints its Status, the Playbook step for that Status, the exact command to run, and who acts (you or an agent). The mapping is the Playbook table in From Idea to Release; the command keeps the table and the page in step by reading the mapping from one module that the Playbook page is regenerated from (`packages/kit/src/playbook.ts`, exported as markdown by `kit playbook`).
- [ ] F10: **Reports name the ticket.** Every skill's report starts with the ticket ID and title, the Status before and after, the pages pushed (with URLs) and the working folder. The `--local` export includes the same in its JSON.
- [ ] F11: **The Playbook matches.** From Idea to Release's Playbook section is updated to the ticket form of every command, and each "manual today" line is removed as its skill lands. The kit's `AGENTS.md` block template and the session-start hook need no change (they only point at the Playbook).

### Tests

- [ ] unit: `board.ts` against a recorded Notion fixture: resolve by ID and by URL; `moveTicket` refuses when the current Status differs from `from`; `pushPage` replaces an existing page of the same title and creates a missing one; `setProperty` for Dev and PR.
- [ ] unit: `notion-markdown.ts` per block type both ways, and the round trip on the NOM-4 reviewed spec and plan fixtures.
- [ ] unit: ticket argument resolution: ID, URL, none with one folder, none with two folders (error), path without `--no-ticket` (error), path with `--no-ticket` (ok, recorded).
- [ ] unit, per skill: the gate table (every row refuses on the wrong Status before any model call; proceeds on the right one; a retry in its own In Progress status makes no start move); the success and failure moves; the pushes and their titles.
- [ ] unit: pull leaves an unchanged file alone, refuses to overwrite a newer local file without `--force-pull`, writes every file when the folder is empty.
- [ ] unit: `kit next` prints the step and command for every Status, from the same module `kit playbook` renders.
- [ ] integration: `--local` driver of one skill (planner) against a stub session: the `board` stage lists the resolve, pull and move; the driver refuses to continue when `ticket.md` shows the wrong Status; the end stage lists the success move and the push.
- [ ] integration: `kit init --board <url>` writes `aspira.json`; `kit doctor` fails without it.

## Implementation and verification plan

- `board.ts` and `notion-markdown.ts` first, in `packages/agents/common`, with their tests. They have no dependency on any agent.
- `kit`: `aspira.json`, `kit next`, `kit playbook`, the doctor checks, and `playbook.ts` as the one source of the Status table.
- Then each skill, in parallel, in its own package: the ticket argument, the gate, the `board` stage in `local`, the pull before `knowledge`, the push and moves at export. Start with `planner` as the reference, then `spec-reviewer`, `spec-writer`, `implementor`, `code-analyzer`, `pr-reviewer`.
- Run every package's `test`, `typecheck` and `lint`. Run one real ticket (a throwaway card on the nomnomzz board) through planner `--local` end to end before merging.
- Then the Playbook page and the kit README.

## Out of scope

Automating the human gates (Ready moves, merge, release). Moving tickets between products. Any change to what the agents produce.
