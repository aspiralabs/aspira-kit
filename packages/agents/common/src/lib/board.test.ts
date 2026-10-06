import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { board, ideaOf, parseTicketRef, type Board } from './board'
import { markdownToBlocks } from './notion-markdown'

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
type Call = { method: string; path: string; body?: Json }

let server: Server
let api: string
let calls: Call[]
let status: string
let stored: Map<string, Json[]>
let nextId: number
let rateLimitOnce: boolean

function page(): Json {
  const base = fixture<Json>('nom-4.page.json')
  const properties = { ...(base.properties as Json), Status: { id: 'bEBnag', type: 'select', select: { name: status } } }
  return { ...base, properties }
}

/** Stores a block tree under a parent, handing out ids the way Notion does, and returns the top level with ids. */
function store(parent: string, blocks: Json[]): Json[] {
  const list = stored.get(parent) ?? []
  stored.set(parent, list)
  return blocks.map((block) => {
    const id = `blk-${nextId++}`
    const { children, ...rest } = block as Json & { children?: Json[] }
    const saved = { object: 'block', id, has_children: Boolean(children?.length), ...rest }
    list.push(saved)
    if (children) store(id, children)
    return saved
  })
}

async function readBody(request: IncomingMessage): Promise<Json | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return chunks.length === 0 ? undefined : (JSON.parse(Buffer.concat(chunks).toString()) as Json)
}

function route(call: Call): { status: number; body: Json } {
  const { method, path, body } = call
  const json = (value: Json, code = 200) => ({ status: code, body: value })
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
  if (method === 'GET' && path === `/v1/pages/${PAGE}/markdown`) return json(fixture('nom-4.markdown.json'))
  if (method === 'GET' && path === `/v1/pages/${SPEC_REVIEWED}/markdown`) return json(fixture('spec-reviewed.markdown.json'))
  if (method === 'GET' && path.startsWith(`/v1/blocks/${PAGE}/children`)) {
    const results = [...fixture<{ results: Json[] }>('nom-4.children.json').results, ...(stored.get(PAGE) ?? [])]
    return json({ object: 'list', results, has_more: false, next_cursor: null })
  }
  if (method === 'GET' && path.startsWith(`/v1/blocks/${SPEC_REVIEWED}/children`)) {
    const results = stored.has(SPEC_REVIEWED) ? stored.get(SPEC_REVIEWED)! : fixture<{ results: Json[] }>('spec-reviewed.children.json').results
    return json({ object: 'list', results, has_more: false, next_cursor: null })
  }
  const children = path.match(/^\/v1\/blocks\/([^/]+)\/children(?:\?.*)?$/)
  if (method === 'GET' && children) return json({ object: 'list', results: stored.get(children[1]!) ?? [], has_more: false, next_cursor: null })
  if (method === 'PATCH' && children) {
    if (children[1] === SPEC_REVIEWED && !stored.has(SPEC_REVIEWED)) stored.set(SPEC_REVIEWED, [])
    return json({ object: 'list', results: store(children[1]!, body?.children as Json[]) })
  }
  if (method === 'DELETE' && /^\/v1\/blocks\/[^/]+$/.test(path)) return json({ object: 'block', id: path.split('/').pop(), in_trash: true })
  if (method === 'POST' && path === '/v1/pages') {
    const id = `page-${nextId++}`
    store(id, (body?.children as Json[] | undefined) ?? [])
    return json({ object: 'page', id, url: `https://www.notion.so/${id}`, last_edited_time: '2026-10-06T00:00:00.000Z', parent: body?.parent })
  }
  return json({ object: 'error', status: 404, code: 'object_not_found', message: `no route for ${method} ${path}` }, 404)
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const call: Call = { method: request.method ?? 'GET', path: request.url ?? '/', body: await readBody(request) }
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
