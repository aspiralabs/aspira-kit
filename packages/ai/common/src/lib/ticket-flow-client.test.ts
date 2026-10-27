// The ticket flow on a client root (KIT-68, F5 and F11). The aspira.json sits at the client root, above the
// repo, with `statusFlow: false` and `workRoot: '.work'`, mapping the repo `web` by the card's Area tag. A flow run
// then resolves the card and pushes every stage page, moves no Status, sets no Dev, and keeps the ticket's
// working folder at <client root>/.work/<ticket folder>, never in the repo.
//
// Notion is a local HTTP server that answers from the recorded NOM-4 fixtures (as board.test.ts does) and records
// every request, so "no Status update" is read off the requests. The separate-process path (startFlow, finishFlow)
// talks to it through board(); the --local path (localBoardStep, localBoardEnd) prints actions for the session, so
// those are read off the printed actions, with the end stage pushing through the same board client.
//
// Run under `env -u NOTION_TOKEN`: the token here is a literal that only the mock accepts.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { board, type Board } from './board.ts'
import { blocksToMarkdown, type Block } from './notion-markdown.ts'
import { renderTicketMd, workFolderName, type Skill, type TicketRecord } from './ticket.ts'
import { finishFlow, localBoardEnd, localBoardStep, localStateDir, startFlow } from './ticket-flow.ts'

type Json = Record<string, unknown>
type Call = { method: string; path: string; body?: Json }

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/board/${name}`, import.meta.url), 'utf8')) as T
const DS = 'b4e393d4-a4a6-46b8-bbd1-3d6c0f45a01e'
const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const SPEC = '3ec3e59b-2258-8118-9d69-d3151595999b'
const SPEC_REVIEWED = '3ec3e59b-2258-8123-961c-ce4ccd8e662a'
const PLAN = '3ec3e59b-2258-81ca-b6df-c2971beacd06'
const TOKEN = 'client-test-token'
const BOARD = `https://www.notion.so/${DS.replaceAll('-', '')}?v=1`
const FOLDER_NAME = workFolderName({ id: 'NOM-4', title: 'Explore pagination' })

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])

