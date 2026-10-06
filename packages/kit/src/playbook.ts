// The Playbook: which step comes next for a ticket, from its Feature Board Status. This module is
// the one source of that table. `kit next` reads it to answer "what is the next step", and
// `kit playbook` renders it as the markdown of the "Playbook: what to run next" section of
// From Idea to Release in Notion, so the page and the command cannot drift apart.

/** One row of the Status table. `command` has `<ID>` where the ticket ID goes; null when the step is done by hand. */
export type PlaybookRow = { statuses: string[]; step: string; command: string | null; who: string }

export const PLAYBOOK: PlaybookRow[] = [
  { statuses: ['Idea', 'Grooming', 'Shortlist'], step: 'Step 1: groom the idea, then move the card to Ready: Idea', command: null, who: 'you' },
  { statuses: ['Ready: Idea'], step: 'Step 2: write the spec', command: '/aspira-spec-writer <ID> --local', who: 'agent' },
  { statuses: ['In Progress: Spec'], step: 'Step 2 is running, or it stopped: rerun it', command: '/aspira-spec-writer <ID> --local', who: 'agent, then you' },
  { statuses: ['In Review: Spec'], step: 'Step 3: debate the spec, answer its decisions, then Step 4: approve it', command: '/aspira-spec-reviewer <ID> --local', who: 'agent, then you' },
  { statuses: ['Ready: Spec'], step: 'Step 5: plan', command: '/aspira-planner <ID> --local', who: 'agent' },
  { statuses: ['In Progress: Plan'], step: 'Step 5 is running, or it stopped: rerun it', command: '/aspira-planner <ID> --local', who: 'agent, then you' },
  { statuses: ['In Review: Plan'], step: "Read the plan's status and open questions, then move the card to Ready: Plan", command: null, who: 'you' },
  { statuses: ['Ready: Plan'], step: 'Step 6: build', command: '/aspira-implementor <ID> --local', who: 'agent' },
  { statuses: ['In Progress: Implementation'], step: 'Step 6 is running or stopped, or Step 7 (static analysis) and Step 8 (open the PR) are still to do', command: '/aspira-code-analyzer <ID> <app-dir> --local', who: 'agent, then you' },
  { statuses: ['In Review: Implementation'], step: 'Step 9: review the PR, fix, rerun; then Step 10: docs, release page, merge', command: '/aspira-pr-reviewer <ID> --local', who: 'agent, then you' },
  { statuses: ['Ready: Implementation'], step: 'Step 11: release, when the release page is ready', command: null, who: 'you' },
  { statuses: ['Released'], step: 'Step 12: learn', command: null, who: 'you, with an agent' },
  { statuses: ['Dropped'], step: 'Nothing: the ticket is not being built', command: null, who: 'nobody' },
]

/** The row for a Status, or null when the board has a Status this table does not know. */
export function nextStep(status: string): PlaybookRow | null {
  const wanted = status.trim().toLowerCase()
  return PLAYBOOK.find((row) => row.statuses.some((candidate) => candidate.toLowerCase() === wanted)) ?? null
}

/** The row's command with the ticket ID filled in. */
export function commandFor(row: PlaybookRow, id: string): string | null {
  return row.command === null ? null : row.command.replaceAll('<ID>', id)
}

