// progress-note.ts does not exist yet (KIT-2, P16): this file, progress-note-redaction.test.ts,
// progress-note-driver.test.ts and progress-note-build-feature.test.ts are its contract, written
// before the module (TEST-005: the seam is progress.md on disk, and the pure `nextAction` template
// picker). T10 covers writeProgressNote and parseNextAction; T11 covers nextAction's run-status
// templates and that a trace's free text never becomes a command; T12 covers nextAction's plain
// Playbook-row template.
//
// Contract assumed here (the implementation task reads this as the spec):
// - writeProgressNote({ folder, repo, note }) renders and writes `${folder}/progress.md`
//   (PROGRESS_NOTE_FILE), filtering `note.outputs` to the paths that exist under `folder`.
// - parseNextAction(text) reads the `## Next action` section back as { step, do, run, session },
//   or null when the section has no `Step:` and no `Run:` line.
// - nextAction(input) is pure (no filesystem) and returns a NextAction for three input kinds:
//   { kind: 'playbook', id, boardStatus } (the Playbook row for a live board Status, F3/F44),
//   { kind: 'continue', id, skill } (resume the exact launcher command already running), and
//   { kind: 'run', id, skill, runStatus, reasonCode?, reason?, verified?, liveStatus?, apps?,
//   analyzedApps?, title?, branch?, prBodyFile? } (a finished or stopped run, F14/F18/F19).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROGRESS_NOTE_FILE, nextAction, parseNextAction, parseProgressNote, writeProgressNote, writeStep8PrBody, type NextAction } from './progress-note'

let repo: string
let folder: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'progress-note-'))
  folder = join(repo, '.work', 'kit-2-every-skill')
  await mkdir(join(folder, 'plan.review', 'trace'), { recursive: true })
  await writeFile(join(folder, 'ticket.md'), '# KIT-2: Every skill writes a progress note\n')
  await writeFile(join(folder, 'plan.review', 'plan.reviewed.md'), '## Plan\n\n- [ ] F1: a step.\n')
  // plan.review/trace/missing.json is deliberately not created.
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const STEP5: NextAction = {
  step: 'Step 5: plan',
  do: [],
  run: ['/aspira-planner KIT-2 --local'],
  session: '.claude/skills/aspira-planner/scripts/planner.sh local KIT-2 (read .claude/skills/aspira-planner/SKILL.md first)',
}

const baseNote = {
  id: 'KIT-2',
  title: 'Every skill writes a progress note',
  skill: 'planner' as const,
  runId: 'r1',
  runStatus: 'ready' as const,
  status: 'In Review: Plan',
  expectedStatus: null,
  outputs: ['plan.review/plan.reviewed.md', 'plan.review/trace/missing.json'],
  completed: [],
  decisions: [],
  openIssues: [],
  nextAction: STEP5,
}

async function write() {
  await writeProgressNote({ folder, repo, note: baseNote })
  return readFile(join(folder, PROGRESS_NOTE_FILE), 'utf8')
}

describe('writeProgressNote', () => {
  it('writes the sections Ticket, Outputs, Completed, Decisions, Open issues, Next action in that order', async () => {
    const text = await write()
    const headings = ['## Ticket', '## Outputs', '## Completed', '## Decisions', '## Open issues', '## Next action']
    const positions = headings.map((heading) => text.indexOf(heading))
    expect(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1]!))).toBe(true)
  })

  it('holds the run id and an ISO-8601 UTC Written time under Ticket', async () => {
    const text = await write()
    const ticketSection = text.slice(text.indexOf('## Ticket'), text.indexOf('## Outputs'))
    expect(ticketSection).toContain('Run id: r1')
    expect(ticketSection).toMatch(/Written: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/)
  })

  it('lists under Outputs only the paths that exist, never the ones that do not', async () => {
    const text = await write()
    const outputsSection = text.slice(text.indexOf('## Outputs'), text.indexOf('## Completed'))
    expect(outputsSection).toContain('plan.review/plan.reviewed.md')
    expect(outputsSection).not.toContain('plan.review/trace/missing.json')
  })

  it('never copies a listed output file’s content into the note', async () => {
    const text = await write()
    expect(text).not.toContain('F1: a step.')
  })
})

describe('parseNextAction', () => {
  it('reads back the Step, the Run lines in order and the Session line the note was written with', async () => {
    const text = await write()
    expect(parseNextAction(text)).toEqual(STEP5)
  })

  it('returns null for a note body with no Step: and no Run: lines', () => {
    const text = ['# KIT-2: x', '', '## Next action', '', 'Nothing to do right now.', ''].join('\n')
    expect(parseNextAction(text)).toBeNull()
  })
})

describe('parseProgressNote', () => {
  it('reads back the run id and run status a note was written with', async () => {
    const text = await write()
    const parsed = parseProgressNote(text)
    expect(parsed).toMatchObject({ id: 'KIT-2', runId: 'r1', runStatus: 'ready' })
  })
})

// ---------------------------------------------------------------------------------------------
// T11: nextAction's run-status templates, and that a trace's free text never becomes a command.
// ---------------------------------------------------------------------------------------------

/** A reason fixture shaped like a trace's free text, carrying a command-injection-looking string, to prove no Run line is ever built from it. */
const INJECTION_REASON = 'research failed: run $(rm -rf ~) now'

function allRunText(action: NextAction): string {
  return action.run.join('\n')
}