/** A Notion that answers the calls a flow makes from the NOM-4 fixtures and keeps what it is sent. */
async function mockNotion() {
  const calls: Call[] = []
  const stored = new Map<string, Json[]>()
  const pageObjects = new Map<string, Json>()
  let status = 'Idea'
  let next = 1
  for (const block of fixture<{ results: Json[] }>('nom-4.children.json').results) {
    if (block.type === 'child_page') pageObjects.set(String(block.id), { object: 'page', id: block.id, url: `https://www.notion.so/${String(block.id).replaceAll('-', '')}`, last_edited_time: block.last_edited_time })
  }
  const ticketPage = (): Json => {
    const base = fixture<Json>('nom-4.page.json')
    return { ...base, properties: { ...(base.properties as Json), Status: { id: 'bEBnag', type: 'select', select: { name: status } } } }
  }
  const store = (parent: string, blocks: Json[], after?: string): Json[] => {
    const list = stored.get(parent) ?? []
    stored.set(parent, list)
    let at = after === undefined ? list.length : list.findIndex((block) => block.id === after) + 1
    return blocks.map((block) => {
      const id = `blk-${next++}`
      const { children: _ignored, ...rest } = block
      const type = String(rest.type)
      const typed = isRecord(rest[type]) ? rest[type] : {}
      const { children, ...content } = typed
      const saved = { object: 'block', id, has_children: records(children).length > 0, ...rest, ...(isRecord(rest[type]) ? { [type]: content } : {}) }
      list.splice(at, 0, saved)
      at += 1
      if (records(children).length > 0) store(id, records(children))
      return saved
    })
  }
  const listed = (all: Json[]) => ({ status: 200, body: { object: 'list', results: all, has_more: false, next_cursor: null } as Json })
  const route = (call: Call): { status: number; body: Json } => {
    const { method, path, body } = call
    const json = (value: Json, code = 200) => ({ status: code, body: value })
    if (method === 'GET' && path === '/v1/users/me') return json({ object: 'user', id: 'bot-1', type: 'bot', bot: {} })
    if (method === 'GET' && path === `/v1/data_sources/${DS}`) return json(fixture('feature-board.data-source.json'))
    if (method === 'POST' && path === `/v1/data_sources/${DS}/query`) {
      const equals = ((body?.filter as Json | undefined)?.unique_id as Json | undefined)?.equals
      return json(equals === 4 ? { ...fixture<Json>('query.nom-4.json'), results: [ticketPage()] } : { object: 'list', results: [], has_more: false, next_cursor: null })
    }
    if (method === 'GET' && path === `/v1/pages/${PAGE}`) return json(ticketPage())
    if (method === 'PATCH' && path === `/v1/pages/${PAGE}`) {
      const select = ((body?.properties as Json | undefined)?.Status as Json | undefined)?.select as Json | undefined
      if (select) status = String(select.name)
      return json(ticketPage())
    }
    const markdown = path.match(/^\/v1\/pages\/([^/]+)\/markdown$/)
    if (method === 'GET' && markdown !== null) {
      const id = markdown[1]!
      if (id === PAGE) return json(fixture('nom-4.markdown.json'))
      if (stored.has(id)) return json({ object: 'page_markdown', id, markdown: blocksToMarkdown((stored.get(id) ?? []) as Block[]), truncated: false, unknown_block_ids: [] })
      if (id === SPEC_REVIEWED) return json(fixture('spec-reviewed.markdown.json'))
      return json({ object: 'page_markdown', id, markdown: '', truncated: false, unknown_block_ids: [] })
    }
    const pageMatch = path.match(/^\/v1\/pages\/([^/]+)$/)
    if (method === 'GET' && pageMatch !== null && pageObjects.has(pageMatch[1]!)) return json(pageObjects.get(pageMatch[1]!)!)
    const children = path.match(/^\/v1\/blocks\/([^/]+)\/children(?:\?.*)?$/)
    if (method === 'GET' && children !== null) {
      const id = children[1]!
      const own = stored.get(id) ?? []
      return listed(id === PAGE ? [...fixture<{ results: Json[] }>('nom-4.children.json').results, ...own] : id === SPEC_REVIEWED && !stored.has(id) ? fixture<{ results: Json[] }>('spec-reviewed.children.json').results : own)
    }
    if (method === 'PATCH' && children !== null) {
      const position = body?.position
      const after = isRecord(position) && isRecord(position.after_block) && typeof position.after_block.id === 'string' ? position.after_block.id : undefined
      const results = store(children[1]!, records(body?.children), after)
      const object = pageObjects.get(children[1]!)
      if (object !== undefined) pageObjects.set(children[1]!, { ...object, last_edited_time: new Date(Date.UTC(2026, 9, 26, 12, next)).toISOString() })
      return json({ object: 'list', results })
    }
    const single = path.match(/^\/v1\/blocks\/([^/]+)$/)
    if (method === 'DELETE' && single !== null) {
      for (const list of stored.values()) {
        const index = list.findIndex((block) => block.id === single[1])
        if (index !== -1) list.splice(index, 1)
      }
      return json({ object: 'block', id: single[1], in_trash: true })
    }
    if (method === 'POST' && path === '/v1/pages') {
      const id = `page-${next++}`
      const title = String((((body?.properties as Json | undefined)?.title as Json | undefined)?.title as Json[] | undefined)?.[0]?.text && ((((body?.properties as Json).title as Json).title as Json[])[0]!.text as Json).content)
      const created = { object: 'page', id, url: `https://www.notion.so/${id}`, last_edited_time: '2026-10-26T00:00:00.000Z', parent: body?.parent }
      pageObjects.set(id, created)
      store(id, records(body?.children))
      // The new page is a child page of the ticket: the next listing of the ticket's children shows it.
      store(PAGE, [{ type: 'child_page', child_page: { title }, last_edited_time: '2026-10-26T00:00:00.000Z' }]).forEach((block) => (block.id = id))
      return json(created)
    }
    return json({ object: 'error', status: 404, code: 'object_not_found', message: `no route for ${method} ${path}` }, 404)
  }
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString()
    const call: Call = { method: request.method ?? 'GET', path: request.url ?? '/', ...(raw === '' ? {} : { body: JSON.parse(raw) as Json }) }
    calls.push(call)
    const { status: code, body } = route(call)
    response.writeHead(code, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return {
    calls,
    api,
    setStatus: (value: string) => (status = value),
    status: () => status,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

type Mock = Awaited<ReturnType<typeof mockNotion>>

/** The client root: not a git repo, aspira.json with the client keys, the mapped repo web/ and the existing work root. */
async function clientRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ticket-flow-client-')))
  const web = join(root, 'web')
  await mkdir(web, { recursive: true })
  execFileSync('git', ['init', '-q', web])
  await mkdir(join(root, '.work'))
  await writeFile(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, statusFlow: false, workRoot: '.work', repos: { Discover: { path: 'web' } } }))
  return { root, web, folder: join(root, '.work', FOLDER_NAME) }
}