/** The steps under the table, in the ticket form of every command. Plain markdown, no emoji. */
export const PLAYBOOK_STEPS: { title: string; body: string }[] = [
  {
    title: 'Step 1: groom the idea',
    body: "Write Problem, who has it, and what done looks like in the ticket's Idea section. Move the card Idea → Grooming → Shortlist → Ready: Idea by hand.",
  },
  {
    title: 'Step 2: write the spec',
    body: [
      '```bash',
      '/aspira-spec-writer <ID> --local',
      '```',
      'Needs Ready: Idea; the skill refuses any other Status before it runs a model, naming the Status it needs and who moves the card there. It sets Dev, moves the card to In Progress: Spec, pulls the ticket into `.work/<id>-<slug>/` (`ticket.md`, `idea.md`) and runs the spec writer on `idea.md`. Output: `spec.md` in the folder, plus `spec.written/` (the writer runs one review on its own draft). On success it puts `spec.md` on the ticket as the child page **Spec** (BOARD-003) and moves the card to In Review: Spec. If the run stops, the card stays In Progress: Spec and the same command reruns it without a second claim. Read `spec.written/trace/review.json` for the real status; the command can exit 0 on a failed run.',
      'Skip this step when the ticket already has a Spec page (migrated tickets): move the card to In Review: Spec by hand and go to Step 3.',
    ].join('\n'),
  },
  {
    title: 'Step 3: debate the spec',
    body: [
      '```bash',
      '/aspira-spec-reviewer <ID> --local',
      '```',
      'Needs In Review: Spec. The skill pulls `spec.md` from the Spec page and reviews it; it makes no move. Output: `spec.reviewed/spec.reviewed.md`, `run-analysis.md`, `trace/`. On success it puts the reviewed spec on the ticket as **Spec Reviewed**, and the open decisions as **Spec Review Decisions** when the status is `needs-author`. Read `trace/review.json`:',
      '- `ready`: go to Step 4.',
      '- `needs-author`: answer each decision in `trace/decisions.md`, write the answers into `spec.reviewed/spec.reviewed.md`, and rerun this step; it reviews the answered file and replaces the Spec Reviewed page. Repeat until it says `ready`. Do not skip the rerun; NOM-4 did, and the planner then worked from an unreviewed edit.',
    ].join('\n'),
  },
  {
    title: 'Step 4: approve the spec',
    body: 'You read it. Move the card to Ready: Spec. No agent does this (BOARD-004).',
  },
  {
    title: 'Step 5: plan',
    body: [
      '```bash',
      '/aspira-planner <ID> --local',
      '```',
      'Needs Ready: Spec. The skill sets Dev, moves the card to In Progress: Plan, pulls `spec.reviewed/spec.reviewed.md` from the Spec Reviewed page and plans from it. Output: `plan.review/plan.reviewed.md`, `run-analysis.md`, `trace/`. On success it puts the plan on the ticket as **Plan** and moves the card to In Review: Plan. Read `trace/review.json`:',
      '- `ready`: read the plan, then move the card to Ready: Plan by hand.',
      '- `needs-author`: answer the decisions it lists in the plan, then rerun; the card is In Review: Plan, so move it back to In Progress: Plan first (BOARD-007).',
      '- `incomplete`: read `problems` in the same file; most are missing evidence. The card stays In Progress: Plan; rerun once. If it stays incomplete, that is a kit bug: log it on Kit agent gaps.',
    ].join('\n'),
  },
  {
    title: 'Step 6: build',
    body: [
      '```bash',
      '/aspira-implementor <ID> --local',
      '```',
      'Needs Ready: Plan. The skill sets Dev, moves the card to In Progress: Implementation, pulls `plan.review/plan.reviewed.md` from the Plan page and builds it on `feat/<id>-<slug>`. Add `--serial` to run one lane at a time, or `--max-parallel 3` to cap the lanes. Output: commits on the branch, and `plan.review/implementation.md` with the task table, deviations and assumptions, which it puts on the ticket as **Implementation**. The card stays In Progress: Implementation until the PR is open (Step 8); a `refused`, `blocked` or `incomplete` result is not a finished build.',
      "Before going on, run the project's gate yourself: the static check, unit tests and integration tests named in the project's `AGENTS.md` (nomnomzz: `pnpm check`, `pnpm test`, `pnpm test:integration` in `apps/web`, and `npm test` in `apps/mobile` when mobile changed).",
    ].join('\n'),
  },
  {
    title: 'Step 7: static analysis',
    body: [
      'Once per app directory:',
      '```bash',
      '/aspira-code-analyzer <ID> apps/web --local',
      '/aspira-code-analyzer <ID> apps/mobile --local',
      '```',
      'Needs In Progress: Implementation or In Review: Implementation; the skill makes no move. Review the diff it made. Clean analysis does not prove behaviour is unchanged.',
    ].join('\n'),
  },
  {
    title: 'Step 8: open the pull request',
    body: [
      '```bash',
      'git push -u origin feat/<id>-<slug>',
      'gh pr create --base main --title "<ID>: <feature>" --body-file <summary.md>',
      '```',
      "The body links the ticket. Then set the ticket's **PR** property to the PR URL (BOARD-005) and move the card to In Review: Implementation. The implementor does both itself when it opened the PR (`--pr`, as a separate process); after a `--local` build, which pushes nothing, you do. Open the PR before the review; the reviewer comments on it.",
    ].join('\n'),
  },
  {
    title: 'Step 9: debate the diff',
    body: [
      '```bash',
      '/aspira-pr-reviewer <ID> --local',
      '```',
      "Needs In Review: Implementation with the PR property set; the skill reviews that PR and makes no move. For the separate-process mode drop `--local` and export `GITHUB_TOKEN=$(gh auth token)` first; the agent needs it to read a private repo and post its comment. Output: the review comment on the PR, `review.md`, `findings.md` and `cost.md` in `.work/<id>-<slug>/pr-review/`, and `review.md` on the ticket as **PR Review**.",
      'Fix what it found, push, rerun. **Stop when nothing critical or high is left.** Put the remaining mediums and lows on follow-up tickets. NOM-4 ran four extra full reviews after that point and each one found a new layer of lows; that is the loop to avoid.',
    ].join('\n'),
  },
  {
    title: 'Step 10: docs, release page, merge',
    body: [
      'Before merging, in this order:',
      '1. Repo docs in the same PR: anything the change made untrue in `AGENTS.md` (Gotchas), `PRODUCT.md`, `docs/general/FEATURES.md`, `README.md`, `DEPLOYMENT.md`, `RELEASE.md`.',
      "2. The product's open release page (REL-002): a customer line, a Features row with the card and PR, every deploy step.",
      '3. Notion pages the change made untrue: list them on the ticket under **Docs to propagate** and update them.',
      'Then a human merges (BOARD-004) and moves the card to Ready: Implementation. No skill makes that move.',
    ].join('\n'),
  },
  {
    title: 'Step 11: release',
    body: "Follow Releases: work the page's checklist, run the end-to-end suite on `main`, publish the GitHub Release with the page's customer summary, run the after-deploy steps, mark the page Released, set Version on each card and move it to Released (BOARD-008).",
  },
  {
    title: 'Step 12: learn',
    body: "Ask an agent to read the run's `run-analysis.md`, `implementation.md` and review findings and propose entries for the AI Agent Slop Repo, the project's Gotchas, the UI kit gaps page and the Kit agent gaps page. You ratify them. Then delete `.work/<id>-<slug>/`; everything it held is on the ticket.",
  },
]

