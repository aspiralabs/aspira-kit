import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardError, type Board, type Ticket, type TicketPage } from './board'
import { renderGroomPage } from './decisions'
import type { GroomDecision, GroomRecord } from './groom-record'
import { ticketCli } from './ticket-cli'
import { afterRun, beforeRun, boardStateDir, verifyRun, type DriverContext } from './ticket-driver'
import { FlowRefused, finishFlow, findWorkFolders, inputFileFor, localBoardVerify, readAspira, readBoardTrace, readTicketMd, startFlow, type FlowFinish } from './ticket-flow'
import { TICKET_FILE, renderTicketMd, type BoardAction, type RunStatus, type Skill } from './ticket'
import type { GroomRunStatus } from './groom-record.ts'

// A board built from the recorded NOM-4 fixture values, in process: the same shape board.ts returns,
// with the Status, Dev, PR and child pages kept in memory so every move and push can be read back.

const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const URL = 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1'
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6?v=1'
const SPEC = '## Intent\n\nPeople can reach every recipe.\n\n- [ ] F1: lists page.\n'
const SPEC_REVIEWED = '## Intent\n\nPeople can reach every recipe, reviewed.\n'

/** One block of a child page: one non-empty markdown line, with who last edited it, as Notion's to_do listing reports it. */
type FakeBlock = { id: string; text: string; lastEditedBy?: string }
type FakePage = { page: TicketPage; markdown: string; blocks: FakeBlock[] }
type Fake = Board & {
  status: string
  props: Record<string, string>
  pages: Record<string, FakePage>
  calls: string[]
  /** The integration's own user: what `me()` returns and who every block the fake writes is last edited by. */
  botId: string
  /** The Idea summary written into the card body, once one was written. */
  ideaSummary: string | undefined
  /** A person acting right after a replace, before the finish step pulls the page again. */
  afterReplace?: () => void
}

let blockCount = 0
const nextBlockId = () => `block-${(blockCount += 1)}`
/** One block per non-empty line: how the groomer's page lines land as Notion blocks. */
const blocksOf = (markdown: string, by: string): FakeBlock[] => markdown.split('\n').filter((line) => line.trim() !== '').map((text) => ({ id: nextBlockId(), text, lastEditedBy: by }))
const isItem = (text: string) => text.startsWith('- ')
/** The page as the markdown export returns it: list items on consecutive lines, every other block in its own paragraph. */
const markdownOf = (blocks: FakeBlock[]): string => `${blocks.map((block, i) => `${i === 0 ? '' : isItem(block.text) && isItem(blocks[i - 1]!.text) ? '\n' : '\n\n'}${block.text}`).join('')}\n`
/** A to_do block's plain text, as the API returns it: no box, no emphasis markers. */
const plainText = (text: string) => text.replace(/^- \[[ xX]\] /, '').replace(/[_*]\(/g, '(').replace(/\)[_*]/g, ')')

function fakeBoard(status: string, pages: Record<string, string> = { Spec: SPEC, 'Spec Reviewed': SPEC_REVIEWED }): Fake {
  const pageEntry = (ref: string): FakePage => {
    const found = Object.values(state.pages).find((candidate) => candidate.page.id === ref || candidate.page.url === ref)
    if (found === undefined) throw new BoardError(`Notion 404 (object_not_found): Could not find page with ID: ${ref}.`, 404, 'object_not_found')
    return found
  }
  const state: Fake = {
    status,
    props: { Dev: '', PR: '' },
    pages: Object.fromEntries(Object.entries(pages).map(([title, markdown], i) => [title, { page: { id: `page-${i}`, title, url: `https://www.notion.so/page-${i}`, lastEditedAt: '2026-10-05T04:48:12.063Z' }, markdown, blocks: blocksOf(markdown, 'bot-1') }])),
    calls: [],
    botId: 'bot-1',
    ideaSummary: undefined,
    async resolveTicket(ref) {
      state.calls.push(`resolve ${ref}`)
      if (!/^nom-4$|^4$|3ec3e59b22588102becfce78d66142e1/i.test(ref.replaceAll('-', '').replace(/^NOM/i, 'nom-'))) throw new Error(`No ticket ${ref} on the board`)
      const ticket: Ticket = {
        id: 'NOM-4', number: 4, pageId: PAGE, title: 'Explore pagination', url: URL, status: state.status, type: 'Feature', priority: 'P0 - Critical', area: ['Discover'],
        dev: state.props.Dev || undefined, pr: state.props.PR || undefined, version: undefined, lastEditedAt: '2026-10-05T04:55:44.354Z',
        idea: 'Every list stops at 10.\n', pages: Object.fromEntries(Object.entries(state.pages).map(([title, entry]) => [title, entry.page])),
      }
      return ticket
    },
    async moveTicket(_page, from, to) {
      state.calls.push(`move ${from} -> ${to}`)
      if (state.status !== from) throw new Error(`NOM-4 is in "${state.status}", not "${from}"; not moving it to "${to}"`)
      state.status = to
      return { id: 'NOM-4', before: from, after: to }
    },
    async setProperty(_page, name, value) {
      state.calls.push(`set ${name}=${value}`)
      state.props[name] = value
    },
    async pushPage(_page, title, markdown) {
      state.calls.push(`push ${title}`)
      const existing = state.pages[title]
      if (existing !== undefined) {
        existing.markdown = markdown
        existing.blocks = blocksOf(markdown, state.botId)
        existing.page.lastEditedAt = new Date().toISOString()
        return { id: existing.page.id, url: existing.page.url, created: false }
      }
      const page = { id: `page-${title}`, title, url: `https://www.notion.so/page-${encodeURIComponent(title)}`, lastEditedAt: new Date().toISOString() }
      state.pages[title] = { page, markdown, blocks: blocksOf(markdown, state.botId) }
      return { id: page.id, url: page.url, created: true }
    },
    async pullPage(_page, title) {
      state.calls.push(`pull ${title}`)
      const entry = state.pages[title]
      return entry === undefined ? undefined : { ...entry.page, markdown: entry.markdown }
    },
    async createPage(_page, title, markdown) {
      state.calls.push(`create ${title}`)
      const id = `page-${title.toLowerCase().replaceAll(' ', '-')}`
      const page = { id, title, url: `https://www.notion.so/${id}`, lastEditedAt: new Date().toISOString() }
      state.pages[title] = { page, markdown, blocks: blocksOf(markdown, state.botId) }
      return { id, url: page.url }
    },
    async appendParagraph(pageId, text) {
      state.calls.push(`append ${text}`)
      const entry = pageEntry(pageId)
      const block = { id: nextBlockId(), text, lastEditedBy: state.botId }
      entry.blocks.push(block)
      entry.markdown = markdownOf(entry.blocks)
      return { id: block.id }
    },
    async deleteBlock(id) {
      state.calls.push(`delete ${id}`)
      const entry = Object.values(state.pages).find((candidate) => candidate.blocks.some((block) => block.id === id))
      if (entry === undefined) throw new BoardError(`Notion 404 (object_not_found): Could not find block with ID: ${id}.`, 404, 'object_not_found')
      entry.blocks = entry.blocks.filter((block) => block.id !== id)
      entry.markdown = markdownOf(entry.blocks)
    },
    async replacePage(_page, title, markdown) {
      state.calls.push(`replace ${title}`)
      const entry = state.pages[title]
      if (entry === undefined) throw new BoardError(`Notion 404 (object_not_found): no child page titled "${title}"`, 404, 'object_not_found')
      entry.markdown = markdown
      entry.blocks = blocksOf(markdown, state.botId)
      entry.page.lastEditedAt = new Date().toISOString()
      state.afterReplace?.()
      return { id: entry.page.id, url: entry.page.url, lastEditedAt: entry.page.lastEditedAt }
    },
    async writeIdeaSummary(_page, markdown) {
      state.calls.push('write-idea')
      state.ideaSummary = markdown
      return { ids: blocksOf(markdown, state.botId).map((block) => block.id), deleted: [] }
    },
    async listToDos(pageId) {
      state.calls.push(`list-todos ${pageId}`)
      return pageEntry(pageId)
        .blocks.filter((block) => /^- \[[ xX]\] /.test(block.text))
        .map((block) => ({ id: block.id, checked: /^- \[[xX]\]/.test(block.text), text: plainText(block.text), ...(block.lastEditedBy === undefined ? {} : { lastEditedBy: { id: block.lastEditedBy } }) }))
    },
    async me() {
      state.calls.push('me')
      return { id: state.botId }
    },
    async uploadFile(name) {
      state.calls.push(`upload ${name}`)
      return { id: `upload-${name}`, status: 'uploaded' }
    },
    async appendFileBlock(pageId, uploadId) {
      state.calls.push(`append file ${uploadId} to ${pageId}`)
      return { id: nextBlockId() }
    },
    async fileBlockNames() {
      return []
    },
    // No rules page: the attach gate stays closed, so these flow tests make no telemetry attach.
    async rulesPage() {
      return null
    },
  }
  return state
}

let repo: string
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'ticket-flow-')))
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD }))
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const folderOf = () => join(repo, '.work', 'nom-4-explore-pagination')
const setMtime = async (file: string, iso: string) => utimes(file, new Date(iso), new Date(iso))

