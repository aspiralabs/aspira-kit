import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardError, board, ideaOf, parseTicketRef, type Board } from './board'
import { renderGroomPage } from './decisions'
import type { GroomRecord } from './groom-record'
import { blocksToMarkdown, markdownToBlocks, type Block } from './notion-markdown'
import { renderTicketMd } from './ticket'
import { finishFlow } from './ticket-flow'

// Recorded Notion API shapes (page, data source, block children, page markdown) filled with
// the NOM-4 ticket as the MCP shows it. The mock server below answers from them, so no test
// touches the network. The server keeps the blocks it is sent, so appends can be read back.

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/board/${name}`, import.meta.url), 'utf8')) as T
const DS = 'b4e393d4-a4a6-46b8-bbd1-3d6c0f45a01e'
const DB = 'd9e768e6-e796-4311-8781-14cbbe433ea1' // the Feature Board's database page id, what a person copies from Notion
const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const SPEC_REVIEWED = '3ec3e59b-2258-8123-961c-ce4ccd8e662a'
const TOKEN = 'test-token'

type Json = Record<string, unknown>
/** One request as the server saw it: `body` is the parsed JSON body, `raw` the bytes as sent (a multipart body stays raw). */
type Call = { method: string; path: string; body?: Json; headers?: IncomingHttpHeaders; raw?: string }

let server: Server
let api: string
let calls: Call[]
let status: string
let stored: Map<string, Json[]>
let nextId: number
let rateLimitOnce: boolean
/** The ticket page's children come from `stored` alone, not from the recorded fixture: set by `setBody`. */
let bodyFromStore: boolean
/** Pages whose markdown route answers `truncated: true`. */
let truncated: Set<string>
/** The n-th PATCH /blocks/{id}/children (counted from 1) answers 500. */
let failAppendAt: number | undefined
let appends: number
/** Any PATCH /blocks/{id}/children carrying `position` answers 400. */
let refusePosition: boolean
/** Page objects GET /pages/{id} serves beyond the ticket: child pages created or registered by a test. */
let pageObjects: Map<string, Json>
let clock: number
/** The first POST /v1/file_uploads/{id}/send answers 429 with Retry-After 0. */
let rateLimitSendOnce: boolean
/** Every POST /v1/file_uploads/{id}/send answers 500. */
let failSend: boolean
/** Page markdown served by GET /pages/{id}/markdown for pages that are not block trees: the guidelines the knowledge walk reads. */
let markdownPages: Map<string, string>

function page(): Json {
  const base = fixture<Json>('nom-4.page.json')
  const properties = { ...(base.properties as Json), Status: { id: 'bEBnag', type: 'select', select: { name: status } } }
  return { ...base, properties }
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])

/** Stores a block tree under a parent, handing out ids the way Notion does, and returns the top level with ids. With `after`, the blocks go right after that block, in order. */
function store(parent: string, blocks: Json[], after?: string): Json[] {
  const list = stored.get(parent) ?? []
  stored.set(parent, list)
  let at = after === undefined ? list.length : list.findIndex((block) => block.id === after) + 1
  return blocks.map((block) => {
    const id = `blk-${nextId++}`
    const { children, ...rest } = block
    const nested = records(children)
    const saved = { object: 'block', id, has_children: nested.length > 0, ...rest }
    list.splice(at, 0, saved)
    at += 1
    if (nested.length > 0) store(id, nested)
    return saved
  })
}

/** A page's last edit moves forward on every write under it, as Notion's does. */
function touch(parent: string) {
  const object = pageObjects.get(parent)
  if (object !== undefined) pageObjects.set(parent, { ...object, last_edited_time: new Date(Date.UTC(2026, 9, 11, 11, clock++)).toISOString() })
}

/** One page of a block list, 100 at a time, with Notion's cursor. */
function listed(path: string, all: Json[]): { status: number; body: Json } {
  const cursor = new URL(path, 'http://mock').searchParams.get('start_cursor')
  const start = cursor === null ? 0 : Number(cursor)
  const end = start + 100
  return { status: 200, body: { object: 'list', results: all.slice(start, end), has_more: end < all.length, next_cursor: end < all.length ? String(end) : null } }
}

const asBlock = (json: Json): Block => ({ ...json, type: typeof json.type === 'string' ? json.type : 'unsupported' })

/** The request's bytes, and the parsed body when it was sent as JSON. */
async function readBody(request: IncomingMessage): Promise<{ raw?: string; body?: Json }> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString()
  return { raw, body: (request.headers['content-type'] ?? '').startsWith('application/json') ? (JSON.parse(raw) as Json) : undefined }
}

function route(call: Call): { status: number; body: Json } {
  const { method, path, body } = call
  const json = (value: Json, code = 200) => ({ status: code, body: value })
  if (method === 'GET' && path === '/v1/users/me') return json({ object: 'user', id: 'bot-1', type: 'bot', bot: {} })
  if (method === 'POST' && path === '/v1/file_uploads') return json({ object: 'file_upload', id: 'u1', status: 'pending', filename: body?.filename, content_type: body?.content_type })
  if (method === 'POST' && path === '/v1/file_uploads/u1/send') {
    if (failSend) return json({ object: 'error', status: 500, code: 'internal_server_error', message: 'send failed' }, 500)
    return json({ object: 'file_upload', id: 'u1', status: 'uploaded', filename: 'run-x.json', content_type: 'application/json' })
  }
  const knowledge = path.match(/^\/v1\/pages\/([^/]+)\/markdown$/)
  const guideline = knowledge === null ? undefined : markdownPages.get(knowledge[1]!)
  if (method === 'GET' && guideline !== undefined) return json({ object: 'page_markdown', id: knowledge?.[1], markdown: guideline, truncated: false, unknown_block_ids: [] })
  if (method === 'GET' && path === `/v1/data_sources/${DS}`) return json(fixture('feature-board.data-source.json'))
  if (method === 'GET' && path === `/v1/data_sources/${DB}`) return json({ object: 'error', status: 404, code: 'object_not_found', message: `Could not find data_source with ID: ${DB}` }, 404)
  if (method === 'GET' && path === `/v1/databases/${DB}`) return json({ object: 'database', id: DB, data_sources: [{ id: DS, name: 'Feature Board' }] })
  if (method === 'POST' && path === `/v1/data_sources/${DS}/query`) {
    const equals = ((body?.filter as Json | undefined)?.unique_id as Json | undefined)?.equals
    return json(equals === 4 ? { ...fixture<Json>('query.nom-4.json'), results: [page()] } : { object: 'list', results: [], has_more: false, next_cursor: null })
  }
  if (method === 'GET' && path === `/v1/pages/${PAGE}`) return json(page())
  if (method === 'GET' && path === '/v1/pages/99999999-9999-9999-9999-999999999999') return json({ ...page(), id: '99999999-9999-9999-9999-999999999999', parent: { type: 'data_source_id', data_source_id: 'other-source' } })
  if (method === 'PATCH' && path === `/v1/pages/${PAGE}`) {
    const next = ((body?.properties as Json | undefined)?.Status as Json | undefined)?.select as Json | undefined
    if (next) status = next.name as string
    return json(page())
  }
  if (method === 'GET' && path === `/v1/pages/${PAGE}/markdown`) return json({ ...fixture<Json>('nom-4.markdown.json'), ...(truncated.has(PAGE) ? { truncated: true } : {}) })
  if (method === 'GET' && path === `/v1/pages/${SPEC_REVIEWED}/markdown`) return json(fixture('spec-reviewed.markdown.json'))
  if (method === 'GET' && path.startsWith(`/v1/blocks/${PAGE}/children`)) {
    const results = [...(bodyFromStore ? [] : fixture<{ results: Json[] }>('nom-4.children.json').results), ...(stored.get(PAGE) ?? [])]
    return listed(path, results)
  }
  if (method === 'GET' && path.startsWith(`/v1/blocks/${SPEC_REVIEWED}/children`)) {
    const results = stored.has(SPEC_REVIEWED) ? stored.get(SPEC_REVIEWED)! : fixture<{ results: Json[] }>('spec-reviewed.children.json').results
    return listed(path, results)
  }
  const pageMatch = path.match(/^\/v1\/pages\/([^/]+)(\/markdown)?$/)
  const pageObject = pageMatch === null ? undefined : pageObjects.get(pageMatch[1]!)
  if (method === 'GET' && pageMatch !== null && pageMatch[2] === undefined && pageObject !== undefined) return json(pageObject)
  if (method === 'GET' && pageMatch !== null && pageMatch[2] !== undefined && stored.has(pageMatch[1]!)) {
    const id = pageMatch[1]!
    return json({ object: 'page_markdown', id, markdown: blocksToMarkdown((stored.get(id) ?? []).map(asBlock)), truncated: truncated.has(id), unknown_block_ids: [] })
  }
  const children = path.match(/^\/v1\/blocks\/([^/]+)\/children(?:\?.*)?$/)
  if (method === 'GET' && children) return listed(path, stored.get(children[1]!) ?? [])
  if (method === 'PATCH' && children) {
    const parent = children[1]!
    appends += 1
    if (failAppendAt === appends) return json({ object: 'error', status: 500, code: 'internal_server_error', message: `append ${appends} failed` }, 500)
    const position = body?.position
    if (position !== undefined && refusePosition) return json({ object: 'error', status: 400, code: 'validation_error', message: 'body.position should be not present' }, 400)
    const after = isRecord(position) && isRecord(position.after_block) && typeof position.after_block.id === 'string' ? position.after_block.id : undefined
    if (after !== undefined && !(stored.get(parent) ?? []).some((block) => block.id === after)) return json({ object: 'error', status: 400, code: 'validation_error', message: `no block ${after} under ${parent}` }, 400)
    if (parent === SPEC_REVIEWED && !stored.has(SPEC_REVIEWED)) stored.set(SPEC_REVIEWED, [])
    const results = store(parent, records(body?.children), after)
    touch(parent)
    return json({ object: 'list', results })
  }
  const single = path.match(/^\/v1\/blocks\/([^/]+)$/)
  if (method === 'GET' && single) {
    const found = [...stored.values()].flat().find((block) => block.id === single[1])
    return found === undefined ? json({ object: 'error', status: 404, code: 'object_not_found', message: `no block ${single[1]}` }, 404) : json(found)
  }
  if (method === 'DELETE' && single) {
    for (const [parent, list] of stored) {
      const index = list.findIndex((block) => block.id === single[1])
      if (index === -1) continue
      list.splice(index, 1)
      touch(parent)
    }
    return json({ object: 'block', id: single[1], in_trash: true })
  }
  if (method === 'POST' && path === '/v1/pages') {
    const id = `page-${nextId++}`
    store(id, records(body?.children))
    const created = { object: 'page', id, url: `https://www.notion.so/${id}`, last_edited_time: '2026-10-06T00:00:00.000Z', parent: body?.parent }
    pageObjects.set(id, created)
    return json(created)
  }
  return json({ object: 'error', status: 404, code: 'object_not_found', message: `no route for ${method} ${path}` }, 404)
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const call: Call = { method: request.method ?? 'GET', path: request.url ?? '/', headers: request.headers, ...(await readBody(request)) }
    calls.push(call)
    const reply = (code: number, body: Json, headers: Record<string, string> = {}) => {
      response.writeHead(code, { 'Content-Type': 'application/json', ...headers })
      response.end(JSON.stringify(body))
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}` || request.headers['notion-version'] !== '2026-03-11') return reply(401, { object: 'error', status: 401, code: 'unauthorized', message: 'bad token or version' })
    if (rateLimitOnce) {
      rateLimitOnce = false
      return reply(429, { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' }, { 'Retry-After': '0' })
    }
    if (rateLimitSendOnce && call.method === 'POST' && /^\/v1\/file_uploads\/[^/]+\/send$/.test(call.path)) {
      rateLimitSendOnce = false
      return reply(429, { object: 'error', status: 429, code: 'rate_limited', message: 'slow down' }, { 'Retry-After': '0' })
    }
    const { status: code, body } = route(call)
    reply(code, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

let client: Board

beforeEach(() => {
  calls = []
  status = 'In Review: Implementation'
  stored = new Map()
  nextId = 1
  rateLimitOnce = false
  bodyFromStore = false
  truncated = new Set()
  failAppendAt = undefined
  appends = 0
  refusePosition = false
  pageObjects = new Map()
  clock = 0
  rateLimitSendOnce = false
  failSend = false
  markdownPages = new Map()
  client = board({ token: TOKEN, board: `collection://${DS}`, api })
})