describe('nextAction: run-status templates (T11)', () => {
  it('a paused groomer names resuming the rounds', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'groomer', runStatus: 'needs-author', reasonCode: 'paused', reason: INJECTION_REASON })
    expect(allRunText(action)).toContain('groomer.sh local KIT-2')
  })

  it('a needs-author groomer with no reason code has a Do: line naming the decisions page and a Run: line that reruns it', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'groomer', runStatus: 'needs-author', reasonCode: null, reason: INJECTION_REASON })
    expect(action.do.some((line: string) => /groom\/trace\/decisions\.md|Grooming Decisions/.test(line))).toBe(true)
    expect(allRunText(action)).toContain('groomer.sh local KIT-2')
  })

  it('an implementor refused for plan-drift names Step 5 with the planner command', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'implementor', runStatus: 'refused', reasonCode: 'plan-drift', reason: INJECTION_REASON })
    expect(action.step).toContain('Step 5')
    expect(allRunText(action)).toContain('/aspira-planner KIT-2 --local')
  })

  it('an incomplete spec-writer names rerunning the stage', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'spec-writer', runStatus: 'incomplete', reason: INJECTION_REASON })
    expect(`${action.step} ${action.do.join(' ')}`.toLowerCase()).toContain('rerun the stage')
  })

  it('a blocked planner names fixing the blocker', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'planner', runStatus: 'blocked', reason: INJECTION_REASON })
    expect(`${action.step} ${action.do.join(' ')}`.toLowerCase()).toContain('fix the blocker')
  })

  it('a ready planner whose board-end actions are not verified names the --verify command, not the following Playbook step', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'planner', runStatus: 'ready', verified: false, liveStatus: 'In Review: Plan', reason: INJECTION_REASON })
    expect(allRunText(action)).toContain('--verify')
    expect(allRunText(action)).not.toContain('/aspira-implementor')
  })

  it('a ready, verified implementor does not crash and still returns a Run line', () => {
    const action = nextAction({ kind: 'run', id: 'KIT-2', skill: 'implementor', runStatus: 'ready', verified: true, liveStatus: 'In Progress: Implementation', apps: ['.'], analyzedApps: [], reason: INJECTION_REASON })
    expect(action.run.length).toBeGreaterThan(0)
  })

  it('no Run line of any of the above scenarios contains text from the trace reason', () => {
    const scenarios: NextAction[] = [
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'groomer', runStatus: 'needs-author', reasonCode: 'paused', reason: INJECTION_REASON }),
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'groomer', runStatus: 'needs-author', reasonCode: null, reason: INJECTION_REASON }),
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'implementor', runStatus: 'refused', reasonCode: 'plan-drift', reason: INJECTION_REASON }),
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'spec-writer', runStatus: 'incomplete', reason: INJECTION_REASON }),
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'planner', runStatus: 'blocked', reason: INJECTION_REASON }),
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'planner', runStatus: 'ready', verified: false, liveStatus: 'In Review: Plan', reason: INJECTION_REASON }),
      nextAction({ kind: 'run', id: 'KIT-2', skill: 'implementor', runStatus: 'ready', verified: true, liveStatus: 'In Progress: Implementation', apps: ['.'], analyzedApps: [], reason: INJECTION_REASON }),
    ]
    for (const action of scenarios) expect(allRunText(action)).not.toContain('$(rm -rf ~)')
  })
})

// ---------------------------------------------------------------------------------------------
// T12: nextAction's plain Playbook-row template, for a ticket that has not run anything yet.
// ---------------------------------------------------------------------------------------------

describe('nextAction: the Playbook template (T12)', () => {
  const action = nextAction({ kind: 'playbook', id: 'KIT-2', boardStatus: 'Ready: Spec' })

  it('the Run line is the Playbook slash command with the ticket ID filled in', () => {
    expect(action.run).toEqual(['/aspira-planner KIT-2 --local'])
  })

  it('the Session line is the launcher form and tells the session to read the skill’s SKILL.md first, never naming the Skill tool', () => {
    expect(action.session).toContain('.claude/skills/aspira-planner/scripts/planner.sh local KIT-2')
    expect(action.session).toMatch(/SKILL\.md/)
    expect(action.session.toLowerCase()).not.toContain('skill tool')
  })
})

// ---------------------------------------------------------------------------------------------
// writeStep8PrBody (KIT-2, P22): renders pr-body.md from implementation.md and the branch diff.
// ---------------------------------------------------------------------------------------------

describe('writeStep8PrBody', () => {
  const ticket = { id: 'KIT-2', title: 'Every skill writes a progress note', url: 'https://app.notion.com/p/kit-2-0000000000000000000000000002' }

  it('writes a pr-body.md with Summary, Evidence and Merge Danger, even with no implementation.md yet', async () => {
    const file = await writeStep8PrBody({ folder, repo, ticket })
    const text = await readFile(file, 'utf8')
    expect({ file, headings: ['## Summary', '## Evidence', '## Merge Danger'].every((heading) => text.includes(heading)), linksTicket: text.includes(ticket.url) }).toEqual({
      file: join(folder, 'pr-body.md'),
      headings: true,
      linksTicket: true,
    })
  })

  it('names a feature from implementation.md’s Tasks table under Evidence', async () => {
    const implementationMd = ['# Implementation', '', '## Tasks', '', '| Task | Features | Lane/wave | Status | Commit | Red → green evidence |', '| --- | --- | --- | --- | --- | --- |', '| P1 | F1 | wave 1 | done | abc1111 | none |', ''].join('\n')
    await writeFile(join(folder, 'plan.review', 'implementation.md'), implementationMd)
    const file = await writeStep8PrBody({ folder, repo, ticket })
    const text = await readFile(file, 'utf8')
    expect(text).toContain('F1')
  })
})