describe('startFlow (separate process)', () => {
  it('refuses on the wrong Status before any board write, with the exact message', async () => {
    const client = fakeBoard('In Review: Spec')
    await expect(startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })).rejects.toThrow(
      'NOM-4 Explore pagination is "In Review: Spec"; planner needs "Ready: Spec". "Ready: Spec" is set by a human, after approving the spec. No model call was made.',
    )
    expect(client.calls).toEqual(['resolve NOM-4'])
    expect(existsSync(folderOf())).toBe(false)
  })

  it('writes every file when the folder is empty, sets Dev, makes the start move, and records each action with the Status before and after', async () => {
    const client = fakeBoard('Ready: Spec')
    const started = await startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'nom-4' }, board: BOARD, client, dev: 'Claude' })
    expect(started.folder).toBe(folderOf())
    expect(await readFile(join(started.folder, 'idea.md'), 'utf8')).toBe('Every list stops at 10.\n')
    expect(await readFile(join(started.folder, 'spec.md'), 'utf8')).toBe(SPEC)
    expect(await readFile(join(started.folder, 'spec.reviewed/spec.reviewed.md'), 'utf8')).toBe(SPEC_REVIEWED)
    const ticket = await readTicketMd(started.folder)
    expect(ticket).toMatchObject({ id: 'NOM-4', status: 'In Progress: Plan', dev: 'Claude', url: URL })
    expect(ticket?.pages.Spec?.lastEditedAt).toBe('2026-10-05T04:48:12.063Z')
    expect(client.calls).toEqual(['resolve nom-4', 'pull Spec', 'pull Spec Reviewed', 'set Dev=Claude', 'move Ready: Spec -> In Progress: Plan'])
    expect(started.trace.actions.map((a) => [a.action, a.statusBefore, a.statusAfter])).toEqual([
      ['resolve', 'Ready: Spec', 'Ready: Spec'],
      ['pull', 'Ready: Spec', 'Ready: Spec'],
      ['pull', 'Ready: Spec', 'Ready: Spec'],
      ['set', 'Ready: Spec', 'Ready: Spec'],
      ['move', 'Ready: Spec', 'In Progress: Plan'],
    ])
    expect(started.trace).toMatchObject({ statusBefore: 'Ready: Spec', statusAfter: 'In Progress: Plan' })
  })

  it('a retry in its own In Progress status makes no start move', async () => {
    const client = fakeBoard('In Progress: Plan')
    const started = await startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    expect(client.calls.filter((call) => call.startsWith('move') || call.startsWith('set'))).toEqual([])
    expect(started.trace.statusAfter).toBe('In Progress: Plan')
  })

  it('leaves an unchanged file alone, and refuses to overwrite a newer local file without --force-pull', async () => {
    const client = fakeBoard('In Review: Spec')
    const first = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    const spec = join(first.folder, 'spec.md')
    await writeFile(spec, `${SPEC}\nlocal edit\n`)
    // The page has not changed since the pull: the local file (with its edit) is kept.
    client.calls = []
    const second = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4', folder: first.folder }, board: BOARD, client })
    expect(second.kept).toEqual([spec, join(first.folder, 'spec.reviewed/spec.reviewed.md')])
    expect(client.calls).toEqual(['resolve NOM-4'])
    expect(await readFile(spec, 'utf8')).toContain('local edit')
    // The page changed after the pull and the local file is newer than the page: refused without --force-pull.
    client.pages.Spec!.page.lastEditedAt = '2026-10-06T01:00:00.000Z'
    client.pages.Spec!.markdown = 'new spec'
    await setMtime(spec, '2026-10-06T02:00:00.000Z')
    await expect(startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4', folder: first.folder }, board: BOARD, client })).rejects.toThrow(`Not overwriting a local file newer than its page: ${spec} (Spec). Pass --force-pull`)
    expect(await readFile(spec, 'utf8')).toContain('local edit')
    const forced = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4', folder: first.folder }, board: BOARD, client, force: true })
    expect(forced.pulled).toEqual([spec])
    expect(await readFile(spec, 'utf8')).toBe('new spec')
    // The page changed and the local file is older than the page: written.
    client.pages.Spec!.page.lastEditedAt = '2026-10-06T03:00:00.000Z'
    client.pages.Spec!.markdown = 'newer spec'
    await setMtime(spec, '2026-10-06T02:30:00.000Z')
    const updated = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4', folder: first.folder }, board: BOARD, client })
    expect(updated.pulled).toEqual([spec])
    expect(await readFile(spec, 'utf8')).toBe('newer spec')
  })

  it('the pr-reviewer needs the PR property; the implementor claims from Ready: Plan', async () => {
    const client = fakeBoard('In Review: Implementation', { Spec: SPEC, Plan: '# Plan\n' })
    await expect(startFlow({ skill: 'pr-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })).rejects.toThrow('PR property is not set')
    client.props.PR = 'https://github.com/aspiralabs/nomnomzz/pull/2'
    const started = await startFlow({ skill: 'pr-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    expect(started.ticket.pr).toBe('https://github.com/aspiralabs/nomnomzz/pull/2')
    expect(client.calls.some((call) => call.startsWith('move'))).toBe(false)
    const planned = fakeBoard('Ready: Plan', { Spec: SPEC, Plan: '# Plan\n' })
    const build = await startFlow({ skill: 'implementor', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client: planned })
    expect(build.ticket.status).toBe('In Progress: Implementation')
    expect(await readFile(join(build.folder, 'plan.review/plan.reviewed.md'), 'utf8')).toBe('# Plan\n')
  })
})

describe('finishFlow (separate process)', () => {
  it('pushes the fixed titles, replaces an existing page, makes the success move, and writes the trace into the export', async () => {
    const client = fakeBoard('Ready: Spec')
    const started = await startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    const exportDir = join(started.folder, 'plan.review')
    await mkdir(join(exportDir, 'trace'), { recursive: true })
    await writeFile(join(exportDir, 'plan.reviewed.md'), '# Plan\n\n- T1\n')
    client.calls = []
    const finished = await finishFlow({ skill: 'planner', folder: started.folder, ok: true, runStatus: 'ready', exportDir, board: BOARD, client, trace: started.trace })
    expect(client.calls).toEqual(['push Plan', 'move In Progress: Plan -> In Review: Plan'])
    expect(client.pages.Plan?.markdown).toBe('# Plan\n\n- T1\n')
    expect(finished.header[0]).toBe(`Ticket: NOM-4 Explore pagination (${URL})`)
    expect(finished.header[1]).toBe('Status: Ready: Spec -> In Review: Plan')
    expect(finished.header[2]).toBe(`Pages pushed: Plan (${client.pages.Plan?.page.url})`)
    expect(finished.header[3]).toBe(`Working folder: ${started.folder}`)
    expect(finished.traceFile).toBe(join(exportDir, 'trace', 'board.json'))
    const trace = (await readBoardTrace(exportDir))!.trace
    expect(trace.actions.map((a) => [a.action, a.statusBefore, a.statusAfter, a.ok])).toEqual([
      ['resolve', 'Ready: Spec', 'Ready: Spec', true],
      ['pull', 'Ready: Spec', 'Ready: Spec', true],
      ['pull', 'Ready: Spec', 'Ready: Spec', true],
      ['set', 'Ready: Spec', 'Ready: Spec', true],
      ['move', 'Ready: Spec', 'In Progress: Plan', true],
      ['push', 'In Progress: Plan', 'In Progress: Plan', true],
      ['move', 'In Progress: Plan', 'In Review: Plan', true],
    ])
    expect((await readTicketMd(started.folder))?.status).toBe('In Review: Plan')
    // Pushing again replaces the page and keeps its URL.
    await writeFile(join(exportDir, 'plan.reviewed.md'), '# Plan v2\n')
    client.status = 'In Progress: Plan'
    const again = await finishFlow({ skill: 'planner', folder: started.folder, ok: true, runStatus: 'ready', exportDir, board: BOARD, client })
    expect(again.trace.pushed[0]?.url).toBe(trace.pushed[0]?.url)
    expect(client.pages.Plan?.markdown).toBe('# Plan v2\n')
  })

  it('a failed run makes no push and no move, and says the ticket stays In Progress', async () => {
    const client = fakeBoard('Ready: Spec')
    const started = await startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    client.calls = []
    const finished = await finishFlow({ skill: 'planner', folder: started.folder, ok: false, runStatus: 'incomplete', board: BOARD, client })
    expect(client.calls).toEqual([])
    expect(client.status).toBe('In Progress: Plan')
    expect(finished.remaining).toContain('stays in "In Progress: Plan"')
    expect(finished.header[1]).toBe('Status: In Progress: Plan -> In Progress: Plan (no move)')
  })

  it('the spec reviewer pushes the decisions page only for needs-author, and never moves', async () => {
    const client = fakeBoard('In Review: Spec')
    const started = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    await mkdir(join(started.folder, 'spec.reviewed/trace'), { recursive: true })
    await writeFile(join(started.folder, 'spec.reviewed/spec.reviewed.md'), 'reviewed v2')
    await writeFile(join(started.folder, 'spec.reviewed/trace/decisions.md'), '# Decisions\n')
    client.calls = []
    await finishFlow({ skill: 'spec-reviewer', folder: started.folder, ok: true, runStatus: 'ready', board: BOARD, client })
    expect(client.calls).toEqual(['push Spec Reviewed'])
    client.calls = []
    const needs = await finishFlow({ skill: 'spec-reviewer', folder: started.folder, ok: true, runStatus: 'needs-author', board: BOARD, client })
    expect(client.calls).toEqual(['push Spec Reviewed', 'push Spec Review Decisions'])
    expect(needs.trace.pushed.map((p) => p.title)).toEqual(['Spec Reviewed', 'Spec Review Decisions'])
    expect(client.status).toBe('In Review: Spec')
  })

  it('reports a push failure with the local path and still makes the success move', async () => {
    const client = fakeBoard('Ready: Spec')
    const started = await startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    const plan = join(started.folder, 'plan.review/plan.reviewed.md')
    await mkdir(join(started.folder, 'plan.review'), { recursive: true })
    await writeFile(plan, '# Plan\n')
    client.pushPage = async () => { throw new Error('Notion 500 (internal): down') }
    const finished = await finishFlow({ skill: 'planner', folder: started.folder, ok: true, runStatus: 'ready', board: BOARD, client })
    expect(finished.pushFailures).toEqual([`Plan: Notion 500 (internal): down; the output is at ${plan}`])
    expect(client.status).toBe('In Review: Plan')
    expect(finished.trace.actions.at(-2)).toMatchObject({ action: 'push', ok: false, error: 'Notion 500 (internal): down' })
  })

  it('the implementor sets PR and moves to In Review: Implementation only when it opened the PR', async () => {
    const client = fakeBoard('Ready: Plan', { Plan: '# Plan\n' })
    const started = await startFlow({ skill: 'implementor', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    await writeFile(join(started.folder, 'plan.review/implementation.md'), '# Implementation\n')
    client.calls = []
    const noPr = await finishFlow({ skill: 'implementor', folder: started.folder, ok: true, runStatus: 'complete', board: BOARD, client })
    expect(client.calls).toEqual(['push Implementation'])
    expect(client.status).toBe('In Progress: Implementation')
    expect(noPr.remaining).toContain('opening the PR is the remaining step')
    client.calls = []
    const withPr = await finishFlow({ skill: 'implementor', folder: started.folder, ok: true, runStatus: 'complete', prUrl: 'https://github.com/aspiralabs/nomnomzz/pull/9', board: BOARD, client })
    expect(client.calls).toEqual(['push Implementation', 'set PR=https://github.com/aspiralabs/nomnomzz/pull/9', 'move In Progress: Implementation -> In Review: Implementation'])
    expect(withPr.remaining).toBeNull()
    expect((await readTicketMd(started.folder))?.pr).toBe('https://github.com/aspiralabs/nomnomzz/pull/9')
  })
})

describe('the --local board stage (planner against a stub session)', () => {
  const context = { skill: 'planner' as const, repo, env: {} }
  const session = {
    /** The stub session: performs the listed actions on the fake board and writes what the driver asked for. */
    async perform(client: Fake, actions: BoardAction[]) {
      for (const action of actions) {
        if (action.action === 'resolve') {
          const ticket = await client.resolveTicket(action.ticket)
          const folder = action.folder.includes('<') ? folderOf() : action.folder
          await mkdir(folder, { recursive: true })
          await writeFile(join(folder, TICKET_FILE), renderTicketMd({ ...ticket, pulledAt: new Date().toISOString() }))
        }
        if (action.action === 'pull') {
          const page = await client.pullPage(PAGE, action.title)
          await mkdir(join(action.file, '..'), { recursive: true })
          await writeFile(action.file, page!.markdown)
        }
        if (action.action === 'set') {
          await client.setProperty(PAGE, action.name, action.value)
          const ticket = (await readTicketMd(folderOf()))!
          await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd({ ...ticket, dev: action.value }))
        }
        if (action.action === 'move') {
          await client.moveTicket(PAGE, action.from, action.to)
          const ticket = (await readTicketMd(folderOf()))!
          await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd({ ...ticket, status: action.to }))
        }
        if (action.action === 'push') {
          const result = await client.pushPage(PAGE, action.title, await readFile(action.file, 'utf8'))
          const ticket = (await readTicketMd(folderOf()))!
          ticket.pages[action.title] = { id: result.id, title: action.title, url: result.url, lastEditedAt: new Date().toISOString() }
          await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd(ticket))
        }
      }
    },
  }

  it('lists the resolve, then the pulls and the claim, refuses on the wrong Status, and ends with the push and the move', async () => {
    const client = fakeBoard('Ready: Spec')
    const ctx = { ...context, repo }
    // 1. Resolve: the first stage before anything else, with the ticket.md format.
    const first = await beforeRun(ctx, { positional: 'NOM-4' })
    expect(first.kind).toBe('stage')
    if (first.kind !== 'stage') return
    expect(first.stage).toMatchObject({ stage: 'board', ticket: 'NOM-4', folder: null, actions: [{ action: 'resolve', ticket: 'NOM-4', board: BOARD }] })
    expect((first.stage.actions[0] as { format: string }).format).toContain('| Status | <Status, exactly as the board shows it> |')
    // The same call again lists the same stage; nothing else happens until the session writes ticket.md.
    expect((await beforeRun(ctx, { positional: 'NOM-4' })).kind).toBe('stage')
    await session.perform(client, first.stage.actions)
    // 2. Sync: the pulls and the claim, as data, with the Status ticket.md must show.
    const second = await beforeRun(ctx, { positional: 'NOM-4' })
    if (second.kind !== 'stage') throw new Error(`expected a stage, got ${second.kind}`)
    expect(second.stage.folder).toBe(folderOf())
    expect(second.stage.actions.map((a) => a.action)).toEqual(['pull', 'pull', 'set', 'move'])
    expect(second.stage.actions[2]).toMatchObject({ action: 'set', name: 'Dev', value: 'Claude' })
    expect(second.stage.actions[3]).toMatchObject({ action: 'move', from: 'Ready: Spec', to: 'In Progress: Plan' })
    expect(second.stage.verify).toEqual({ file: join(folderOf(), TICKET_FILE), status: 'In Progress: Plan' })
    expect(await readFile(join(folderOf(), 'idea.md'), 'utf8')).toBe('Every list stops at 10.\n')
    // The driver refuses to continue while ticket.md shows the wrong Status (the session pulled but did not move).
    await session.perform(client, second.stage.actions.filter((a) => a.action === 'pull'))
    const notMoved = await beforeRun(ctx, { positional: 'NOM-4' })
    if (notMoved.kind !== 'stage') throw new Error('expected the move to be listed again')
    expect(notMoved.stage.actions.map((a) => a.action)).toEqual(['set', 'move'])
    // Someone moved the card elsewhere meanwhile: refused, before any model stage.
    const ticket = (await readTicketMd(folderOf()))!
    await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd({ ...ticket, status: 'Ready: Implementation' }))
    await expect(beforeRun(ctx, { positional: 'NOM-4' })).rejects.toThrow('NOM-4 Explore pagination is "Ready: Implementation"; planner needs "Ready: Spec"')
    await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd(ticket))
    await session.perform(client, notMoved.stage.actions)
    // 3. Ready: the ticket, its input file and the trace so far.
    const ready = await beforeRun(ctx, { positional: 'NOM-4' })
    if (ready.kind !== 'ticket') throw new Error(`expected the ticket, got ${ready.kind}`)
    expect(ready.input).toBe(join(folderOf(), 'spec.reviewed/spec.reviewed.md'))
    expect(ready.statusBefore).toBe('Ready: Spec')
    expect(ready.ticket.status).toBe('In Progress: Plan')
    expect(ready.trace.actions.map((a) => [a.action, a.statusBefore, a.statusAfter])).toEqual([
      ['resolve', 'Ready: Spec', 'Ready: Spec'],
      ['pull', 'Ready: Spec', 'Ready: Spec'],
      ['pull', 'Ready: Spec', 'Ready: Spec'],
      ['set', 'Ready: Spec', 'Ready: Spec'],
      ['move', 'Ready: Spec', 'In Progress: Plan'],
    ])
    // A later call makes no new actions: the stage is idempotent once the folder is in sync.
    expect((await beforeRun(ctx, { positional: 'NOM-4' })).kind).toBe('ticket')
    // No argument: the one working folder is the ticket.
    expect((await beforeRun(ctx, {})).kind).toBe('ticket')
    // 4. The end stage: the push and the success move as data, the trace in the export.
    const exportDir = join(folderOf(), 'plan.review')
    await mkdir(join(exportDir, 'trace'), { recursive: true })
    await writeFile(join(exportDir, 'plan.reviewed.md'), '# Plan\n')
    const end = await afterRun(ctx, ready, { ok: true, status: 'ready', exportDir, verifyCommand: 'planner.sh local NOM-4 --verify' })
    expect(end.board.actions).toEqual([
      { action: 'push', page: URL, title: 'Plan', file: join(exportDir, 'plan.reviewed.md'), then: expect.stringContaining('"Plan" row') },
      { action: 'move', page: URL, from: 'In Progress: Plan', to: 'In Review: Plan', then: expect.stringContaining('In Review: Plan') },
    ])
    expect(end.board.verify).toEqual({ command: 'planner.sh local NOM-4 --verify', file: join(folderOf(), TICKET_FILE), status: 'In Review: Plan' })
    expect(end.ticket).toBe('NOM-4 Explore pagination')
    // 5. Verify before the session moved: refused with the Status it shows.
    const early = await verifyRun(ctx, { positional: 'NOM-4' }, () => exportDir)
    expect(early.verified).toBe(false)
    expect(early.problem).toContain('shows "In Progress: Plan", expected "In Review: Plan"')
    await session.perform(client, end.board.actions)
    const verified = await verifyRun(ctx, {}, () => exportDir)
    expect(verified.verified).toBe(true)
    expect(verified.report).toEqual([
      `Ticket: NOM-4 Explore pagination (${URL})`,
      'Status: Ready: Spec -> In Review: Plan',
      `Pages pushed: Plan (${client.pages.Plan?.page.url})`,
      `Working folder: ${folderOf()}`,
    ])
    const trace = (await readBoardTrace(exportDir))!.trace
    expect(trace.verified).toBe(true)
    expect(trace.actions.filter((a) => a.action === 'move').map((a) => [a.statusBefore, a.statusAfter])).toEqual([['Ready: Spec', 'In Progress: Plan'], ['In Progress: Plan', 'In Review: Plan']])
    expect(client.status).toBe('In Review: Plan')
  })

  it('a failed run lists no push and no move, and the ticket stays In Progress', async () => {
    const client = fakeBoard('In Progress: Plan')
    const ctx = { ...context, repo }
    const first = await beforeRun(ctx, { positional: 'NOM-4' })
    if (first.kind !== 'stage') throw new Error('expected a stage')
    await session.perform(client, first.stage.actions)
    const second = await beforeRun(ctx, { positional: 'NOM-4' })
    if (second.kind !== 'stage') throw new Error('expected a stage')
    expect(second.stage.actions.map((a) => a.action)).toEqual(['pull', 'pull'])
    await session.perform(client, second.stage.actions)
    const ready = await beforeRun(ctx, { positional: 'NOM-4' })
    if (ready.kind !== 'ticket') throw new Error('expected the ticket')
    const exportDir = join(folderOf(), 'plan.review')
    await mkdir(exportDir, { recursive: true })
    const end = await afterRun(ctx, ready, { ok: false, status: 'incomplete', exportDir, verifyCommand: 'planner.sh local NOM-4 --verify' })
    expect(end.board.actions).toEqual([])
    expect(end.board.verify).toBeNull()
    expect((await readBoardTrace(exportDir))!.trace.verified).toBe(true)
    expect(end.board.remaining).toContain('stays in "In Progress: Plan"')
    expect((await verifyRun(ctx, { positional: 'NOM-4' }, () => exportDir)).verified).toBe(true)
  })

  it('--no-ticket runs make no board work and record ticket: none; a path without it is refused', async () => {
    const ctx = { ...context, repo }
    const none = await beforeRun(ctx, { positional: '/tmp/spec.md', noTicket: true })
    expect(none).toMatchObject({ kind: 'none', path: '/tmp/spec.md', trace: { ticket: null } })
    await expect(beforeRun(ctx, { positional: 'docs/spec.md' })).rejects.toThrow('pass --no-ticket')
    await rm(join(repo, 'aspira.json'))
    await expect(beforeRun(ctx, { positional: 'NOM-4' })).rejects.toThrow('has no aspira.json')
    expect((await beforeRun(ctx, { positional: '/tmp/spec.md', noTicket: true })).kind).toBe('none')
  })
})

describe('the ticket CLI for the launchers', () => {
  it('prints key=value lines for start and the report for finish, and exits 3 on a refusal', async () => {
    const lines: string[] = []
    const errors: string[] = []
    const io = { out: (text: string) => lines.push(text), err: (text: string) => errors.push(text) }
    // No board client seam in the CLI: it builds board.ts on the env token, so a refusal path that needs no network is what is checked here.
    await rm(join(repo, 'aspira.json'))
    expect(await ticketCli('planner', ['start', 'NOM-4', '--repo', repo], io, {})).toBe(3)
    expect(errors[0]).toContain('has no aspira.json')
    await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD }))
    expect(await ticketCli('planner', ['start', 'docs/spec.md', '--repo', repo], io, {})).toBe(2)
    expect(errors.at(-1)).toContain('pass --no-ticket')
    expect(await ticketCli('planner', ['bogus', '--repo', repo], io, {})).toBe(2)
    expect(errors.at(-1)).toContain('Usage: ticket.ts start')
  })
})

