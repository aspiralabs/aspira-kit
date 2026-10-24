// T8 (plan.json P1, P15; F12, F53): `afterRun` (the --local driver's end-of-run step,
// ticket-driver.ts) and `finishFlow` (the separate-process launcher's finish, ticket-flow.ts) must
// make identical board effects for the same run status, and `afterRun` must no longer take an `ok`
// argument at all: its result depends only on the status (Approach part 1, "afterRun no longer
// takes ok from its callers").
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Board, Ticket, TicketPage, ToDo } from './board.ts'
import { afterRun, type BeforeRun, type DriverContext } from './ticket-driver.ts'
import { finishFlow } from './ticket-flow.ts'
import { GATES, SKILLS, TICKET_FILE, renderTicketMd, type BoardAction, type BoardTrace, type Skill } from './ticket.ts'

const BOARD_URL = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6?v=1'
const STATUSES = ['needs-author', 'blocked', 'refused'] as const

/** A Board that only records pushPage/moveTicket calls; finishFlow is the only caller that touches it (afterRun only computes actions for the session to perform, it calls no Board). */
function fakeBoard(): Board & { calls: string[] } {
  const pages: Record<string, TicketPage> = {}
  const state = {
    calls: [] as string[],
    async resolveTicket(): Promise<Ticket> {
      throw new Error('not used by finishFlow')
    },
    async moveTicket(_page: Ticket | string, from: string, to: string) {
      state.calls.push(`move ${from} -> ${to}`)
      return { id: 'KIT-2', before: from, after: to }
    },
    async setProperty() {},
    async pushPage(_page: Ticket | string, title: string) {
      state.calls.push(`push ${title}`)
      const page = { id: `page-${title}`, title, url: `https://www.notion.so/page-${encodeURIComponent(title)}`, lastEditedAt: new Date().toISOString() }
      pages[title] = page
      return { id: page.id, url: page.url, created: true, lastEditedAt: page.lastEditedAt }
    },
    async pullPage(_page: Ticket | string, title: string) {
      return pages[title] === undefined ? undefined : { ...pages[title]!, markdown: '' }
    },
    async createPage(_page: Ticket | string, title: string) {
      return { id: `page-${title}`, url: `https://www.notion.so/page-${encodeURIComponent(title)}` }
    },
    async appendParagraph() {
      return { id: 'block-1' }
    },
    async deleteBlock() {},
    async replacePage(_page: Ticket | string, title: string) {
      return { id: `page-${title}`, url: `https://www.notion.so/page-${encodeURIComponent(title)}`, lastEditedAt: new Date().toISOString() }
    },
    async writeIdeaSummary() {
      return { ids: [], deleted: [] }
    },
    async listToDos(): Promise<ToDo[]> {
      return []
    },
    async me() {
      return { id: 'bot-1' }
    },
    // KIT-19 Board methods: no rules page, so these tests make no telemetry attach.
    async uploadFile(name: string) {
      return { id: `upload-${name}`, status: 'uploaded' }
    },
    async appendFileBlock() {
      return { id: 'block-telemetry' }
    },
    async fileBlockNames() {
      return []
    },
    async rulesPage() {
      return null
    },
  }
  return state
}

/** A ticket folder in the skill's own In Progress (or, when it has none, first accepted) Status, with every file the skill's gate pushes already in place. */
async function ticketFolder(repo: string, skill: Skill, name: string): Promise<{ folder: string; status: string; ticketUrl: string }> {
  const status = GATES[skill].inProgress ?? GATES[skill].accepts[0]!
  const folder = join(repo, name)
  await mkdir(folder, { recursive: true })
  const ticketUrl = `https://www.notion.so/${name}`
  const ticket = renderTicketMd({
    id: 'KIT-2',
    title: 'Every skill writes a progress note',
    url: ticketUrl,
    status,
    type: 'Feature',
    priority: 'P1',
    area: ['Kit'],
    dev: 'Claude',
    pr: undefined,
    version: undefined,
    pulledAt: new Date().toISOString(),
    idea: 'Idea body.\n',
    pages: {},
  })
  await writeFile(join(folder, TICKET_FILE), ticket)
  for (const push of GATES[skill].pushes) {
    await mkdir(join(folder, push.file, '..'), { recursive: true })
    await writeFile(join(folder, push.file), `# ${push.title}\n\nStub content.\n`)
  }
  return { folder, status, ticketUrl }
}

/** The push titles and the move `end.actions` (afterRun's board stage) lists. */
function summarize(actions: BoardAction[]): { pushes: string[]; move: { from: string; to: string } | null } {
  const pushes = actions.filter((action): action is Extract<BoardAction, { action: 'push' }> => action.action === 'push').map((action) => action.title)
  const move = actions.find((action): action is Extract<BoardAction, { action: 'move' }> => action.action === 'move')
  return { pushes: pushes.toSorted(), move: move === undefined ? null : { from: move.from, to: move.to } }
}