const requests = () => calls.map((call) => `${call.method} ${call.path}`)

describe('parseTicketRef', () => {
  it('reads a board id in any case, a bare number, or a page url', () => {
    expect(parseTicketRef('NOM-4')).toEqual({ kind: 'id', prefix: 'NOM', number: 4 })
    expect(parseTicketRef('nom-4')).toEqual({ kind: 'id', prefix: 'NOM', number: 4 })
    expect(parseTicketRef(' 4 ')).toEqual({ kind: 'id', number: 4 })
    expect(parseTicketRef('https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1')).toEqual({ kind: 'url', pageId: PAGE })
    expect(parseTicketRef('https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1?pvs=4')).toEqual({ kind: 'url', pageId: PAGE })
  })

  it('rejects what is neither', () => {
    expect(() => parseTicketRef('spec.md')).toThrow('Not a ticket')
    expect(() => parseTicketRef('')).toThrow('Not a ticket')
  })
})

describe('ideaOf', () => {
  it('takes the Idea section without the child page tags, as plain markdown', () => {
    expect(ideaOf('## Idea\nEvery list stops at 10 \\* 2.\n## Docs\n<page url="https://app.notion.com/p/1">Spec</page>')).toBe('Every list stops at 10 * 2.\n')
  })

  it('takes the whole body when there is no Idea heading, minus child pages and headings left empty', () => {
    expect(ideaOf('A thought.\nAnother.\n## Docs\n<page url="https://app.notion.com/p/1">Spec</page>')).toBe('A thought.\n\nAnother.\n')
    expect(ideaOf('<page url="https://app.notion.com/p/1">Spec</page>')).toBe('')
  })
})

