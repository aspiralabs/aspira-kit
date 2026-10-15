// T14 (F9, F15, F16): the --local driver (beforeRun, afterRun, verifyRun, handleRunError in
// ticket-driver.ts) writes and updates progress.md at every return to the session, so a crashed or
// resumed run always has a Next action to read. handleRunError does not exist yet (P15); this file
// is written against the contract P15/P16 add: afterRun takes a run status (not `ok`), and
// handleRunError turns a thrown FlowRefused/TicketArgumentError or an unexpected error into the
// refused/incomplete report and the matching progress.md update.
//
// The --local board stage (localBoardStep) makes no Notion calls: it returns the actions for the
// session to perform and waits for ticket.md to be rewritten with a newer mtime before it goes on
// (ticket-flow.ts:887-910). `driveToReady` below plays the session's side: it reads the actions a
// stage asks for (set Dev, move Status) and rewrites ticket.md accordingly, bumping its mtime so
// the driver's "has this been done since I asked" check passes.

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Board } from './board'
import { parseNextAction, parseProgressNote } from './progress-note'
import { GATES, renderTicketMd, type TicketRecord } from './ticket'
import { ticketCli } from './ticket-cli'
import { afterRun, beforeRun, handleRunError, verifyRun, type BeforeRun, type DriverContext } from './ticket-driver'
import { writeBoardTrace } from './ticket-flow'

let repo: string
let folder: string
let context: DriverContext

const BOARD = 'https://www.notion.so/board'
const NOW = () => new Date().toISOString()

function baseTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: 'KIT-2',
    title: 'Every skill writes a progress note',
    url: 'https://www.notion.so/kit-2',
    status: 'Ready: Spec',
    type: 'Feature',
    priority: 'P1',
    area: ['Kit'],
    dev: undefined,
    pr: undefined,
    version: undefined,
    pulledAt: NOW(),
    idea: 'Every skill should write a progress note.\n',
    pages: {},
    ...overrides,
  }
}

let mtimeTick = 0
async function writeTicket(record: TicketRecord) {
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'ticket.md')
  await writeFile(file, renderTicketMd(record))
  mtimeTick += 1
  const stamp = new Date(Date.now() + mtimeTick * 2000)
  await utimes(file, stamp, stamp)
}

/** Play the session's side of the board stage until the ticket is claimed and ready (ticket-flow.ts:864-970). */
async function driveToReady(initial: TicketRecord): Promise<BeforeRun & { kind: 'ticket' }> {
  let current = initial
  // The real flow pulls this from the ticket's own child page; stubbed here since no board is involved.
  const input = GATES[context.skill].input
  if (input !== undefined) {
    const file = join(folder, Array.isArray(input) ? input[0]! : input)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '## Plan\n\n- [ ] F1: a step.\n')
  }
  for (let i = 0; i < 8; i += 1) {
    const result = await beforeRun(context, { positional: 'KIT-2' })
    if (result.kind !== 'stage') return result as BeforeRun & { kind: 'ticket' }
    for (const action of result.stage.actions) {
      if (action.action === 'set' && action.name === 'Dev') current = { ...current, dev: action.value }
      if (action.action === 'move') current = { ...current, status: action.to }
      if (action.action === 'pull') await writeFile(action.file, `# ${action.title}\n\nStub content.\n`).catch(() => undefined)
    }
    await writeTicket(current)
  }
  throw new Error('the board stage did not resolve after 8 simulated session turns')
}

function fakeBoard(): Board {
  const page = (title: string) => ({ id: `${title.toLowerCase()}-page`, url: `https://www.notion.so/${title.toLowerCase()}-page` })
  return {
    resolveTicket: () => {
      throw new Error('finishFlow reads ticket.md directly; resolveTicket is not used')
    },
    moveTicket: async (_page, from, to) => ({ id: 'KIT-2', before: from, after: to }),
    setProperty: async () => undefined,
    pushPage: async (_page, title) => ({ ...page(title), created: true }),
    pullPage: async () => undefined,
    createPage: async (_page, title) => page(title),
    appendParagraph: async () => ({ id: 'block-1' }),
    deleteBlock: async () => undefined,
    replacePage: async (_page, title) => ({ ...page(title), lastEditedAt: NOW() }),
    writeIdeaSummary: async () => ({ ids: [], deleted: [] }),
    listToDos: async () => [],
    me: async () => ({ id: 'bot-1' }),
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'progress-note-driver-'))
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD }))
  folder = join(repo, '.work', 'kit-2-every-skill-writes-a-progress-note')
  context = { skill: 'planner', repo }
  mtimeTick = 0
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function note(): Promise<string> {
  return readFile(join(folder, 'progress.md'), 'utf8')
}

describe('T14: beforeRun writes a continuation note at the board stage, before any claim', () => {
  it('names a Run line that reruns the exact launcher command already in progress', async () => {
    await writeTicket(baseTicket())
    const first = await beforeRun(context, { positional: 'KIT-2' })
    expect(first.kind).toBe('stage')
    const action = parseNextAction(await note())
    expect(action?.run.join(' ')).toContain('planner.sh local KIT-2')
  })
})

