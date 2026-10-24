// T7 (plan.json P1, P15; F5, F7, F12, F53): `ticket-cli finish` after P15, which drops the
// --ok/--failed flags (an older launcher's flags are accepted and ignored, F7) and derives
// pushes, moves and the exit code from --run-status alone. Uses a fake Board client (TEST-003,
// TEST-007: Notion is mocked at the boundary, never a real network call) and runs with
// NOTION_TOKEN unset (project note after a KIT-8 test wiped part of a live page).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Board, Ticket, TicketPage, ToDo } from './board.ts'
import { ticketCli } from './ticket-cli.ts'
import { GATES, TICKET_FILE, renderTicketMd, type Skill } from './ticket.ts'

const BOARD_URL = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6?v=1'
const TICKET_URL = 'https://www.notion.so/Kit-2-3ec3e59b22588102becfce78d66142e1'

/** A Board recording every write it is asked to make; reads come from the in-memory ticket and pages. */
function fakeBoard(status: string): Board & { status: string; calls: string[]; pr: string | undefined } {
  const pages: Record<string, TicketPage> = {}
  const state = {
    status,
    pr: undefined as string | undefined,
    calls: [] as string[],
    async resolveTicket(): Promise<Ticket> {
      throw new Error('not used by finish')
    },
    async moveTicket(_page: Ticket | string, from: string, to: string) {
      state.calls.push(`move ${from} -> ${to}`)
      state.status = to
      return { id: 'KIT-2', before: from, after: to }
    },
    async setProperty(_page: Ticket | string, name: string, value: string) {
      state.calls.push(`set ${name}=${value}`)
      if (name === 'PR') state.pr = value
    },
    async pushPage(_page: Ticket | string, title: string, _markdown: string) {
      state.calls.push(`push ${title}`)
      const page = { id: `page-${title}`, title, url: `https://www.notion.so/page-${encodeURIComponent(title)}`, lastEditedAt: new Date().toISOString() }
      pages[title] = page
      return { id: page.id, url: page.url, created: true }
    },
    async pullPage(_page: Ticket | string, title: string) {
      return pages[title] === undefined ? undefined : { ...pages[title]!, markdown: '' }
    },
    async createPage(_page: Ticket | string, title: string, _markdown: string) {
      return { id: `page-${title}`, url: `https://www.notion.so/page-${encodeURIComponent(title)}` }
    },
    async appendParagraph() {
      return { id: 'block-1' }
    },
    async deleteBlock() {},
    async replacePage(_page: Ticket | string, title: string, _markdown: string) {
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

/** A ticket folder with aspira.json, ticket.md (Status = `status`) and every file the skill's gate pushes, so a push never fails on a missing file unless the test deletes it. */
async function freshFolder(repo: string, skill: Skill, status: string): Promise<string> {
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD_URL }))
  const folder = join(repo, '.work', 'kit-2-x')
  await mkdir(folder, { recursive: true })
  const ticket = renderTicketMd({
    id: 'KIT-2',
    title: 'Every skill writes a progress note',
    url: TICKET_URL,
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
  return folder
}

describe('ticketCli finish (T7, F5, F7, F12, F53)', () => {
  let repo: string
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'finish-run-status-'))
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('an older launcher\'s --ok with --run-status complete is recorded as ready (--ok is ignored) and exits 0', async () => {
    const client = fakeBoard('In Progress: Plan')
    const folder = await freshFolder(repo, 'planner', 'In Progress: Plan')
    const out: string[] = []
    const code = await ticketCli('planner', ['finish', '--repo', repo, '--folder', folder, '--ok', '--run-status', 'complete'], { out: (line) => out.push(line), err: () => {} }, {}, client)
    expect(code).toBe(0)
    expect(client.calls).toContain('push Plan')
    expect(client.calls).toContain('move In Progress: Plan -> In Review: Plan')
  })

  it('needs-author for the planner pushes Plan and moves the card to In Review: Plan, and exits 5 (Decision Q4)', async () => {
    const client = fakeBoard('In Progress: Plan')
    const folder = await freshFolder(repo, 'planner', 'In Progress: Plan')
    const code = await ticketCli('planner', ['finish', '--repo', repo, '--folder', folder, '--run-status', 'needs-author'], { out: () => {}, err: () => {} }, {}, client)
    expect(client.calls).toContain('push Plan')
    expect(client.calls).toContain('move In Progress: Plan -> In Review: Plan')
    expect(code).toBe(5)
  })

  it('ready with the pushed file missing reports "Push failed", records incomplete, makes no move and exits 1', async () => {
    const client = fakeBoard('In Progress: Plan')
    const folder = await freshFolder(repo, 'planner', 'In Progress: Plan')
    await rm(join(folder, 'plan.review', 'plan.reviewed.md'))
    const out: string[] = []
    const code = await ticketCli('planner', ['finish', '--repo', repo, '--folder', folder, '--run-status', 'ready'], { out: (line) => out.push(line), err: () => {} }, {}, client)
    expect(out.some((line) => line.startsWith('Push failed'))).toBe(true)
    expect(client.calls).not.toContain('move In Progress: Plan -> In Review: Plan')
    expect(code).toBe(1)
  })

  it('code-analyzer --run-status clean is recorded ready; implementor blocked pushes nothing, moves nothing and exits 1', async () => {
    const analyzerClient = fakeBoard('In Progress: Implementation')
    const analyzerFolder = await freshFolder(repo, 'code-analyzer', 'In Progress: Implementation')
    const analyzerCode = await ticketCli('code-analyzer', ['finish', '--repo', repo, '--folder', analyzerFolder, '--failed', '--run-status', 'clean'], { out: () => {}, err: () => {} }, {}, analyzerClient)
    expect(analyzerCode).toBe(0)

    const implementorClient = fakeBoard('In Progress: Implementation')
    const implementorFolder = await freshFolder(repo, 'implementor', 'In Progress: Implementation')
    const implementorCode = await ticketCli('implementor', ['finish', '--repo', repo, '--folder', implementorFolder, '--run-status', 'blocked'], { out: () => {}, err: () => {} }, {}, implementorClient)
    expect(implementorClient.calls.some((call) => call.startsWith('push'))).toBe(false)
    expect(implementorClient.calls.some((call) => call.startsWith('move'))).toBe(false)
    expect(implementorCode).toBe(1)
  })
})