describe('resolveTicket', () => {
  const expected = {
    id: 'NOM-4',
    number: 4,
    pageId: PAGE,
    title: 'Explore pagination',
    url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1',
    status: 'In Review: Implementation',
    type: 'Feature',
    priority: 'P0 - Critical',
    area: ['Discover'],
    dev: 'Claude',
    pr: 'https://github.com/aspiralabs/nomnomzz/pull/2',
    version: undefined,
    lastEditedAt: '2026-10-05T04:55:44.354Z',
    idea: 'Every list stops at 10 and the default Explore order is effectively random. Unblocks find-cooks, cookbook-detail, search-filters, and My Recipes Phase 1.\n',
  }

  it('resolves by ID through the data source, with the child pages by title', async () => {
    const ticket = await client.resolveTicket('NOM-4')
    expect(ticket).toMatchObject(expected)
    expect(Object.keys(ticket.pages)).toEqual(['Spec', 'Spec Reviewed', 'Plan', 'NOM-4 run log (manual AI-DLC, 2026-09-30 to 2026-10-01)', 'Implementation'])
    expect(ticket.pages['Spec Reviewed']).toEqual({ id: SPEC_REVIEWED, title: 'Spec Reviewed', url: 'https://www.notion.so/3ec3e59b22588123961cce4ccd8e662a', lastEditedAt: '2026-10-05T04:48:12.063Z' })
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ filter: { property: 'ID', unique_id: { equals: 4 } }, page_size: 2 })
    expect(requests()).toEqual([`GET /v1/data_sources/${DS}`, `POST /v1/data_sources/${DS}/query`, `GET /v1/blocks/${PAGE}/children?page_size=100`, `GET /v1/pages/${PAGE}/markdown`])
  })

  it('accepts the ID in any case and as a bare number, and reads the board schema once', async () => {
    expect((await client.resolveTicket('nom-4')).id).toBe('NOM-4')
    expect((await client.resolveTicket('4')).id).toBe('NOM-4')
    expect(requests().filter((r) => r === `GET /v1/data_sources/${DS}`)).toHaveLength(1)
  })

  it('refuses an ID with another board prefix, and reports a number the board does not have', async () => {
    await expect(client.resolveTicket('ABC-4')).rejects.toThrow('ABC-4 is not on this board (its IDs are NOM-…)')
    await expect(client.resolveTicket('NOM-99')).rejects.toThrow('No ticket NOM-99 on the board')
  })

  it('resolves by page URL without querying, and refuses a page from another data source', async () => {
    const ticket = await client.resolveTicket('https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1')
    expect(ticket).toMatchObject(expected)
    expect(requests()).not.toContain(`POST /v1/data_sources/${DS}/query`)
    await expect(client.resolveTicket('https://app.notion.com/p/99999999999999999999999999999999')).rejects.toThrow('is not on this board')
  })

  it('fails before any request without a token', async () => {
    await expect(board({ token: '', board: DS, api }).resolveTicket('NOM-4')).rejects.toThrow('NOTION_TOKEN')
    expect(calls).toEqual([])
  })

  it('retries once after a 429 using Retry-After', async () => {
    rateLimitOnce = true
    expect((await client.resolveTicket('NOM-4')).id).toBe('NOM-4')
  })

  it('surfaces a Notion error with its status and message', async () => {
    await expect(board({ token: 'wrong', board: DS, api }).resolveTicket('NOM-4')).rejects.toThrow('Notion 401 (unauthorized): bad token or version')
  })
})

describe('moveTicket', () => {
  it('moves the Status when the current one is the expected one, from a ticket or a page id', async () => {
    const ticket = await client.resolveTicket('NOM-4')
    calls = []
    await expect(client.moveTicket(ticket, 'In Review: Implementation', 'Ready: Implementation')).resolves.toEqual({ id: 'NOM-4', before: 'In Review: Implementation', after: 'Ready: Implementation' })
    expect(requests()).toEqual([`GET /v1/pages/${PAGE}`, `PATCH /v1/pages/${PAGE}`])
    expect(calls[1]?.body).toEqual({ properties: { Status: { select: { name: 'Ready: Implementation' } } } })
    await expect(client.moveTicket(PAGE, 'Ready: Implementation', 'Released')).resolves.toMatchObject({ after: 'Released' })
    expect(status).toBe('Released')
  })

  it('refuses when the current Status differs from `from`, naming both, and writes nothing', async () => {
    await expect(client.moveTicket(PAGE, 'Ready: Plan', 'In Progress: Implementation')).rejects.toThrow(
      'NOM-4 is in "In Review: Implementation", not "Ready: Plan"; not moving it to "In Progress: Implementation"',
    )
    expect(requests()).not.toContain(`PATCH /v1/pages/${PAGE}`)
    expect(status).toBe('In Review: Implementation')
  })

  it('refuses a Status the board does not have', async () => {
    await expect(client.moveTicket(PAGE, 'In Review: Implementation', 'Done')).rejects.toThrow('"Done" is not a Status on this board')
  })
})