describe('T14: afterRun records Status, Expected Status and the --verify Next action', () => {
  it('writes the board-end note once the ticket is claimed and the run has ended', async () => {
    const before = await driveToReady(baseTicket())
    const exportDir = join(folder, 'plan.review')
    await mkdir(join(exportDir, 'trace'), { recursive: true })
    await writeFile(join(exportDir, 'plan.reviewed.md'), '## Plan\n\n- [ ] F1: ship it.\n')
    const verifyCommand = '.claude/skills/aspira-planner/scripts/planner.sh local KIT-2 --verify'
    await afterRun(context, before, { status: 'ready', exportDir, verifyCommand })
    const parsed = parseProgressNote(await note())
    const action = parseNextAction(await note())
    expect({ status: parsed?.status, expected: parsed?.expectedStatus, run: action?.run }).toEqual({ status: 'In Progress: Plan', expected: 'In Review: Plan', run: [verifyCommand] })
  })
})

describe('T14: a passing verify sets the Next action to the following Playbook step', () => {
  it('follows the Status ticket.md shows once the board actions are confirmed', async () => {
    const record = baseTicket({ status: 'In Review: Plan', pages: { Plan: { id: 'plan-page', title: 'Plan', url: 'https://www.notion.so/plan-page', lastEditedAt: NOW() } } })
    await writeTicket(record)
    const exportDir = join(folder, 'plan.review')
    await mkdir(join(exportDir, 'trace'), { recursive: true })
    await writeBoardTrace(exportDir, { skill: 'planner', ticket: { id: 'KIT-2', title: record.title, url: record.url }, folder, statusBefore: 'In Progress: Plan', statusAfter: 'In Progress: Plan', expected: 'In Review: Plan', pushing: ['Plan'], pushed: [], actions: [] })
    const result = await verifyRun(context, {}, (f) => join(f, 'plan.review'))
    expect(result.verified).toBe(true)
    const action = parseNextAction(await note())
    expect(action?.run).toEqual(['/aspira-implementor KIT-2 --local'])
  })
})

describe('T14: a refusal at the board gate keeps the existing Next action and adds a dated Open issues line', () => {
  it('does not replace the Next action, only appends why the gate refused', async () => {
    // A note from an earlier, finished run: the Next action is already Step 6 (the following Playbook step).
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'progress.md'),
      ['# KIT-2: Every skill writes a progress note', '', '## Ticket', '', 'Run id: r0', 'Written: 2026-10-10T00:00:00.000Z', '', '## Next action', '', 'Step: Step 6: build', 'Run: /aspira-implementor KIT-2 --local', 'Session: .claude/skills/aspira-implementor/scripts/implementor.sh local KIT-2', ''].join('\n'),
    )
    // The live ticket is in a Status the planner's gate does not accept: a second call throws FlowRefused.
    await writeTicket(baseTicket({ status: 'In Review: Plan' }))
    const first = await beforeRun(context, { positional: 'KIT-2' })
    if (first.kind !== 'stage') throw new Error('expected the resolve stage first')
    await writeTicket(baseTicket({ status: 'In Review: Plan' }))
    let caught: unknown
    try {
      await beforeRun(context, { positional: 'KIT-2' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    await handleRunError(context, caught, { positional: 'KIT-2' })
    const text = await note()
    expect(parseNextAction(text)).toEqual({ step: 'Step 6: build', do: [], run: ['/aspira-implementor KIT-2 --local'], session: '.claude/skills/aspira-implementor/scripts/implementor.sh local KIT-2' })
    const openIssues = text.slice(text.indexOf('## Open issues'), text.indexOf('## Next action'))
    expect(openIssues).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('T14: an unexpected error replaces the note with status incomplete', () => {
  it('names the error under Open issues, sets Next action to rerun the step, and exits 1', async () => {
    await writeTicket(baseTicket())
    await beforeRun(context, { positional: 'KIT-2' }).catch(() => undefined) // writes the first continuation note
    const result = await handleRunError(context, new Error('boom'), { positional: 'KIT-2' })
    const text = await note()
    const parsed = parseProgressNote(text)
    expect(parsed?.runStatus).toBe('incomplete')
    expect(text.slice(text.indexOf('## Open issues'))).toContain('boom')
    expect(parseNextAction(text)?.step.toLowerCase()).toContain('rerun the step')
    expect(result.exitCode).toBe(1)
  })
})

describe('T14: a refusal with no ticket folder at all writes no progress.md', () => {
  it('returns the unblocking command in its report instead of writing a file', async () => {
    let caught: unknown
    try {
      await beforeRun(context, {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const result = await handleRunError(context, caught, {})
    expect(result.reason ?? result.message).toMatch(/ticket/i)
    await expect(readFile(join(folder, 'progress.md'), 'utf8')).rejects.toThrow()
  })
})

describe('T14: ticketCli note and finish for a separate-process launch', () => {
  it('note writes a Next action that waits on the run, and finish rewrites the note from the run record', async () => {
    const io = { out: () => undefined, err: () => undefined }
    await writeTicket(baseTicket({ status: 'In Progress: Plan' }))
    const noteExit = await ticketCli('planner', ['note', '--repo', repo, '--folder', folder, '--run', '/tmp/planner.abc'], io, {})
    expect(noteExit).toBe(0)
    expect(parseNextAction(await note())?.run).toEqual(['planner.sh wait /tmp/planner.abc'])
    const exportDir = join(folder, 'plan.review')
    await mkdir(join(exportDir, 'trace'), { recursive: true })
    await writeFile(join(exportDir, 'plan.reviewed.md'), '## Plan\n')
    const finishExit = await ticketCli('planner', ['finish', '--repo', repo, '--folder', folder, '--ok', '--run-status', 'ready', '--export', exportDir], io, {}, fakeBoard())
    expect(finishExit).toBe(0)
    expect(parseNextAction(await note())?.run).not.toEqual(['planner.sh wait /tmp/planner.abc'])
  })
})