describe('afterRun vs finishFlow board effects (T8, F12, F53)', () => {
  let repo: string
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'after-run-effects-'))
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('for every skill and status, the push titles and the move afterRun lists equal the pushes and the move finishFlow performs', async () => {
    for (const skill of SKILLS) {
      for (const status of STATUSES) {
        const { folder, status: statusBefore, ticketUrl } = await ticketFolder(repo, skill, `${skill}-${status}-after`)
        const context: DriverContext = { skill, repo }
        const trace: BoardTrace = { skill, ticket: { id: 'KIT-2', title: 'Every skill writes a progress note', url: ticketUrl }, folder, statusBefore, statusAfter: statusBefore, pushed: [], actions: [] }
        const before: BeforeRun & { kind: 'ticket' } = {
          kind: 'ticket',
          argument: { kind: 'ticket', ref: 'KIT-2', folder },
          folder,
          input: null,
          statusBefore,
          ticket: { id: 'KIT-2', title: 'Every skill writes a progress note', url: ticketUrl, status: statusBefore },
          trace,
        }
        const after = await afterRun(context, before, { status, exportDir: join(folder, 'export'), verifyCommand: `${skill}.sh local KIT-2 --verify` })
        const fromAfterRun = summarize(after.board.actions)

        const client = fakeBoard()
        const finishFolder = (await ticketFolder(repo, skill, `${skill}-${status}-finish`)).folder
        await finishFlow({ skill, folder: finishFolder, runStatus: status, board: BOARD_URL, client } as unknown as Parameters<typeof finishFlow>[0])
        const moveCall = client.calls.find((call) => call.startsWith('move '))
        const fromFinishFlow = {
          pushes: client.calls.filter((call) => call.startsWith('push ')).map((call) => call.slice('push '.length)).toSorted(),
          move: moveCall === undefined ? null : { from: moveCall.slice('move '.length).split(' -> ')[0]!, to: moveCall.split(' -> ')[1]! },
        }

        expect(fromAfterRun, `${skill} ${status}`).toEqual(fromFinishFlow)
      }
    }
  })

  it('blocked and refused make no push and no move in either function', async () => {
    for (const skill of SKILLS) {
      for (const status of ['blocked', 'refused'] as const) {
        const { folder, status: statusBefore, ticketUrl } = await ticketFolder(repo, skill, `${skill}-${status}-noop-after`)
        const context: DriverContext = { skill, repo }
        const before: BeforeRun & { kind: 'ticket' } = {
          kind: 'ticket',
          argument: { kind: 'ticket', ref: 'KIT-2', folder },
          folder,
          input: null,
          statusBefore,
          ticket: { id: 'KIT-2', title: 'Every skill writes a progress note', url: ticketUrl, status: statusBefore },
          trace: { skill, ticket: { id: 'KIT-2', title: 'Every skill writes a progress note', url: ticketUrl }, folder, statusBefore, statusAfter: statusBefore, pushed: [], actions: [] },
        }
        const after = await afterRun(context, before, { status, exportDir: join(folder, 'export'), verifyCommand: `${skill}.sh local KIT-2 --verify` })
        expect(summarize(after.board.actions), `afterRun ${skill} ${status}`).toEqual({ pushes: [], move: null })

        const client = fakeBoard()
        const finishFolder = (await ticketFolder(repo, skill, `${skill}-${status}-noop-finish`)).folder
        await finishFlow({ skill, folder: finishFolder, runStatus: status, board: BOARD_URL, client } as unknown as Parameters<typeof finishFlow>[0])
        expect(client.calls, `finishFlow ${skill} ${status}`).toEqual([])
      }
    }
  })

  it('does not depend on an ok argument: the same status gives the same result whether an extraneous ok is true or false', async () => {
    const skill: Skill = 'planner'
    const status = 'needs-author'
    const resultFor = async (name: string, ok: boolean) => {
      const { folder, status: statusBefore, ticketUrl } = await ticketFolder(repo, skill, name)
      const context: DriverContext = { skill, repo }
      const before: BeforeRun & { kind: 'ticket' } = {
        kind: 'ticket',
        argument: { kind: 'ticket', ref: 'KIT-2', folder },
        folder,
        input: null,
        statusBefore,
        ticket: { id: 'KIT-2', title: 'Every skill writes a progress note', url: ticketUrl, status: statusBefore },
        trace: { skill, ticket: { id: 'KIT-2', title: 'Every skill writes a progress note', url: ticketUrl }, folder, statusBefore, statusAfter: statusBefore, pushed: [], actions: [] },
      }
      const after = await afterRun(context, before, { status, ok, exportDir: join(folder, 'export'), verifyCommand: 'planner.sh local KIT-2 --verify' } as unknown as Parameters<typeof afterRun>[2])
      return summarize(after.board.actions)
    }
    const withOkTrue = await resultFor('ok-true', true)
    const withOkFalse = await resultFor('ok-false', false)
    expect(withOkTrue).toEqual(withOkFalse)
  })
})