describe('setProperty', () => {
  it('sets Dev as a select and PR as a url', async () => {
    await client.setProperty(PAGE, 'Dev', 'Codex')
    await client.setProperty(PAGE, 'PR', 'https://github.com/aspiralabs/nomnomzz/pull/9')
    const patches = calls.filter((call) => call.method === 'PATCH').map((call) => call.body)
    expect(patches).toEqual([{ properties: { Dev: { select: { name: 'Codex' } } } }, { properties: { PR: { url: 'https://github.com/aspiralabs/nomnomzz/pull/9' } } }])
  })

  it('refuses a property the board does not have, or a select value it does not offer', async () => {
    await expect(client.setProperty(PAGE, 'Owner', 'x')).rejects.toThrow('"Owner" is not a property on this board')
    await expect(client.setProperty(PAGE, 'Dev', 'Gemini')).rejects.toThrow('"Gemini" is not a Dev on this board')
    expect(requests()).not.toContain(`PATCH /v1/pages/${PAGE}`)
  })
})

describe('pushPage', () => {
  it('replaces the content of the existing child page with that title and keeps its id', async () => {
    const ticket = await client.resolveTicket('NOM-4')
    calls = []
    const result = await client.pushPage(ticket, 'Spec Reviewed', '## Intent\n\nShorter.\n\n- [ ] F1: done\n')
    expect(result).toEqual({ id: SPEC_REVIEWED, url: 'https://www.notion.so/3ec3e59b22588123961cce4ccd8e662a', created: false })
    expect(requests()).toEqual([
      `GET /v1/blocks/${PAGE}/children?page_size=100`,
      `GET /v1/blocks/${SPEC_REVIEWED}/children?page_size=100`,
      'DELETE /v1/blocks/b1',
      'DELETE /v1/blocks/b2',
      'DELETE /v1/blocks/b3',
      `PATCH /v1/blocks/${SPEC_REVIEWED}/children`,
    ])
    expect(calls.at(-1)?.body).toEqual({ children: markdownToBlocks('## Intent\n\nShorter.\n\n- [ ] F1: done\n') })
    expect(stored.get(SPEC_REVIEWED)?.map((b) => b.type)).toEqual(['heading_2', 'paragraph', 'to_do'])
  })

  it('creates the child page when no page has that title, with the markdown as its blocks', async () => {
    const result = await client.pushPage(PAGE, 'PR Review', '# Review\n\nLooks good.\n')
    expect(result).toEqual({ id: 'page-1', url: 'https://www.notion.so/page-1', created: true })
    const create = calls.find((call) => call.method === 'POST' && call.path === '/v1/pages')?.body
    expect(create).toEqual({
      parent: { page_id: PAGE },
      properties: { title: { title: [{ type: 'text', text: { content: 'PR Review' } }] } },
      children: markdownToBlocks('# Review\n\nLooks good.\n'),
    })
    expect(requests().filter((r) => r.startsWith('DELETE'))).toEqual([])
  })

  it('appends in batches of 100 blocks', async () => {
    const markdown = Array.from({ length: 230 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n')
    await client.pushPage(PAGE, 'Plan B', markdown)
    const sizes = calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').map((call) => (call.body?.children as unknown[]).length)
    expect(sizes).toEqual([100, 100, 30])
    expect(stored.get('page-1')).toHaveLength(230)
  })

  it('attaches list levels deeper than Notion takes in one request by appending to the created blocks', async () => {
    await client.pushPage(PAGE, 'Deep', '- a\n  - b\n    - c\n      - d\n        - e\n')
    const first = calls.find((call) => call.method === 'POST')?.body?.children as { children?: { children?: { children?: unknown }[] }[] }[]
    expect(first[0]?.children?.[0]?.children?.[0]?.children).toBeUndefined()
    const text = (block: Json) => ((block.bulleted_list_item as { rich_text: { text: { content: string } }[] }).rich_text[0]!.text.content)
    const a = stored.get('page-1')![0]!
    const b = stored.get(a.id as string)![0]!
    const c = stored.get(b.id as string)![0]!
    const d = stored.get(c.id as string)![0]!
    const e = stored.get(d.id as string)![0]!
    expect([a, b, c, d, e].map(text)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('pullPage', () => {
  it('returns the child page as plain markdown with its id, url and last edit', async () => {
    const pulled = await client.pullPage(PAGE, 'Spec Reviewed')
    expect(pulled).toMatchObject({ id: SPEC_REVIEWED, title: 'Spec Reviewed', url: 'https://www.notion.so/3ec3e59b22588123961cce4ccd8e662a', lastEditedAt: '2026-10-05T04:48:12.063Z' })
    expect(pulled?.markdown).toContain('## Intent\n\nPeople can reach every recipe')
    expect(pulled?.markdown).toContain('32 findings, $2.23)')
    expect(pulled?.markdown).toContain('- [ ] F11:')
  })

  it('returns undefined when the ticket has no page with that title', async () => {
    await expect(client.pullPage(PAGE, 'Nope')).resolves.toBeUndefined()
  })
})

describe('board given the database page URL', () => {
  it('finds the data source through /databases and resolves the ticket', async () => {
    const b = board({ board: `https://app.notion.com/p/Feature-Board-${DB.replaceAll('-', '')}`, token: TOKEN, api })
    const ticket = await b.resolveTicket('NOM-4')
    expect(ticket.id).toBe('NOM-4')
    expect(requests().slice(0, 4)).toEqual([`GET /v1/data_sources/${DB}`, `GET /v1/databases/${DB}`, `GET /v1/data_sources/${DS}`, `POST /v1/data_sources/${DS}/query`])
  })
})

// ---------------------------------------------------------------------------------------------
// The groomer's board work (KIT-8): the Idea boundary, a truncated card, duplicate child pages,
// the new Board methods and the Idea summary write. Every assertion reads the mock's stored
// blocks or its request log, never the client's internals.
// ---------------------------------------------------------------------------------------------

const rich = (content: string) => [{ type: 'text', text: { content, link: null }, plain_text: content }]
const heading = (id: string, level: 1 | 2 | 3, content: string): Json => ({ object: 'block', id, type: `heading_${level}`, [`heading_${level}`]: { rich_text: rich(content), is_toggleable: false } })
const paragraph = (id: string, content: string): Json => ({ object: 'block', id, type: 'paragraph', paragraph: { rich_text: rich(content) } })
const bullet = (id: string, content: string): Json => ({ object: 'block', id, type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich(content) } })
const childPage = (id: string, title: string, editedAt = '2026-10-11T09:00:00.000Z'): Json => ({ object: 'block', id, type: 'child_page', has_children: true, last_edited_time: editedAt, child_page: { title } })
const toDo = (id: string, content: string, checked: boolean, editor?: string): Json => ({
  object: 'block',
  id,
  type: 'to_do',
  to_do: { rich_text: rich(content), checked },
  ...(editor === undefined ? {} : { last_edited_by: { object: 'user', id: editor } }),
})

/** The plain text of a stored block: its rich text, or a child page's title. */
function plain(block: Json): string {
  const type = block.type
  if (typeof type !== 'string') return ''
  const body = block[type]
  if (!isRecord(body)) return ''
  if (typeof body.title === 'string') return body.title
  return records(body.rich_text)
    .map((part) => (isRecord(part.text) && typeof part.text.content === 'string' ? part.text.content : ''))
    .join('')
}
const isChecked = (block: Json): boolean => isRecord(block.to_do) && block.to_do.checked === true
const shape = (parent: string): string[] => (stored.get(parent) ?? []).map((block) => `${String(block.type)}: ${plain(block)}`)
const idsOf = (parent: string): unknown[] => (stored.get(parent) ?? []).map((block) => block.id)
const deleted = (): string[] => calls.filter((call) => call.method === 'DELETE').map((call) => call.path.split('/').pop() ?? '')
const writes = (): string[] => calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)

/** The ticket page's body is these blocks and nothing from the recorded fixture. */
function setBody(blocks: Json[]) {
  bodyFromStore = true
  stored.set(PAGE, blocks.map((block) => ({ ...block })))
}
const NOM4_BODY = (): Json[] => fixture<{ results: Json[] }>('nom-4.children.json').results

const SUMMARY = [
  'Groomed with /aspira-groomer on 2026-10-11',
  '',
  '### Decisions',
  '',
  '- **Q1 — Who owns the list — the user or the team?** Answer: The team. Why: Shared editing is the norm.',
  '',
  '### Terms',
  '',
  '- **Cook**: a person who publishes recipes. _Avoid_: chef.',
  '',
].join('\n')
const SUMMARY_SHAPE = [
  'paragraph: Groomed with /aspira-groomer on 2026-10-11',
  'heading_3: Decisions',
  'bulleted_list_item: Q1 — Who owns the list — the user or the team? Answer: The team. Why: Shared editing is the norm.',
  'heading_3: Terms',
  'bulleted_list_item: Cook: a person who publishes recipes. Avoid: chef.',
]
const NOM4_SHAPE_AFTER_DOCS = ['heading_2: Docs', 'child_page: Spec', 'child_page: Spec Reviewed', 'child_page: Plan', 'child_page: NOM-4 run log (manual AI-DLC, 2026-09-30 to 2026-10-01)', 'child_page: Implementation']
const NOM4_PROSE = 'Every list stops at 10 and the default Explore order is effectively random. Unblocks find-cooks, cookbook-detail, search-filters, and My Recipes Phase 1.'

/** A card that already carries a groomer summary from an earlier completion. */
const previouslyGroomed = (between: Json[] = []): Json[] => [
  heading('idea', 2, 'Idea'),
  paragraph('prose', 'Lists stop at ten.'),
  paragraph('old-marker', 'Groomed with /aspira-groomer on 2026-10-01'),
  heading('old-decisions', 3, 'Decisions'),
  bullet('old-q1', 'Q1 — Who owns the list? Answer: Each user. Why: Simpler.'),
  ...between,
  heading('old-terms', 3, 'Terms'),
  bullet('old-term', 'None introduced.'),
  heading('docs', 2, 'Docs'),
  childPage('spec-page', 'Spec'),
]
const PREVIOUS_SUMMARY_IDS = ['old-marker', 'old-decisions', 'old-q1', 'old-terms', 'old-term']

describe('ideaOf, the Idea boundary', () => {
  it('# Idea keeps its ### subsections and the ## section after it, both deeper than the Idea heading', () => {
    expect(ideaOf('# Idea\nLists stop at ten.\n### Decisions\n- Keep the team list.\n## Docs\nTail.')).toBe('Lists stop at ten.\n\n### Decisions\n\n- Keep the team list.\n\n## Docs\n\nTail.\n')
  })

  it('## Idea keeps its ### subsections and ends at the next ##', () => {
    expect(ideaOf('## Idea\nLists stop at ten.\n### Terms\n- **Cook**: a person who publishes recipes.\n## Docs\n<page url="https://app.notion.com/p/1">Spec</page>')).toBe(
      'Lists stop at ten.\n\n### Terms\n\n- **Cook**: a person who publishes recipes.\n',
    )
  })

  it('### Idea ends at the next ### and at the ## after it', () => {
    expect(ideaOf('### Idea\nLists stop at ten.\n### Other\nMore.\n## Docs\nTail.')).toBe('Lists stop at ten.\n')
  })

  it('a body with no Idea heading comes back with its heading levels unchanged', () => {
    expect(ideaOf('# Title\nA.\n## Section\nB.\n### Sub\nC.')).toBe('# Title\n\nA.\n\n## Section\n\nB.\n\n### Sub\n\nC.\n')
  })
})

describe('resolveTicket on a truncated card', () => {
  it('refuses with the BoardError pullPage gives for a truncated page', async () => {
    truncated.add(PAGE)
    await expect(client.resolveTicket('NOM-4')).rejects.toBeInstanceOf(BoardError)
    await expect(client.resolveTicket('NOM-4')).rejects.toThrow(/^Notion truncated the page .+; not returning a partial copy$/)
  })
})

describe('resolveTicket with two child pages of one title', () => {
  const G1 = '3f53e59b-2258-8100-0000-0000000000a1'
  const G2 = '3f53e59b-2258-8100-0000-0000000000a2'
  const first = { id: G1, title: 'Grooming Decisions', url: 'https://www.notion.so/3f53e59b2258810000000000000000a1', lastEditedAt: '2026-10-11T10:00:00.000Z' }
  const second = { id: G2, title: 'Grooming Decisions', url: 'https://www.notion.so/3f53e59b2258810000000000000000a2', lastEditedAt: '2026-10-11T10:05:00.000Z' }

  beforeEach(() => setBody([...NOM4_BODY(), childPage(G1, 'Grooming Decisions', first.lastEditedAt), childPage(G2, 'Grooming Decisions', second.lastEditedAt)]))

  it('keeps the first in pages', async () => {
    expect((await client.resolveTicket('NOM-4')).pages['Grooming Decisions']?.id).toBe(G1)
  })

  it('lists both, in page order, under duplicatePages', async () => {
    expect((await client.resolveTicket('NOM-4')).duplicatePages).toEqual([{ title: 'Grooming Decisions', pages: [first, second] }])
  })
})

describe('createPage, appendParagraph and deleteBlock', () => {
  const INTRO = 'Grooming Decisions for NOM-4. Tick one box per question; the next run reads your ticks.'
  const MARKER = 'Run: 2026-10-11T10:00:00Z agent in progress'

  it('creates the page under the ticket, and the marker lands after the intro', async () => {
    const ticket = await client.resolveTicket('NOM-4')
    const created = await client.createPage(ticket, 'Grooming Decisions', INTRO)
    await client.appendParagraph(created.id, MARKER)
    expect(calls.find((call) => call.method === 'POST' && call.path === '/v1/pages')?.body).toMatchObject({ parent: { page_id: PAGE }, properties: { title: { title: [{ text: { content: 'Grooming Decisions' } }] } } })
    expect(shape(created.id)).toEqual([`paragraph: ${INTRO}`, `paragraph: ${MARKER}`])
  })

  it('appendParagraph returns the id of the block it created', async () => {
    const created = await client.createPage(PAGE, 'Grooming Decisions', INTRO)
    const marker = await client.appendParagraph(created.id, MARKER)
    expect(marker).toEqual({ id: stored.get(created.id)?.at(-1)?.id })
  })

  it('deleteBlock deletes that block and no other', async () => {
    const created = await client.createPage(PAGE, 'Grooming Decisions', INTRO)
    const marker = await client.appendParagraph(created.id, MARKER)
    await client.deleteBlock(marker.id)
    expect(deleted()).toEqual([marker.id])
    expect(shape(created.id)).toEqual([`paragraph: ${INTRO}`])
  })
})

describe('replacePage, append-first', () => {
  const GD = '3f53e59b-2258-8100-0000-0000000000d1'
  const GD_URL = 'https://www.notion.so/3f53e59b2258810000000000000000d1'
  const lines = (round: number, count: number) => Array.from({ length: count }, (_, i) => `Round ${round} line ${i + 1}`)
  const round2 = lines(2, 150)
  const round3 = lines(3, 160)

  beforeEach(() => {
    setBody([...NOM4_BODY(), childPage(GD, 'Grooming Decisions')])
    store(GD, markdownToBlocks(round2.join('\n\n')))
    stored.get(GD)?.push(childPage('attachment', 'Attachment'))
    pageObjects.set(GD, { object: 'page', id: GD, url: GD_URL, last_edited_time: '2026-10-11T09:00:00.000Z' })
  })

  it('a failed append leaves the previous rendering in full and deletes nothing', async () => {
    failAppendAt = 2
    await expect(client.replacePage(PAGE, 'Grooming Decisions', round3.join('\n\n'))).rejects.toThrow()
    expect(deleted()).toEqual([])
    expect(shape(GD).filter((line) => line.startsWith('paragraph: Round 2 '))).toEqual(round2.map((line) => `paragraph: ${line}`))
  })

  it('a successful replace leaves the new rendering and the untouched child page', async () => {
    await client.replacePage(PAGE, 'Grooming Decisions', round3.join('\n\n'))
    expect(shape(GD).filter((line) => !line.startsWith('child_page: '))).toEqual(round3.map((line) => `paragraph: ${line}`))
    expect((stored.get(GD) ?? []).filter((block) => block.type === 'child_page').map((block) => block.id)).toEqual(['attachment'])
  })

  it('returns the page object\'s last edit after the writes', async () => {
    const result = await client.replacePage(PAGE, 'Grooming Decisions', round3.join('\n\n'))
    expect(result).toEqual({ id: GD, url: GD_URL, lastEditedAt: pageObjects.get(GD)?.last_edited_time })
  })
})

describe('listToDos and me', () => {
  const PAGE_ID = 'todo-page'
  const fill = (from: number, count: number) => Array.from({ length: count }, (_, i) => paragraph(`p${from + i}`, `Line ${from + i}`))

  beforeEach(() => {
    stored.set(PAGE_ID, [
      toDo('t1', 'The team', true, 'human-7'),
      ...fill(1, 40),
      toDo('t2', 'Each user', false, 'bot-1'),
      ...fill(41, 60),
      toDo('t3', 'Confirm', true),
      ...fill(101, 15),
      toDo('t4', 'Stop', false, 'human-7'),
    ])
  })

  it('returns every to-do across pages with its tick, text and last editor', async () => {
    expect(await client.listToDos(PAGE_ID)).toEqual([
      { id: 't1', checked: true, text: 'The team', lastEditedBy: { id: 'human-7' } },
      { id: 't2', checked: false, text: 'Each user', lastEditedBy: { id: 'bot-1' } },
      { id: 't3', checked: true, text: 'Confirm', lastEditedBy: undefined },
      { id: 't4', checked: false, text: 'Stop', lastEditedBy: { id: 'human-7' } },
    ])
  })

  it('me() returns the integration\'s own user', async () => {
    expect(await client.me()).toEqual({ id: 'bot-1' })
  })
})

describe('writeIdeaSummary', () => {
  it('on the NOM-4 card inserts the marker, Decisions and Terms after the Idea prose', async () => {
    setBody(NOM4_BODY())
    const ticket = await client.resolveTicket('NOM-4')
    await client.writeIdeaSummary(ticket, SUMMARY)
    expect(shape(PAGE)).toEqual([`heading_2: Idea`, `paragraph: ${NOM4_PROSE}`, ...SUMMARY_SHAPE, ...NOM4_SHAPE_AFTER_DOCS])
  })

  it('on the NOM-4 card deletes nothing and keeps the ids and text of the prose and the child pages', async () => {
    const before = NOM4_BODY().map((block) => `${String(block.id)} ${plain(block)}`)
    setBody(NOM4_BODY())
    await client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)
    const kept = new Set(NOM4_BODY().map((block) => block.id))
    expect(deleted()).toEqual([])
    expect((stored.get(PAGE) ?? []).filter((block) => kept.has(block.id)).map((block) => `${String(block.id)} ${plain(block)}`)).toEqual(before)
  })

  it('the Idea range on the blocks list reads as the same markdown as ticket.idea', async () => {
    const blocks = fixture<{ results: Block[] }>('nom-4.children.json').results
    const start = blocks.findIndex((block) => block.id === 'a1')
    const end = blocks.findIndex((block) => block.id === 'a3')
    expect(blocksToMarkdown(blocks.slice(start + 1, end))).toBe((await client.resolveTicket('NOM-4')).idea)
  })

  it('replaces exactly the previous summary, in place, with no second copy', async () => {
    setBody(previouslyGroomed())
    await client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)
    expect([...deleted()].sort()).toEqual([...PREVIOUS_SUMMARY_IDS].sort())
    expect(shape(PAGE)).toEqual(['heading_2: Idea', 'paragraph: Lists stop at ten.', ...SUMMARY_SHAPE, 'heading_2: Docs', 'child_page: Spec'])
  })

  it('refuses a summary range that holds a block the groomer did not write, and deletes nothing', async () => {
    setBody(previouslyGroomed([paragraph('note-1', 'Ask Sam about shared lists.')]))
    await expect(client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)).rejects.toThrow(/^the Idea summary range holds a block the groomer did not write: note-1 \(paragraph\)$/)
    expect(deleted()).toEqual([])
  })

  it('never touches a ### Terms heading in the prose above the marker', async () => {
    const body = previouslyGroomed()
    setBody([...body.slice(0, 2), heading('prose-terms', 3, 'Terms'), bullet('prose-term', 'Cook: whoever is at the stove.'), ...body.slice(2)])
    await client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)
    expect(deleted().filter((id) => id === 'prose-terms' || id === 'prose-term')).toEqual([])
    expect(shape(PAGE).slice(0, 4)).toEqual(['heading_2: Idea', 'paragraph: Lists stop at ten.', 'heading_3: Terms', 'bulleted_list_item: Cook: whoever is at the stove.'])
  })

  it('leaves a hand-groomed ### Decisions list with no marker alone and writes the summary below it', async () => {
    setBody([heading('idea', 2, 'Idea'), paragraph('prose', 'Lists stop at ten.'), heading('hand-decisions', 3, 'Decisions'), bullet('hand-d1', 'D1 — Name. Lists, not boards.'), bullet('hand-d2', 'D2 — Moves. Humans only.'), heading('docs', 2, 'Docs'), childPage('spec-page', 'Spec')])
    await client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)
    expect(deleted()).toEqual([])
    expect(shape(PAGE)).toEqual([
      'heading_2: Idea',
      'paragraph: Lists stop at ten.',
      'heading_3: Decisions',
      'bulleted_list_item: D1 — Name. Lists, not boards.',
      'bulleted_list_item: D2 — Moves. Humans only.',
      ...SUMMARY_SHAPE,
      'heading_2: Docs',
      'child_page: Spec',
    ])
  })

  it('on a card with no Idea heading inserts ## Idea and the summary after the last prose block, before the child pages', async () => {
    setBody([paragraph('prose-1', 'Lists stop at ten.'), paragraph('prose-2', 'Nobody can find older recipes.'), childPage('spec-page', 'Spec'), childPage('plan-page', 'Plan')])
    await client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)
    expect(shape(PAGE)).toEqual(['paragraph: Lists stop at ten.', 'paragraph: Nobody can find older recipes.', 'heading_2: Idea', ...SUMMARY_SHAPE, 'child_page: Spec', 'child_page: Plan'])
  })

  it('refuses a ### Idea heading and writes nothing', async () => {
    setBody([heading('idea', 3, 'Idea'), paragraph('prose', 'Lists stop at ten.'), childPage('spec-page', 'Spec')])
    const ticket = await client.resolveTicket('NOM-4')
    calls = []
    await expect(client.writeIdeaSummary(ticket, SUMMARY)).rejects.toThrow("NOM-4's Idea heading is level 3; change it to ## Idea by hand, then rerun")
    expect(writes()).toEqual([])
  })

  it('on a title-only card appends the heading and the summary after the Grooming Decisions link, as the last blocks', async () => {
    setBody([childPage('gd-page', 'Grooming Decisions')])
    await client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)
    expect(shape(PAGE)).toEqual(['child_page: Grooming Decisions', 'heading_2: Idea', ...SUMMARY_SHAPE])
  })

  it('refuses when Notion will not insert at a position, and deletes or appends nothing', async () => {
    refusePosition = true
    setBody(previouslyGroomed())
    const before = idsOf(PAGE)
    await expect(client.writeIdeaSummary(await client.resolveTicket('NOM-4'), SUMMARY)).rejects.toThrow('cannot write the Idea summary without rewriting the Idea section')
    expect(deleted()).toEqual([])
    expect(idsOf(PAGE)).toEqual(before)
  })
})