describe('the working folders and aspira.json', () => {
  it('finds every folder with a ticket.md and reads aspira.json', async () => {
    expect(await findWorkFolders(repo)).toEqual([])
    await mkdir(join(repo, '.work', 'nom-4-explore-pagination'), { recursive: true })
    await mkdir(join(repo, '.work', 'scratch'), { recursive: true })
    await writeFile(join(repo, '.work', 'nom-4-explore-pagination', TICKET_FILE), renderTicketMd({ id: 'NOM-4', title: 'Explore pagination', url: URL, status: 'Ready: Spec', area: [], idea: '', pulledAt: '', pages: {} }))
    expect(await findWorkFolders(repo)).toEqual([{ folder: join(repo, '.work', 'nom-4-explore-pagination'), id: 'NOM-4', url: URL }])
    expect(await readAspira(repo)).toEqual({ board: BOARD })
    await writeFile(join(repo, 'aspira.json'), JSON.stringify({ releases: 'x' }))
    await expect(readAspira(repo)).rejects.toThrow(FlowRefused)
    expect((await stat(join(repo, '.work'))).isDirectory()).toBe(true)
  })
})

describe('inputFileFor', () => {
  it('takes the first file of the list that exists, and names the missing page otherwise', async () => {
    const folder = join(repo, '.work', 'nom-4-explore-pagination')
    await mkdir(join(folder, 'spec.reviewed'), { recursive: true })
    expect(() => inputFileFor('spec-reviewer', folder)).toThrow('the ticket has no "Spec" page yet. The spec writer puts it there.')
    await writeFile(join(folder, 'spec.md'), 'spec')
    expect(inputFileFor('spec-reviewer', folder)).toBe(join(folder, 'spec.md'))
    await writeFile(join(folder, 'spec.reviewed/spec.reviewed.md'), 'answered')
    expect(inputFileFor('spec-reviewer', folder)).toBe(join(folder, 'spec.reviewed/spec.reviewed.md'))
    expect(() => inputFileFor('planner', join(repo, 'nowhere'))).toThrow('the ticket has no "Spec Reviewed" page yet')
    expect(() => inputFileFor('code-analyzer', folder)).toThrow('takes no input file')
  })
})