/** The intro of the Playbook section, before the table. */
export const PLAYBOOK_INTRO = [
  "The ticket's Status says which step is next. Find the status in the table, run that step. Every `/aspira-*` skill takes the ticket ID (or its Notion URL) as its first argument: it checks the Status, refuses before any model call when the Status is not the one it needs, pulls the ticket into the working folder `.work/<id>-<slug>/`, makes its own two board moves and never a third, and puts its output back on the ticket as a child page. Replace `<ID>` with the ticket ID, for example `NOM-4`; `<id>` is the same in lower case. `pnpm kit next <ID>` prints this table's row for a ticket, and `pnpm kit playbook` prints this section.",
].join('\n')

/** The Playbook section as markdown: heading, intro, the Status table, the steps. */
export function renderPlaybook(): string {
  const table = ['| Ticket Status | Next step | Command | Who |', '| --- | --- | --- | --- |', ...PLAYBOOK.map((row) => `| ${row.statuses.join(', ')} | ${row.step} | ${row.command === null ? 'by hand' : `\`${row.command}\``} | ${row.who} |`)]
  const steps = PLAYBOOK_STEPS.map((step) => `### ${step.title}\n${step.body}`)
  return ['## Playbook: what to run next', PLAYBOOK_INTRO, ...table, ...steps].join('\n') + '\n'
}