describe('finishFlow for the groomer, a tick made on Notion', () => {
  const GD = '3f53e59b-2258-8100-0000-0000000000d2'
  const GD_URL = 'https://www.notion.so/3f53e59b2258810000000000000000d2'
  const GD_EDITED = '2026-10-11T09:00:00.000Z'
  let folder: string

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'groomer-finish-'))
  })

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  it('records the Notion tick as the author\'s answer and who ticked it', async () => {
    status = 'Grooming'
    setBody([...NOM4_BODY(), childPage(GD, 'Grooming Decisions', GD_EDITED)])
    pageObjects.set(GD, { object: 'page', id: GD, url: GD_URL, last_edited_time: GD_EDITED })
    const record: GroomRecord = {
      decisions: [
        {
          id: 'Q1',
          question: 'Who owns the list?',
          options: ['The team', 'Each user'],
          recommended: 'The team',
          reasoning: 'Shared editing is the norm.',
          whyYours: 'It decides who can change a list.',
          decidedBy: 'open',
          answer: null,
          branch: 'who',
          facts: [{ path: 'packages/ai/common/src/lib/board.ts', line: 87 }],
        },
      ],
      branches: [{ id: 'who', state: 'visited' }],
      round: 1,
      startedAt: '2026-10-11T10:00:00.000Z',
      open: 1,
      page: { id: GD, url: GD_URL },
      status: 'needs-author',
      reasonCode: null,
      reason: null,
    }
    const rendered = renderGroomPage(record, { date: '2026-10-11', notes: [] })
    // The page on Notion: the rendering the start pulled, Q1's first option since ticked by a person, and this run's marker.
    const onNotion = store(GD, markdownToBlocks(rendered.replace(/^- \[ \] The team/m, '- [x] The team')))
    for (const block of onNotion) if (block.type === 'to_do') block.last_edited_by = { object: 'user', id: isChecked(block) ? 'human-7' : 'bot-1' }
    const [marker] = store(GD, [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich('Run: 2026-10-11T10:00:00.000Z agent in progress') } }])
    await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
    await writeFile(join(folder, 'groom', 'trace', 'groom.json'), `${JSON.stringify({ ...record, markerBlockId: marker?.id }, null, 2)}\n`)
    await writeFile(join(folder, 'groom', 'trace', 'decisions.md'), rendered)
    await writeFile(
      join(folder, 'ticket.md'),
      renderTicketMd({
        id: 'NOM-4',
        title: 'Explore pagination',
        url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1',
        status: 'Grooming',
        type: 'Feature',
        priority: 'P0 - Critical',
        area: ['Discover'],
        dev: 'Claude',
        pr: undefined,
        version: undefined,
        pulledAt: '2026-10-11T10:00:00.000Z',
        idea: `${NOM4_PROSE}\n`,
        pages: { 'Grooming Decisions': { id: GD, title: 'Grooming Decisions', url: GD_URL, lastEditedAt: GD_EDITED } },
      }),
    )

    await finishFlow({ skill: 'groomer', folder, runStatus: 'needs-author', board: `collection://${DS}`, client })

    const page = stored.get(GD) ?? []
    expect(page.map(plain)).toContain('Decided by the author: The team.')
    expect(page.filter((block) => block.type === 'to_do' && isChecked(block)).map(plain)).toEqual([expect.stringMatching(/^The team\b/)])
    const saved: unknown = JSON.parse(await readFile(join(folder, 'groom', 'trace', 'groom.json'), 'utf8'))
    expect(saved).toMatchObject({ decisions: [expect.objectContaining({ id: 'Q1', tickedBy: { kind: 'notion', id: 'human-7' } })] })
  })
})