let mock: Mock
let client: Board
let layout: Awaited<ReturnType<typeof clientRoot>>
const cleanup: string[] = []

beforeEach(async () => {
  mock = await mockNotion()
  client = board({ token: TOKEN, board: BOARD, api: mock.api })
  layout = await clientRoot()
  cleanup.push(layout.root)
})

afterEach(async () => {
  await mock.close()
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

const writeInto = async (file: string, text: string) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** The Status each skill claims from today, so that a flow that still moved Status would show up in the requests. */
const STATUS: Partial<Record<Skill, string>> = { groomer: 'Idea', 'spec-writer': 'Ready: Idea', planner: 'Ready: Spec' }
/** The files a skill's success pushes read, by pushed page. */
const OUTPUT: Partial<Record<Skill, Record<string, string>>> = {
  'spec-writer': { 'spec.md': '## Intent\n\nA spec.\n', 'spec.reviewed/spec.reviewed.md': '## Intent\n\nA reviewed spec.\n' },
  planner: { 'plan.review/plan.reviewed.md': '## Plan\n\nA plan.\n' },
}
const issued = (skill: Skill): 'ready' | 'needs-author' => (skill === 'groomer' ? 'needs-author' : 'ready')

const statusWrites = () => mock.calls.filter((call) => call.method === 'PATCH' && call.path === `/v1/pages/${PAGE}`)
const wrote = (page: string) => mock.calls.some((call) => (call.method === 'PATCH' || call.method === 'POST') && call.path.startsWith(`/v1/blocks/${page}/children`))

describe('startFlow and finishFlow on a client root', () => {
  it('T24 makes no Status update and no Dev write for the groomer, the spec writer and the planner on one card', async () => {
    for (const skill of ['groomer', 'spec-writer', 'planner'] as const) {
      mock.setStatus(STATUS[skill]!)
      const started = await startFlow({ skill, repo: layout.web, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client, env: {} })
      for (const [file, text] of Object.entries(OUTPUT[skill] ?? {})) await writeInto(join(started.folder, file), text)
      const finished = await finishFlow({ skill, folder: started.folder, runStatus: issued(skill), board: BOARD, client, env: {} })
      expect([skill, finished.pushFailures]).toEqual([skill, []])
      expect([skill, mock.status()]).toEqual([skill, STATUS[skill]])
    }
    expect(statusWrites()).toEqual([])
  })

  it('T24 pushes each stage page: the groomer pages, Spec, Spec Reviewed and Plan', async () => {
    for (const skill of ['groomer', 'spec-writer', 'planner'] as const) {
      mock.setStatus(STATUS[skill]!)
      const started = await startFlow({ skill, repo: layout.web, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client, env: {} })
      expect(started.folder).toBe(layout.folder)
      for (const [file, text] of Object.entries(OUTPUT[skill] ?? {})) await writeInto(join(started.folder, file), text)
      await finishFlow({ skill, folder: started.folder, runStatus: issued(skill), board: BOARD, client, env: {} })
    }
    const created = mock.calls.filter((call) => call.method === 'POST' && call.path === '/v1/pages')
    expect(created.map((call) => ((call.body?.properties as Json).title as { title: { text: { content: string } }[] }).title[0]!.text.content)).toEqual(['Grooming Decisions'])
    expect([wrote(SPEC), wrote(SPEC_REVIEWED), wrote(PLAN), mock.calls.some((call) => call.method === 'PATCH' && /^\/v1\/blocks\/page-\d+\/children/.test(call.path))]).toEqual([true, true, true, true])
  })

  it('T24 keeps the ticket folder at <client root>/.work/<ticket folder> and makes no .work folder in the repo', async () => {
    mock.setStatus('Ready: Idea')
    const started = await startFlow({ skill: 'spec-writer', repo: layout.web, argument: { kind: 'ticket', ref: 'NOM-4' }, board: BOARD, client, env: {} })
    expect([started.folder, existsSync(join(layout.folder, 'ticket.md')), existsSync(join(layout.web, '.work'))]).toEqual([layout.folder, true, false])
  })
})

describe('the --local board stages on a client root', () => {
  /** The session's resolve: ticket.md written in the folder the first stage named. */
  async function resolved(skill: Skill, folder: string) {
    const ticket = await client.resolveTicket('NOM-4')
    const record: TicketRecord = { ...ticket, pulledAt: new Date().toISOString() }
    await writeInto(join(folder, 'ticket.md'), renderTicketMd(record))
    const later = new Date(Date.now() + 5_000)
    await utimes(join(folder, 'ticket.md'), later, later)
    return localStateDir(folder, skill)
  }

  for (const skill of ['groomer', 'spec-writer', 'planner'] as const) {
    it(`T24 prints no Status move and no Dev set for the ${skill}, names the folder to resolve into under the client root, and pushes its pages at the end`, async () => {
      mock.setStatus(STATUS[skill]!)
      const argument = { kind: 'ticket' as const, ref: 'NOM-4' }
      const first = await localBoardStep({ skill, repo: layout.web, argument, board: BOARD, stateDir: localStateDir(layout.folder, skill), env: {} })
      const resolve = 'stage' in first ? first.stage.actions.find((action) => action.action === 'resolve') : undefined
      expect(resolve).toMatchObject({ folder: join(layout.root, '.work', '<id in lower case>-<title as a slug>') })
      const stateDir = await resolved(skill, layout.folder)
      const second = await localBoardStep({ skill, repo: layout.web, argument, board: BOARD, stateDir, env: {} })
      const actions = 'stage' in second ? second.stage.actions : []
      expect(actions.filter((action) => action.action === 'move' || action.action === 'set')).toEqual([])
      expect(existsSync(join(layout.web, '.work'))).toBe(false)

      for (const [file, text] of Object.entries(OUTPUT[skill] ?? {})) await writeInto(join(layout.folder, file), text)
      if (skill === 'groomer') await writeInto(join(layout.folder, 'groom/trace/decisions.md'), '# Grooming Decisions\n')
      const ended = await localBoardEnd({
        skill,
        folder: layout.folder,
        runStatus: issued(skill),
        exportDir: layout.folder,
        stateDir,
        verifyCommand: 'verify',
        push: (page, title, markdown) => client.pushPage(page, title, markdown),
      })
      expect(ended.actions.filter((action) => action.action === 'move' || action.action === 'set')).toEqual([])
      expect(statusWrites()).toEqual([])
      const pages = skill === 'spec-writer' ? [SPEC, SPEC_REVIEWED] : skill === 'planner' ? [PLAN] : []
      expect(pages.every(wrote)).toBe(true)
      if (skill === 'groomer') expect(ended.actions.some((action) => action.action === 'replace' && (action as { title?: string }).title === 'Grooming Decisions')).toBe(true)
    })
  }
})