// ---------------------------------------------------------------------------------------------
// The groomer row: Grooming Decisions as a page of blocks on the fake, the run's record in
// groom/trace/groom.json, the CLI the launcher calls, and the --local driver.
// ---------------------------------------------------------------------------------------------

// No case in this file may reach the real Notion API: board.ts falls back to NOTION_TOKEN from the
// process environment when a caller passes none, so a CLI path that builds its own client would
// otherwise write to the live board with the developer's token. With the token blank it refuses.
beforeEach(() => {
  vi.stubEnv('NOTION_TOKEN', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const GD = 'Grooming Decisions'
const GD_INTRO = 'Tick one option per question. Only ticks are read as answers: anything else you write on this page is kept under the Notes block at the end and never read as an answer. Ticks made while a run is writing (the "Run: ... in progress" line is present) may need to be made again.'
/** The shared branch list: the Grooming exit criteria, the spec template sections and the reviewer lenses. */
const BRANCHES = ['problem', 'who', 'done', 'intent', 'f-list', 'tests', 'constraints', 'out-of-scope', 'blast-radius', 'security', 'architecture', 'data', 'behavior', 'ui', 'acceptance']
const today = () => new Date().toISOString().slice(0, 10)

const Q1: GroomDecision = {
  id: 'Q1',
  question: 'Who can see a saved list?',
  options: ['Only its owner', 'Everyone in the household'],
  recommended: 'Only its owner',
  reasoning: 'lists hold private notes today',
  whyYours: 'it decides who sees private notes',
  branch: 'who',
  facts: [{ path: 'src/lists/model.ts', line: 12, quote: 'ownerId: string' }],
  decidedBy: 'open',
  answer: null,
}
const Q11: GroomDecision = {
  id: 'Q1.1',
  question: 'May a household member rename a list they do not own?',
  options: ['Only the owner renames', 'Any member renames'],
  recommended: 'Only the owner renames',
  reasoning: 'a rename by someone else surprises the owner',
  whyYours: 'it is a household policy, not a technical limit',
  branch: 'who',
  facts: [{ path: 'src/lists/model.ts', line: 12 }],
  decidedBy: 'open',
  answer: null,
}
const Q2: GroomDecision = {
  id: 'Q2',
  question: 'Do saved lists expire?',
  options: ['Keep forever', 'Expire after 30 days'],
  recommended: 'Keep forever',
  reasoning: 'cookbooks keep everything until removed',
  whyYours: 'it decides what members pay storage for',
  branch: 'data',
  facts: [{ path: 'src/lists/store.ts', line: 40 }],
  decidedBy: 'open',
  answer: null,
}
const Q3: GroomDecision = {
  id: 'Q3',
  question: 'Where does the list live in the menu?',
  options: ['Under Recipes', 'Under Profile'],
  recommended: 'Under Recipes',
  reasoning: 'recipes is where lists are used',
  whyYours: 'it changes the navigation members know',
  branch: 'ui',
  facts: [{ path: 'src/nav.ts', line: 7 }],
  decidedBy: 'open',
  answer: null,
}
const confirmed = (decision: GroomDecision, answer: string = decision.recommended): GroomDecision => ({ ...decision, decidedBy: 'author', answer })

/** A record as the groomer writes it: every branch visited unless given, the open count from the decisions. */
const groomRecord = (decisions: GroomDecision[], fields: Partial<GroomRecord> = {}): GroomRecord => ({
  decisions,
  branches: BRANCHES.map((id) => ({ id, state: 'visited' as const })),
  round: 1,
  startedAt: '2026-10-10T08:00:00.000Z',
  open: decisions.filter((decision) => decision.decidedBy === 'open').length,
  page: {},
  status: 'needs-author',
  ...fields,
})

/** A previous run's rendering of Grooming Decisions, as it sits on the page. */
const renderedPage = (record: GroomRecord) => renderGroomPage(record, { date: '2026-10-10', notes: [] })

/** The CONFIRM block set to a given state: the box, and the line under it (`Confirmed <date>` or none). */
function withConfirm(markdown: string, ticked: boolean, line?: string): string {
  const lines = markdown.split('\n').filter((text) => !/^(Confirmed \d{4}-\d{2}-\d{2}|Confirm was unticked on .*)$/.test(text))
  const at = lines.findIndex((text) => /^- \[[ xX]\] Confirm$/.test(text))
  if (at === -1) throw new Error('the rendered page has no CONFIRM block')
  lines[at] = `- [${ticked ? 'x' : ' '}] Confirm`
  if (line !== undefined) lines.splice(at + 1, 0, '', line)
  return lines.join('\n')
}

function seedGroomPage(client: Fake, markdown: string): void {
  client.pages[GD] = { page: { id: 'page-gd', title: GD, url: 'https://www.notion.so/page-gd', lastEditedAt: '2026-10-11T09:00:00.000Z' }, markdown, blocks: blocksOf(markdown, client.botId) }
}

function groomPageOf(client: Fake): FakePage {
  const entry = client.pages[GD]
  if (entry === undefined) throw new Error('the card has no Grooming Decisions page')
  return entry
}

const pageTexts = (client: Fake) => groomPageOf(client).blocks.map((block) => block.text)
const pageBlocks = (client: Fake) => groomPageOf(client).blocks.map((block) => ({ id: block.id, text: block.text }))

/** A person ticks the one unticked box whose line starts with `start`; `by` is the Notion user the to_do listing reports. */
function tickOnPage(client: Fake, start: string, by: string | null = 'human-7'): void {
  const entry = groomPageOf(client)
  const hits = entry.blocks.filter((block) => block.text.startsWith(`- [ ] ${start}`))
  if (hits.length !== 1) throw new Error(`expected one unticked box starting with "${start}", found ${hits.length}`)
  const block = hits[0]!
  block.text = `- [x] ${block.text.slice('- [ ] '.length)}`
  if (by === null) delete block.lastEditedBy
  else block.lastEditedBy = by
  entry.markdown = markdownOf(entry.blocks)
}

/** A block someone else adds to the page (another run's marker, a person's line under a block). */
function addPageBlock(client: Fake, text: string, after?: string): void {
  const entry = groomPageOf(client)
  const at = after === undefined ? entry.blocks.length : entry.blocks.findIndex((block) => block.text === after) + 1
  entry.blocks.splice(at, 0, { id: nextBlockId(), text, lastEditedBy: 'human-7' })
  entry.markdown = markdownOf(entry.blocks)
}

/** One question's block in a page's markdown: from its heading to the next heading or the trailer. */
function questionBlock(markdown: string, id: string): string {
  const start = markdown.indexOf(`## ${id} — `)
  if (start === -1) return ''
  const next = markdown.slice(start + 1).search(/\n## |\nRound \d/)
  return next === -1 ? markdown.slice(start) : markdown.slice(start, start + 1 + next)
}

const groomJsonPath = (folder: string) => join(folder, 'groom', 'trace', 'groom.json')
const decisionsPath = (folder: string) => join(folder, 'groom', 'trace', 'decisions.md')
const summaryPath = (folder: string) => join(folder, 'groom', 'idea-summary.md')

async function readGroomJson(folder: string): Promise<GroomRecord> {
  const parsed: GroomRecord = JSON.parse(await readFile(groomJsonPath(folder), 'utf8'))
  return parsed
}

/** The Idea summary for a set of confirmed decisions, in the form the validator accepts. */
const ideaSummaryOf = (decisions: GroomDecision[]) =>
  [
    `Groomed with /aspira-groomer on ${today()}`,
    '',
    '### Decisions',
    '',
    ...decisions.filter((decision) => decision.decidedBy === 'author').map((decision) => `- **${decision.id} — ${decision.question}** Answer: ${decision.answer}. Why: ${decision.reasoning}.`),
    '',
    '### Terms',
    '',
    'None introduced.',
    '',
  ].join('\n')

/**
 * What the groomer's agent leaves in the working folder at the end of its run: the record (keeping what
 * the start step wrote into it), the rendering in groom/trace/decisions.md and, on a confirm, the Idea summary.
 */
async function agentRun(folder: string, decisions: GroomDecision[], fields: { status: GroomRunStatus; round?: number; summary?: boolean }): Promise<GroomRecord> {
  const current = await readGroomJson(folder)
  const record: GroomRecord = { ...current, decisions, branches: BRANCHES.map((id) => ({ id, state: 'visited' as const })), round: fields.round ?? 1, open: decisions.filter((decision) => decision.decidedBy === 'open').length, status: fields.status }
  await writeFile(groomJsonPath(folder), `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(decisionsPath(folder), renderGroomPage(record, { date: today(), notes: [] }))
  if (fields.summary === true) await writeFile(summaryPath(folder), ideaSummaryOf(decisions))
  return record
}

const startGroomer = (client: Fake, extra: { forceRun?: boolean; force?: boolean } = {}) => startFlow({ skill: 'groomer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client, ...extra })
const finishGroomer = (client: Fake, folder: string, runStatus: RunStatus, ok = true) => finishFlow({ skill: 'groomer', folder, ok, runStatus, exportDir: join(folder, 'groom'), board: BOARD, client })

/** Every string a finish returned or recorded, so a sentence can be looked for wherever the step put it. */
function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(textsOf)
  return []
}
const said = (value: FlowFinish | FlowFinish['trace'], sentence: string) => textsOf(value).some((text) => text.includes(sentence))

async function cli(skill: Skill, args: string[], client?: Fake) {
  const out: string[] = []
  const err: string[] = []
  const code = await ticketCli(skill, [...args, '--repo', repo], { out: (text) => out.push(text), err: (text) => err.push(text) }, {}, client)
  return { code, out, err, all: [...out, ...err].join('\n') }
}

describe('the groomer start (separate process)', () => {
  it('a first run from Idea creates Grooming Decisions holding only the title, the intro and the Run marker, before the move to Grooming', async () => {
    const client = fakeBoard('Idea', {})
    const started = await startGroomer(client)
    const record = await readGroomJson(started.folder)
    expect(client.status).toBe('Grooming')
    expect(pageTexts(client)).toEqual(['# Grooming Decisions', GD_INTRO, `Run: ${record.startedAt} agent in progress`])
    expect(client.calls.indexOf('create Grooming Decisions')).toBeGreaterThan(-1)
    expect(client.calls.indexOf('create Grooming Decisions')).toBeLessThan(client.calls.indexOf('move Idea -> Grooming'))
  })

  it('records the page, the start time and the marker block in groom/trace/groom.json', async () => {
    const client = fakeBoard('Idea', {})
    const started = await startGroomer(client)
    const record = await readGroomJson(started.folder)
    expect(record.page).toMatchObject({ id: groomPageOf(client).page.id, url: groomPageOf(client).page.url })
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false)
    expect(record.markerBlockId).toBe(groomPageOf(client).blocks.find((block) => block.text.startsWith('Run: '))?.id)
  })

  it('never sets Dev: no set call, no set entry in the trace, Dev still empty', async () => {
    const client = fakeBoard('Idea', {})
    const started = await startGroomer(client)
    expect(client.props.Dev).toBe('')
    expect(client.calls.filter((call) => call.startsWith('set'))).toEqual([])
    expect(started.trace.actions.filter((action) => action.action === 'set')).toEqual([])
  })

  it('from Grooming or Shortlist makes no move, leaves Dev alone and appends its marker to the existing page', async () => {
    for (const status of ['Grooming', 'Shortlist']) {
      await rm(join(repo, '.work'), { recursive: true, force: true })
      const client = fakeBoard(status, {})
      client.props.Dev = 'Ana'
      seedGroomPage(client, renderedPage(groomRecord([Q1])))
      const before = pageTexts(client)
      const started = await startGroomer(client)
      const record = await readGroomJson(started.folder)
      expect(client.status, status).toBe(status)
      expect(client.props.Dev, status).toBe('Ana')
      expect(client.calls.filter((call) => call.startsWith('move') || call.startsWith('set')), status).toEqual([])
      expect(pageTexts(client), status).toEqual([...before, `Run: ${record.startedAt} agent in progress`])
      expect(record.markerBlockId, status).toBe(groomPageOf(client).blocks.at(-1)?.id)
    }
  })

  it('the planner start on a card that also has Grooming Decisions is exactly today\'s', async () => {
    const client = fakeBoard('Ready: Spec', { Spec: SPEC, 'Spec Reviewed': SPEC_REVIEWED, [GD]: renderedPage(groomRecord([Q1])) })
    const started = await startFlow({ skill: 'planner', repo, argument: { kind: 'ticket', ref: 'nom-4' }, board: BOARD, client, dev: 'Claude' })
    expect(client.calls).toEqual(['resolve nom-4', 'pull Spec', 'pull Spec Reviewed', 'set Dev=Claude', 'move Ready: Spec -> In Progress: Plan'])
    expect(started.trace.actions.map((a) => a.action)).toEqual(['resolve', 'pull', 'pull', 'set', 'move'])
    expect(existsSync(decisionsPath(started.folder))).toBe(false)
  })

  it('refuses while another run\'s marker is on the page, before any move or page write', async () => {
    const client = fakeBoard('Idea', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    addPageBlock(client, 'Run: 2026-10-11T09:00:00Z agent in progress')
    const before = pageBlocks(client)
    await expect(startGroomer(client)).rejects.toThrow(new FlowRefused('a groomer run started at 2026-10-11T09:00:00Z is in progress on NOM-4; wait or rerun with --force-run'))
    expect(client.status).toBe('Idea')
    expect(pageBlocks(client)).toEqual(before)
    expect(client.calls.filter((call) => /^(move|set|create|append|delete|replace)/.test(call))).toEqual([])
  })

  it('with --force-run clears the other run\'s marker and writes its own', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    addPageBlock(client, 'Run: 2026-10-11T09:00:00Z agent in progress')
    const started = await startGroomer(client, { forceRun: true })
    const record = await readGroomJson(started.folder)
    expect(pageTexts(client).filter((text) => text.startsWith('Run: '))).toEqual([`Run: ${record.startedAt} agent in progress`])
  })

  it('clears its own marker (the startedAt in the local groom.json) without --force-run', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    addPageBlock(client, 'Run: 2026-10-11T09:00:00Z agent in progress')
    await mkdir(join(folderOf(), 'groom', 'trace'), { recursive: true })
    await writeFile(groomJsonPath(folderOf()), JSON.stringify(groomRecord([Q1], { startedAt: '2026-10-11T09:00:00Z', status: 'incomplete', page: { id: 'page-gd', url: 'https://www.notion.so/page-gd' } })))
    const started = await startGroomer(client)
    const record = await readGroomJson(started.folder)
    expect(record.startedAt).not.toBe('2026-10-11T09:00:00Z')
    expect(pageTexts(client).filter((text) => text.startsWith('Run: '))).toEqual([`Run: ${record.startedAt} agent in progress`])
  })

  it('overwrites a local groom/trace/decisions.md newer than the page without a conflict, and reads no tick from it', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const first = await startGroomer(client)
    const local = await readFile(decisionsPath(first.folder), 'utf8')
    await writeFile(decisionsPath(first.folder), local.replace('- [ ] Only its owner', '- [x] Only its owner'))
    await setMtime(decisionsPath(first.folder), '2030-01-01T00:00:00.000Z')
    const onPage = groomPageOf(client).markdown
    const second = await startGroomer(client)
    expect(await readFile(decisionsPath(second.folder), 'utf8')).toBe(onPage)
    expect(((await readGroomJson(second.folder)).decisions ?? []).filter((decision) => decision.decidedBy === 'author')).toEqual([])
  })

  it('the spec reviewer never pulls Grooming Decisions', async () => {
    const client = fakeBoard('In Review: Spec', { Spec: SPEC, 'Spec Reviewed': SPEC_REVIEWED, [GD]: renderedPage(groomRecord([Q1])) })
    const started = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    expect(existsSync(decisionsPath(started.folder))).toBe(false)
    expect(client.calls).not.toContain('pull Grooming Decisions')
  })
})

describe('the groomer finish (separate process)', () => {
  it('a stop applies the tick made with it, unticks Stop, removes the marker, and neither moves nor writes the Idea', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1, Q2])))
    tickOnPage(client, 'Only its owner')
    tickOnPage(client, 'Stop grooming')
    const started = await startGroomer(client)
    await agentRun(started.folder, [Q1, Q2], { status: 'stopped' })
    const finished = await finishGroomer(client, started.folder, 'stopped')
    const page = groomPageOf(client).markdown
    expect((await readGroomJson(started.folder)).status).toBe('stopped')
    expect(finished.runStatus).toBe('stopped')
    expect(questionBlock(page, 'Q1')).toContain('Decided by the author: Only its owner.')
    expect(page).toContain('- [ ] Stop grooming')
    expect(page).not.toMatch(/^Run: /m)
    expect(client.status).toBe('Grooming')
    expect(client.ideaSummary).toBeUndefined()
  })

  it('a confirm with nothing open moves the card to Shortlist, ticks CONFIRM with the date and writes the summary into the card', async () => {
    const decisions = [confirmed(Q1)]
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord(decisions)), false))
    tickOnPage(client, 'Confirm')
    const started = await startGroomer(client)
    await agentRun(started.folder, decisions, { status: 'confirmed', summary: true })
    const finished = await cli('groomer', ['finish', '--ok', '--run-status', 'confirmed', '--folder', started.folder, '--export', join(started.folder, 'groom')], client)
    const page = groomPageOf(client).markdown
    expect(client.status).toBe('Shortlist')
    expect(page).toContain('- [x] Confirm')
    expect(page).toContain(`Confirmed ${today()}`)
    expect(client.ideaSummary).toBe(ideaSummaryOf(decisions))
    expect((await readGroomJson(started.folder)).status).toBe('confirmed')
    expect(finished.out[0]).toBe('run-status=confirmed')
    expect(finished.code).toBe(0)
  })

  async function confirmRun(cardStatusAtFinish: string) {
    const decisions = [confirmed(Q1)]
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord(decisions)), false))
    tickOnPage(client, 'Confirm')
    const started = await startGroomer(client)
    await agentRun(started.folder, decisions, { status: 'confirmed', summary: true })
    client.status = cardStatusAtFinish
    client.calls = []
    return { client, folder: started.folder, summary: ideaSummaryOf(decisions) }
  }

  it('a card a human already moved to Shortlist is not moved again, and the run still ends confirmed', async () => {
    const { client, folder } = await confirmRun('Shortlist')
    const finished = await finishGroomer(client, folder, 'confirmed')
    expect(client.calls.filter((call) => call.startsWith('move'))).toEqual([])
    expect((await readGroomJson(folder)).status).toBe('confirmed')
    expect(said(finished.trace, 'already in Shortlist; no move')).toBe(true)
  })

  it('a card in Dropped at the finish re-read ends incomplete, and the summary already written stays', async () => {
    const { client, folder, summary } = await confirmRun('Dropped')
    const finished = await finishGroomer(client, folder, 'confirmed')
    expect((await readGroomJson(folder)).status).toBe('incomplete')
    expect(finished.runStatus).toBe('incomplete')
    expect(said(finished, 'NOM-4 is in "Dropped", not "Grooming"; the Idea summary was written and stays')).toBe(true)
    expect(client.ideaSummary).toBe(summary)
    expect(client.status).toBe('Dropped')
  })

  it('a move refused by the board is not swallowed: the run ends incomplete and the CLI exits 1', async () => {
    const { client, folder } = await confirmRun('Grooming')
    client.moveTicket = async () => {
      client.status = 'Dropped'
      throw new BoardError('NOM-4 is in "Dropped", not "Grooming"; not moving it to "Shortlist"')
    }
    const finished = await cli('groomer', ['finish', '--ok', '--run-status', 'confirmed', '--folder', folder, '--export', join(folder, 'groom')], client)
    expect((await readGroomJson(folder)).status).toBe('incomplete')
    expect(finished.out[0]).toBe('run-status=incomplete')
    expect(finished.code).toBe(1)
    const trace = (await readBoardTrace(join(folder, 'groom')))!.trace
    expect(said(trace, 'NOM-4 is in "Dropped", not "Grooming"; the Idea summary was written and stays')).toBe(true)
  })

  it('a refused page replace on a confirm run leaves the card in Grooming and the body unchanged, and names the local decisions file', async () => {
    const { client, folder } = await confirmRun('Grooming')
    client.replacePage = async () => {
      throw new BoardError('Notion 502 (bad_gateway): replace refused', 502, 'bad_gateway')
    }
    const finished = await cli('groomer', ['finish', '--ok', '--run-status', 'confirmed', '--folder', folder, '--export', join(folder, 'groom')], client)
    expect(client.status).toBe('Grooming')
    expect(client.ideaSummary).toBeUndefined()
    expect((await readGroomJson(folder)).status).toBe('incomplete')
    expect(finished.out[0]).toBe('run-status=incomplete')
    expect(finished.all).toContain('Notion 502 (bad_gateway): replace refused')
    expect(finished.all).toContain(decisionsPath(folder))
    expect(finished.code).toBe(1)
  })

  it('a refused Idea write on a confirm run leaves the card in Grooming and ends incomplete', async () => {
    const { client, folder } = await confirmRun('Grooming')
    client.writeIdeaSummary = async () => {
      throw new BoardError('Notion 409 (conflict_error): idea refused', 409, 'conflict_error')
    }
    const finished = await cli('groomer', ['finish', '--ok', '--run-status', 'confirmed', '--folder', folder, '--export', join(folder, 'groom')], client)
    expect(client.status).toBe('Grooming')
    expect((await readGroomJson(folder)).status).toBe('incomplete')
    expect(finished.out[0]).toBe('run-status=incomplete')
    expect(finished.all).toContain('Notion 409 (conflict_error): idea refused')
    expect(finished.all).toContain(decisionsPath(folder))
    expect(finished.code).toBe(1)
  })

  it('a Confirm ticked while a question is open is cleared and reported, and the run ends needs-author with no move', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord([confirmed(Q1)])), false))
    tickOnPage(client, 'Confirm')
    const started = await startGroomer(client)
    await agentRun(started.folder, [confirmed(Q1), Q11], { status: 'needs-author' })
    const finished = await finishGroomer(client, started.folder, 'needs-author')
    expect((await readGroomJson(started.folder)).status).toBe('needs-author')
    expect(groomPageOf(client).markdown).not.toContain('- [x] Confirm')
    expect(said(finished, 'Confirm was ticked but 1 question(s) are open; it is re-offered when they are answered')).toBe(true)
    expect(client.status).toBe('Grooming')
  })

  it('confirmed reported over a page with no Confirm tick is recorded needs-author, with the reported word and a check entry', async () => {
    const decisions = [confirmed(Q1)]
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord(decisions)), false))
    const started = await startGroomer(client)
    await agentRun(started.folder, decisions, { status: 'confirmed', summary: true })
    const finished = await finishGroomer(client, started.folder, 'confirmed')
    const record = await readGroomJson(started.folder)
    expect(record).toMatchObject({ status: 'needs-author', reportedStatus: 'confirmed' })
    expect(finished.runStatus).toBe('needs-author')
    expect(finished.trace.actions.filter((action) => action.action === 'check').map((action) => action.detail)).toContainEqual(expect.stringContaining('confirmed reported, 0 open on Grooming Decisions; recorded needs-author'))
    expect(client.status).toBe('Grooming')
  })

  it('a Confirm ticked on the new rendering after the replace is left for the next run and reported', async () => {
    const decisions = [confirmed(Q1)]
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord(decisions)), false))
    const started = await startGroomer(client)
    await agentRun(started.folder, decisions, { status: 'needs-author' })
    client.afterReplace = () => tickOnPage(client, 'Confirm')
    const finished = await finishGroomer(client, started.folder, 'needs-author')
    expect((await readGroomJson(started.folder)).status).toBe('needs-author')
    expect(client.status).toBe('Grooming')
    expect(said(finished, 'Confirm was ticked after this run wrote the page; rerun to complete grooming')).toBe(true)
  })

  it('a Confirm unticked by hand after completion is an open Confirm: needs-author with 0 open, no Idea write, no move', async () => {
    const decisions = [confirmed(Q1)]
    const client = fakeBoard('Shortlist', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord(decisions)), false, 'Confirmed 2026-10-10'))
    const started = await startGroomer(client)
    await agentRun(started.folder, decisions, { status: 'needs-author' })
    const finished = await finishGroomer(client, started.folder, 'needs-author')
    const url = groomPageOf(client).page.url
    expect(await readGroomJson(started.folder)).toMatchObject({ status: 'needs-author', open: 0 })
    expect(groomPageOf(client).markdown).toContain(`Confirm was unticked on ${today()}; tick it again to re-confirm`)
    expect(finished.remaining).toBe(`Tick Confirm on Grooming Decisions (${url}) to complete grooming.`)
    expect(client.ideaSummary).toBeUndefined()
    expect(client.calls.filter((call) => call.startsWith('move'))).toEqual([])
  })

  it('a confirm run over a card in Dropped returns incomplete, not confirmed', async () => {
    const { client, folder } = await confirmRun('Dropped')
    const finished = await finishGroomer(client, folder, 'confirmed')
    expect(finished.runStatus).toBe('incomplete')
  })

  it('a --failed finish deletes only this run\'s marker, keeps the Round 2 rendering and the Status, and the next start is not refused', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([confirmed(Q1), Q2], { round: 2 })))
    const started = await startGroomer(client)
    const marker = (await readGroomJson(started.folder)).markerBlockId
    const before = pageBlocks(client)
    await cli('groomer', ['finish', '--failed', '--run-status', 'incomplete', '--folder', started.folder, '--export', join(started.folder, 'groom')], client)
    expect(pageBlocks(client)).toEqual(before.filter((block) => block.id !== marker))
    expect(client.status).toBe('Grooming')
    await expect(startGroomer(client)).resolves.toMatchObject({ folder: started.folder })
  })

  it('attributes a tick event to the Notion user who made it, refuses the integration\'s own tick and leaves an unattributable one open', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1, Q2, Q3])))
    tickOnPage(client, 'Only its owner', 'human-7')
    tickOnPage(client, 'Keep forever', 'bot-1')
    tickOnPage(client, 'Under Recipes', null)
    const started = await startGroomer(client)
    await agentRun(started.folder, [Q1, Q2, Q3], { status: 'needs-author' })
    const finished = await finishGroomer(client, started.folder, 'needs-author')
    const byId = Object.fromEntries((await readGroomJson(started.folder)).decisions.map((decision) => [decision.id, decision]))
    const page = groomPageOf(client).markdown
    expect(byId.Q1).toMatchObject({ decidedBy: 'author', answer: 'Only its owner', tickedBy: { kind: 'notion', id: 'human-7' } })
    expect(said(finished.trace, 'Q1 ticked by human-7')).toBe(true)
    expect(byId.Q2?.decidedBy).toBe('open')
    expect(questionBlock(page, 'Q2')).not.toContain('- [x]')
    expect(said(finished.trace, 'ticked by the integration')).toBe(true)
    expect(byId.Q3?.decidedBy).toBe('open')
    expect(said(finished.trace, 'tick on Q3 not attributable; left open')).toBe(true)
  })

  it('a Confirm the groomer itself rendered ticked is never attributed: the run over it ends confirmed', async () => {
    const decisions = [confirmed(Q1)]
    const client = fakeBoard('Shortlist', {})
    seedGroomPage(client, withConfirm(renderedPage(groomRecord(decisions, { status: 'confirmed' })), true, 'Confirmed 2026-10-10'))
    const started = await startGroomer(client)
    await agentRun(started.folder, decisions, { status: 'confirmed', summary: true })
    const finished = await finishGroomer(client, started.folder, 'confirmed')
    expect(finished.runStatus).toBe('confirmed')
    expect((await readGroomJson(started.folder)).status).toBe('confirmed')
    expect(client.status).toBe('Shortlist')
  })

  it('another run\'s marker found at the final re-read ends the run incomplete and deletes nothing but its own marker', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const started = await startGroomer(client)
    await agentRun(started.folder, [Q1], { status: 'needs-author' })
    addPageBlock(client, 'Run: 2026-10-11T08:00:00Z agent in progress')
    const marker = (await readGroomJson(started.folder)).markerBlockId
    const before = pageBlocks(client)
    const finished = await finishGroomer(client, started.folder, 'needs-author')
    expect((await readGroomJson(started.folder)).status).toBe('incomplete')
    expect(said(finished, 'another run wrote Grooming Decisions during this run')).toBe(true)
    expect(pageBlocks(client)).toEqual(before.filter((block) => block.id !== marker))
  })

  it('a local record at round 3 over a page complete at round 2 is rebuilt from the page, with the page\'s new tick confirmed', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([confirmed(Q1), Q2], { round: 2 })))
    tickOnPage(client, 'Expire after 30 days')
    const started = await startGroomer(client)
    await agentRun(started.folder, [confirmed(Q1), Q2, Q3], { status: 'needs-author', round: 3 })
    const finished = await finishGroomer(client, started.folder, 'needs-author')
    const record = await readGroomJson(started.folder)
    expect(record.round).toBe(2)
    expect(record.decisions.find((decision) => decision.id === 'Q2')).toMatchObject({ decidedBy: 'author', answer: 'Expire after 30 days' })
    expect(said(finished.trace, 'local round 3 discarded, page is at round 2')).toBe(true)
  })

  it('a run working at the page\'s round writes the next round to the page and to groom.json', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([confirmed(Q1)], { round: 2 })))
    const started = await startGroomer(client)
    await agentRun(started.folder, [confirmed(Q1), Q2], { status: 'needs-author', round: 2 })
    await finishGroomer(client, started.folder, 'needs-author')
    expect([(await readGroomJson(started.folder)).round, /^Round 3 · /m.test(groomPageOf(client).markdown)]).toEqual([3, true])
  })
})

describe('the ticket CLI for the groomer', () => {
  it('accepts --force-run on start for the groomer, and the spec writer accepts and ignores it', async () => {
    const groomer = await cli('groomer', ['start', 'NOM-4', '--force-run'], fakeBoard('Idea', {}))
    expect(groomer.err.join('\n')).not.toMatch(/not a skill|Unknown option/)
    expect(groomer.code).toBe(0)
    await rm(join(repo, '.work'), { recursive: true, force: true })
    const plain = await cli('spec-writer', ['start', 'NOM-4'], fakeBoard('Ready: Idea'))
    await rm(join(repo, '.work'), { recursive: true, force: true })
    const flagged = await cli('spec-writer', ['start', 'NOM-4', '--force-run'], fakeBoard('Ready: Idea'))
    expect(flagged.code).toBe(plain.code)
    expect(flagged.out).toEqual(plain.out)
    expect(flagged.err).toEqual(plain.err)
  })

  it('finish prints run-status first, the unchanged header, then the page and the open count, and the remaining step', async () => {
    const client = fakeBoard('Idea', {})
    const started = await startGroomer(client)
    const marker = (await readGroomJson(started.folder)).markerBlockId
    await agentRun(started.folder, [Q1, Q2], { status: 'needs-author' })
    const finished = await cli('groomer', ['finish', '--ok', '--run-status', 'needs-author', '--folder', started.folder, '--export', join(started.folder, 'groom')], client)
    const url = groomPageOf(client).page.url
    expect(finished.out.slice(0, 7)).toEqual([
      'run-status=needs-author',
      `Ticket: NOM-4 Explore pagination (${URL})`,
      'Status: Grooming -> Grooming (no move)',
      `Pages pushed: Grooming Decisions (${url})`,
      `Working folder: ${started.folder}`,
      `Grooming Decisions: ${url}`,
      'Open questions: 2',
    ])
    expect(finished.out).toContain(`Answer the 2 open question(s) on Grooming Decisions (${url}), then run groomer again; it reads the ticks.`)
    expect(finished.code).toBe(0)
    expect(groomPageOf(client).blocks.map((block) => block.id)).not.toContain(marker)
    expect(groomPageOf(client).markdown).toBe(await readFile(decisionsPath(started.folder), 'utf8'))
    expect(await readGroomJson(started.folder)).toMatchObject({ status: 'needs-author', open: 2, page: { url } })
  })

  it('the spec reviewer\'s finish output and exit code are today\'s', async () => {
    const client = fakeBoard('In Review: Spec')
    const started = await startFlow({ skill: 'spec-reviewer', repo, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client })
    await mkdir(join(started.folder, 'spec.reviewed/trace'), { recursive: true })
    await writeFile(join(started.folder, 'spec.reviewed/spec.reviewed.md'), 'reviewed v2')
    await writeFile(join(started.folder, 'spec.reviewed/trace/decisions.md'), '# Decisions\n')
    const finished = await cli('spec-reviewer', ['finish', '--ok', '--run-status', 'needs-author', '--folder', started.folder], client)
    expect(finished.out).toEqual([
      `Ticket: NOM-4 Explore pagination (${URL})`,
      'Status: In Review: Spec -> In Review: Spec (no move)',
      `Pages pushed: Spec Reviewed (${client.pages['Spec Reviewed']?.page.url}), Spec Review Decisions (${client.pages['Spec Review Decisions']?.page.url})`,
      `Working folder: ${started.folder}`,
      `Board trace: ${join(started.folder, 'board.json')}`,
    ])
    expect(finished.code).toBe(0)
  })

  it('without aspira.json the groomer is refused naming kit init and never offering --no-ticket, in the CLI and the driver alike', async () => {
    await rm(join(repo, 'aspira.json'))
    const groomer = await cli('groomer', ['start', 'KIT-8'])
    expect(groomer.code).toBe(3)
    const message = groomer.err.at(-1) ?? ''
    expect(message).toContain('kit init --board <Feature Board URL>')
    expect(message).not.toContain('--no-ticket')
    const driver = await beforeRun({ skill: 'groomer', repo, env: {} }, { positional: 'KIT-8' }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(driver).toBe(message)
    const writer = await cli('spec-writer', ['start', 'KIT-8'])
    expect(writer.code).toBe(3)
    expect(writer.err.at(-1)).toContain('pass --no-ticket')
  })
})

describe('the groomer --local board stage (against a stub session)', () => {
  const ctxOf = (skill: Skill): DriverContext => ({ skill, repo, env: {} })
  const field = (action: BoardAction, key: string): string | undefined => {
    const value: unknown = Reflect.get(action, key)
    return typeof value === 'string' ? value : undefined
  }

  /** The stub session: performs each listed action on the fake board with what a Notion MCP session would do, and keeps ticket.md in step. */
  async function perform(client: Fake, actions: BoardAction[]): Promise<void> {
    const ticketFile = join(folderOf(), TICKET_FILE)
    const editTicket = async (change: (ticket: NonNullable<Awaited<ReturnType<typeof readTicketMd>>>) => void) => {
      const ticket = (await readTicketMd(folderOf()))!
      change(ticket)
      await writeFile(ticketFile, renderTicketMd(ticket))
    }
    for (const action of actions) {
      const kind: string = action.action
      if (kind === 'resolve') {
        const ticket = await client.resolveTicket(field(action, 'ticket') ?? 'NOM-4')
        await mkdir(folderOf(), { recursive: true })
        await writeFile(ticketFile, renderTicketMd({ ...ticket, pulledAt: new Date().toISOString() }))
      } else if (kind === 'pull') {
        const page = await client.pullPage(PAGE, field(action, 'title')!)
        const file = field(action, 'file')!
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, page!.markdown)
      } else if (kind === 'mark') {
        const text = field(action, 'text') ?? /Run: \S+ local in progress/.exec(field(action, 'note') ?? '')?.[0]
        if (text !== undefined) await client.appendParagraph(groomPageOf(client).page.id, text)
      } else if (kind === 'unmark') {
        const marker = groomPageOf(client).blocks.find((block) => /^Run: \S+ local in progress$/.test(block.text))
        if (marker !== undefined) await client.deleteBlock(marker.id)
      } else if (kind === 'replace') {
        const result = await client.replacePage(PAGE, field(action, 'title') ?? GD, await readFile(field(action, 'file') ?? decisionsPath(folderOf()), 'utf8'))
        await editTicket((ticket) => {
          ticket.pages[GD] = { id: result.id, title: GD, url: result.url, lastEditedAt: result.lastEditedAt }
        })
      } else if (kind === 'write-idea') {
        await client.writeIdeaSummary(PAGE, await readFile(field(action, 'file') ?? summaryPath(folderOf()), 'utf8'))
      } else if (kind === 'set') {
        await client.setProperty(PAGE, field(action, 'name')!, field(action, 'value')!)
        await editTicket((ticket) => {
          ticket.dev = field(action, 'value')
        })
      } else if (kind === 'move') {
        const to = field(action, 'to')!
        await client.moveTicket(PAGE, field(action, 'from')!, to)
        await editTicket((ticket) => {
          ticket.status = to
        })
      } else if (kind === 'push') {
        const title = field(action, 'title')!
        const result = await client.pushPage(PAGE, title, await readFile(field(action, 'file')!, 'utf8'))
        await editTicket((ticket) => {
          ticket.pages[title] = { id: result.id, title, url: result.url, lastEditedAt: new Date().toISOString() }
        })
      }
    }
  }

  /** The board stages up to the ticket: resolve, then sync, each performed by the stub session. */
  async function localReady(client: Fake, skill: Skill = 'groomer') {
    for (let step = 0; step < 4; step += 1) {
      const next = await beforeRun(ctxOf(skill), { positional: 'NOM-4' })
      if (next.kind === 'ticket') return next
      if (next.kind !== 'stage') throw new Error(`expected a board stage, got ${next.kind}`)
      await perform(client, next.stage.actions)
    }
    throw new Error('the board stage never reached the ticket')
  }

  /** What the groomer's --local round leaves behind: the record, its rendering, the session's copy of the page and, on a confirm, the summary. */
  async function localRound(client: Fake, record: GroomRecord, round: number): Promise<void> {
    const folder = folderOf()
    const withPage = { ...record, round, page: { id: groomPageOf(client).page.id, url: groomPageOf(client).page.url } }
    const rendering = renderGroomPage(withPage, { date: today(), notes: [] })
    await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
    await mkdir(join(folder, 'groom.local'), { recursive: true })
    await writeFile(groomJsonPath(folder), `${JSON.stringify(withPage, null, 2)}\n`)
    await writeFile(decisionsPath(folder), rendering)
    await writeFile(join(folder, 'groom.local', `page-${round}.md`), rendering)
    if (record.status === 'confirmed') await writeFile(summaryPath(folder), ideaSummaryOf(record.decisions))
  }

  const verifyCommand = 'groomer.sh local NOM-4 --verify'
  const exportOf = () => join(folderOf(), 'groom')

  it('from Shortlist lists no Dev set and no move, expects Shortlist, and records the Dev it found', async () => {
    const client = fakeBoard('Shortlist', {})
    client.props.Dev = 'Ana'
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const first = await beforeRun(ctxOf('groomer'), { positional: 'NOM-4' })
    if (first.kind !== 'stage') throw new Error(`expected the resolve stage, got ${first.kind}`)
    await perform(client, first.stage.actions)
    const sync = await beforeRun(ctxOf('groomer'), { positional: 'NOM-4' })
    if (sync.kind !== 'stage') throw new Error(`expected the sync stage, got ${sync.kind}`)
    expect(sync.stage.actions.map((action) => action.action)).not.toContain('set')
    expect(sync.stage.actions.map((action) => action.action)).not.toContain('move')
    expect(sync.stage.verify.status).toBe('Shortlist')
    await perform(client, sync.stage.actions)
    const ready = await localReady(client)
    expect(ready.trace.actions.filter((action) => action.action === 'set' || /^Dev = .* by the session$/.test(action.detail))).toEqual([])
    const state: { devBefore?: string } = JSON.parse(await readFile(join(boardStateDir(folderOf(), 'groomer'), 'board.json'), 'utf8'))
    expect(state.devBefore).toBe('Ana')
  })

  it('the verify refuses when the session changed Dev', async () => {
    const client = fakeBoard('Shortlist', {})
    client.props.Dev = 'Ana'
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const ready = await localReady(client)
    await localRound(client, groomRecord([Q1]), 1)
    const end = await afterRun(ctxOf('groomer'), ready, { ok: true, status: 'needs-author', exportDir: exportOf(), verifyCommand, round: 1 })
    await perform(client, end.board.actions)
    const ticket = (await readTicketMd(folderOf()))!
    await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd({ ...ticket, dev: 'Claude' }))
    const verified = await verifyRun(ctxOf('groomer'), { positional: 'NOM-4' }, exportOf)
    expect(verified.verified).toBe(false)
    expect(verified.problem).toContain('Dev changed from "Ana" to "Claude"; the groomer never sets Dev')
  })

  it('the verify checks the Grooming Decisions row against the push time at minute precision, or a new URL', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const ready = await localReady(client)
    await localRound(client, groomRecord([Q1]), 1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-11T10:05:30Z'))
    try {
      await afterRun(ctxOf('groomer'), ready, { ok: true, status: 'needs-author', exportDir: exportOf(), verifyCommand, round: 1 })
    } finally {
      vi.useRealTimers()
    }
    const url = groomPageOf(client).page.url
    const verifyWithRow = async (rowUrl: string, editedAt: string) => {
      const ticket = (await readTicketMd(folderOf()))!
      ticket.pages[GD] = { id: 'page-gd', title: GD, url: rowUrl, lastEditedAt: editedAt }
      await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd(ticket))
      return localBoardVerify({ skill: 'groomer', folder: folderOf(), exportDir: exportOf() })
    }
    expect((await verifyWithRow(url, '2026-10-11T10:04:59.000Z')).ok).toBe(false)
    expect((await verifyWithRow(url, '<its last edited time, ISO>')).ok).toBe(false)
    expect((await verifyWithRow(url, '2026-10-11T10:05:10.000Z')).ok).toBe(true)
    expect((await verifyWithRow('https://www.notion.so/page-gd-new', '2026-10-11T10:04:59.000Z')).ok).toBe(true)
  })

  it('a needs-author round keeps the round state; the confirm round ends it, and both rounds\' pushes are in the trace', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const ready = await localReady(client)
    const stateDir = boardStateDir(folderOf(), 'groomer')
    const url = groomPageOf(client).page.url
    await localRound(client, groomRecord([Q1]), 1)
    const first = await afterRun(ctxOf('groomer'), ready, { ok: true, status: 'needs-author', exportDir: exportOf(), verifyCommand, round: 1 })
    await perform(client, first.board.actions)
    expect((await verifyRun(ctxOf('groomer'), { positional: 'NOM-4' }, exportOf)).verified).toBe(true)
    expect(existsSync(stateDir)).toBe(true)
    expect((await readGroomJson(folderOf())).page.url).toBe(url)
    await localRound(client, groomRecord([confirmed(Q1)], { status: 'confirmed' }), 2)
    const second = await afterRun(ctxOf('groomer'), ready, { ok: true, status: 'confirmed', exportDir: exportOf(), verifyCommand, round: 2 })
    await perform(client, second.board.actions)
    const verified = await verifyRun(ctxOf('groomer'), { positional: 'NOM-4' }, exportOf)
    expect(verified.verified).toBe(true)
    expect((await readBoardTrace(exportOf()))!.trace.pushed.filter((pushed) => pushed.title === GD)).toHaveLength(2)
    expect(existsSync(stateDir)).toBe(false)
  })

  it('the spec writer\'s verify still checks only that the pushed row exists', async () => {
    const client = fakeBoard('Ready: Idea')
    const ready = await localReady(client, 'spec-writer')
    await writeFile(join(folderOf(), 'spec.md'), '## Intent\n\nWritten.\n')
    const end = await afterRun(ctxOf('spec-writer'), ready, { ok: true, status: 'ready', exportDir: folderOf(), verifyCommand: 'spec-writer.sh local NOM-4 --verify' })
    await perform(client, end.board.actions)
    const ticket = (await readTicketMd(folderOf()))!
    ticket.pages.Spec = { ...ticket.pages.Spec!, lastEditedAt: '2020-01-01T00:00:00.000Z' }
    await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd(ticket))
    expect((await verifyRun(ctxOf('spec-writer'), { positional: 'NOM-4' }, () => folderOf())).verified).toBe(true)
  })

  it('the end stage refuses when the round did not render Grooming Decisions; the spec reviewer still skips a missing push file', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const ready = await localReady(client)
    await localRound(client, groomRecord([Q1]), 1)
    await rm(decisionsPath(folderOf()))
    await expect(afterRun(ctxOf('groomer'), ready, { ok: true, status: 'needs-author', exportDir: exportOf(), verifyCommand, round: 1 })).rejects.toThrow('groom/trace/decisions.md is missing; the round did not render Grooming Decisions')

    await rm(join(repo, '.work'), { recursive: true, force: true })
    const reviewer = fakeBoard('In Review: Spec')
    const reviewReady = await localReady(reviewer, 'spec-reviewer')
    const end = await afterRun(ctxOf('spec-reviewer'), reviewReady, { ok: true, status: 'needs-author', exportDir: join(folderOf(), 'spec.reviewed'), verifyCommand: 'spec-reviewer.sh local NOM-4 --verify' })
    expect(end.board.actions.map((action) => [action.action, field(action, 'title')])).toEqual([['push', 'Spec Reviewed']])
  })

  it('a confirmed round lists unmark, replace, resolve, write-idea and the Shortlist move, in that order', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const ready = await localReady(client)
    await localRound(client, groomRecord([confirmed(Q1)], { status: 'confirmed' }), 1)
    const end = await afterRun(ctxOf('groomer'), ready, { ok: true, status: 'confirmed', exportDir: exportOf(), verifyCommand, round: 1 })
    expect(end.board.actions.map((action) => action.action)).toEqual(['unmark', 'replace', 'resolve', 'write-idea', 'move'])
    expect(end.board.actions.at(-1)).toMatchObject({ action: 'move', from: 'Grooming', to: 'Shortlist' })
  })

  it('an incomplete round lists only the marker delete', async () => {
    const client = fakeBoard('Grooming', {})
    seedGroomPage(client, renderedPage(groomRecord([Q1])))
    const ready = await localReady(client)
    await localRound(client, groomRecord([Q1], { status: 'incomplete' }), 1)
    const end = await afterRun(ctxOf('groomer'), ready, { ok: false, status: 'incomplete', exportDir: exportOf(), verifyCommand, round: 1 })
    expect(end.board.actions.map((action) => action.action)).toEqual(['unmark'])
  })
})

describe('inputFileFor the groomer', () => {
  it('takes an empty idea.md from a title-only card', async () => {
    const folder = join(repo, '.work', 'nom-4-explore-pagination')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'idea.md'), '')
    expect(inputFileFor('groomer', folder)).toBe(join(folder, 'idea.md'))
  })
})