const SEND = '/v1/file_uploads/u1/send'
const sendCalls = (): Call[] => calls.filter((call) => call.method === 'POST' && call.path === SEND)

describe('file upload', () => {
  beforeEach(() => setBody([]))

  it('creates the upload as a JSON request with the filename and content type', async () => {
    await client.uploadFile('run-x.json', '{}')
    const create = calls.find((call) => call.method === 'POST' && call.path === '/v1/file_uploads')
    expect({ contentType: create?.headers?.['content-type'], body: create?.body }).toEqual({ contentType: 'application/json', body: { filename: 'run-x.json', content_type: 'application/json' } })
  })

  it('sends the file as multipart/form-data with a file field, Bearer auth and the Notion-Version header', async () => {
    await client.uploadFile('run-x.json', '{}')
    const send = sendCalls().at(-1)
    expect({
      multipart: /^multipart\/form-data; boundary=/.test(send?.headers?.['content-type'] ?? ''),
      fileField: /Content-Disposition: form-data; name="file"/.test(send?.raw ?? ''),
      authorization: send?.headers?.authorization,
      version: send?.headers?.['notion-version'],
    }).toEqual({ multipart: true, fileField: true, authorization: `Bearer ${TOKEN}`, version: '2026-03-11' })
  })

  it('retries the send after a 429 and completes the upload', async () => {
    rateLimitSendOnce = true
    await client.uploadFile('run-x.json', '{}')
    expect(sendCalls()).toHaveLength(2)
  })

  it('appends one file block naming the upload to the end of the page', async () => {
    await client.appendFileBlock(PAGE, 'u1')
    const append = calls.find((call) => call.method === 'PATCH' && call.path === `/v1/blocks/${PAGE}/children`)
    expect(append?.body).toEqual({ children: [{ type: 'file', file: { type: 'file_upload', file_upload: { id: 'u1' } } }] })
  })

  it('returns the id of the created file block', async () => {
    await expect(client.appendFileBlock(PAGE, 'u1')).resolves.toEqual({ id: 'blk-1' })
  })

  it('raises a BoardError carrying the status when the send answers 500', async () => {
    failSend = true
    const error: unknown = await client.uploadFile('run-x.json', '{}').catch((caught: unknown) => caught)
    expect(error instanceof BoardError ? error.status : error).toBe(500)
  })
})

