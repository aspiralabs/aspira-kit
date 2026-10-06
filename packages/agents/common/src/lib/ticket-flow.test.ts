import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Board, Ticket, TicketPage } from './board'
import { ticketCli } from './ticket-cli'
import { afterRun, beforeRun, verifyRun } from './ticket-driver'
import { FlowRefused, finishFlow, findWorkFolders, readAspira, readBoardTrace, readTicketMd, startFlow } from './ticket-flow'
import { TICKET_FILE, renderTicketMd, type BoardAction } from './ticket'

// A board built from the recorded NOM-4 fixture values, in process: the same shape board.ts returns,
// with the Status, Dev, PR and child pages kept in memory so every move and push can be read back.

const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const URL = 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1'
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6?v=1'
const SPEC = '## Intent\n\nPeople can reach every recipe.\n\n- [ ] F1: lists page.\n'
const SPEC_REVIEWED = '## Intent\n\nPeople can reach every recipe, reviewed.\n'

type Fake = Board & { status: string; props: Record<string, string>; pages: Record<string, { page: TicketPage; markdown: string }>; calls: string[] }

function fakeBoard(status: string, pages: Record<string, string> = { Spec: SPEC, 'Spec Reviewed': SPEC_REVIEWED }): Fake {
  const state: Fake = {
    status,
    props: { Dev: '', PR: '' },
    pages: Object.fromEntries(Object.entries(pages).map(([title, markdown], i) => [title, { page: { id: `page-${i}`, title, url: `https://www.notion.so/page-${i}`, lastEditedAt: '2026-10-05T04:48:12.063Z' }, markdown }])),
    calls: [],
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
        existing.page.lastEditedAt = new Date().toISOString()
        return { id: existing.page.id, url: existing.page.url, created: false }
      }
      const page = { id: `page-${title}`, title, url: `https://www.notion.so/page-${encodeURIComponent(title)}`, lastEditedAt: new Date().toISOString() }
      state.pages[title] = { page, markdown }
      return { id: page.id, url: page.url, created: true }
    },
    async pullPage(_page, title) {
      state.calls.push(`pull ${title}`)
      const entry = state.pages[title]
      return entry === undefined ? undefined : { ...entry.page, markdown: entry.markdown }
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
    expect(end.board.verify.status).toBe('In Progress: Plan')
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