describe('fileBlockNames', () => {
  const fileBlock = (id: string, name: string): Json => ({ object: 'block', id, type: 'file', file: { type: 'file', name, caption: [], file: { url: `https://files.notion.test/${name}`, expiry_time: '2026-10-15T12:00:00.000Z' } } })

  it('names every top-level file block across pages of the block list', async () => {
    const filler = Array.from({ length: 148 }, (_, i) => paragraph(`p-${i}`, `line ${i}`))
    setBody([fileBlock('f-a', 'run-a.json'), ...filler, fileBlock('f-b', 'run-b.json')])
    await expect(client.fileBlockNames(PAGE)).resolves.toEqual(['run-a.json', 'run-b.json'])
  })
})

describe('rulesPage', () => {
  // The guidelines tree as the knowledge walk reaches it: Engineering Central › AI-DLC › Feature Board.
  const ROOT = '3e73e59b-2258-8032-b0c4-c2c10bd18cab'
  const AIDLC = '3e83e59b-2258-817b-8658-f355337a4917'
  const FEATURE_BOARD = '3e93e59b-2258-81bb-a552-f8e336ad08ad'
  const RULES = 'BOARD-003 Every run on the ticket may append one run telemetry file block at the end of the page body.'
  const link = (id: string, title: string) => `<page url="https://app.notion.com/p/${id.replaceAll('-', '')}">${title}</page>`

  beforeEach(() => {
    vi.stubEnv('KNOWLEDGE_PAGE', `https://app.notion.com/p/${ROOT.replaceAll('-', '')}`)
    markdownPages.set(ROOT, `Engineering rules.\n${link(AIDLC, 'AI-DLC (AI Development Lifecycle)')}`)
    markdownPages.set(AIDLC, `How work moves.\n${link(FEATURE_BOARD, 'Feature Board')}`)
    markdownPages.set(FEATURE_BOARD, RULES)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // A client made after KNOWLEDGE_PAGE is set, so it does not matter when board() reads it.
  const rulesClient = () => board({ token: TOKEN, board: `collection://${DS}`, api })

  it('returns the Feature Board page markdown found through the knowledge walk from KNOWLEDGE_PAGE', async () => {
    expect((await rulesClient().rulesPage())?.trim()).toBe(RULES)
  })

  it('returns null when the Feature Board page is not reachable', async () => {
    markdownPages.delete(FEATURE_BOARD)
    await expect(rulesClient().rulesPage()).resolves.toBeNull()
  })
})
