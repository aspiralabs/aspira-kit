// KIT-54: the cloud phases' read-only Notion tools. A fake fetch stands in for the Notion API; the
// seams are the request path, the rendered markdown and the error text a phase sees.

import { describe, expect, it } from 'vitest'
import { cellOf, notionReadTools, notionReadToolsFromEnv, renderRows } from './notion-read.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PAGE = '4003e59b-2258-816e-8140-c6d0ccff6d7d'
const DB = '522d8d34-9097-420a-932b-48a27b65d150'

function fakeNotion(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: string[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.notion.com/v1', '')
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const route = routes[path]
    return route ? route(init) : new Response('{"message":"no route"}', { status: 404 })
  }
  return { fetch, calls }
}

const run = async (tools: ReturnType<typeof notionReadTools>, name: 'notion_read' | 'notion_search', input: Record<string, string>) =>
  (await tools[name]!.execute!(input, { toolCallId: 't', messages: [], context: {} })) as string

describe('notion_read', () => {
  it('returns a page as its markdown, sending the integration token and the API version', async () => {
    const { fetch, calls } = fakeNotion({ [`/pages/${PAGE}/markdown`]: () => json({ markdown: '# Approved Technologies\n\nUse Adopt or Trial.' }) })
    const tools = notionReadTools({ token: 'ntn_x', fetch })
    const text = await run(tools, 'notion_read', { url: `https://app.notion.com/p/${PAGE.replaceAll('-', '')}` })
    expect({ text, calls }).toEqual({ text: '# Approved Technologies\n\nUse Adopt or Trial.', calls: [`GET /pages/${PAGE}/markdown`] })
  })

  it('reads a database as a table of its rows through its data source, title column first, when the page read says it is a database', async () => {
    const rows = [
      { url: 'https://n/1', properties: { Status: { type: 'select', select: { name: 'Adopt' } }, Name: { type: 'title', title: [{ plain_text: 'AWS SDK v3' }] }, Tags: { type: 'multi_select', multi_select: [{ name: 'aws' }, { name: 'sdk' }] } } },
      { url: 'https://n/2', properties: { Status: { type: 'select', select: null }, Name: { type: 'title', title: [{ plain_text: 'Left | pad' }] }, Tags: { type: 'multi_select', multi_select: [] } } },
    ]
    const { fetch, calls } = fakeNotion({
      [`/pages/${DB}/markdown`]: () => new Response('{"message":"Validation error: 522d is a database, not a page"}', { status: 400 }),
      [`/databases/${DB}`]: () => json({ title: [{ plain_text: 'Approved Technologies' }], data_sources: [{ id: 'ds1' }] }),
      ['/data_sources/ds1/query']: () => json({ results: rows, has_more: false }),
    })
    const text = await run(notionReadTools({ token: 'ntn_x', fetch }), 'notion_read', { url: DB })
    expect(calls).toEqual([`GET /pages/${DB}/markdown`, `GET /databases/${DB}`, 'POST /data_sources/ds1/query'])
    expect(text).toBe(['# Approved Technologies (database, 2 rows)', '', '| Name | Status | Tags | URL |', '| --- | --- | --- | --- |', '| AWS SDK v3 | Adopt | aws, sdk | https://n/1 |', '| Left \\| pad |  |  | https://n/2 |'].join('\n'))
  })

  it('follows the cursor and stops at maxRows, saying so', async () => {
    const row = (n: number) => ({ url: `https://n/${n}`, properties: { Name: { type: 'title', title: [{ plain_text: `row ${n}` }] } } })
    let page = 0
    const { fetch } = fakeNotion({
      [`/pages/${DB}/markdown`]: () => new Response('is a database, not a page', { status: 400 }),
      [`/databases/${DB}`]: () => json({ title: [{ plain_text: 'ADRs' }], data_sources: [{ id: 'ds' }] }),
      ['/data_sources/ds/query']: () => json(page++ === 0 ? { results: [row(1), row(2)], has_more: true, next_cursor: 'c2' } : { results: [row(3), row(4)], has_more: false }),
    })
    const text = await run(notionReadTools({ token: 'ntn_x', fetch, maxRows: 3 }), 'notion_read', { url: DB })
    expect({ head: text.split('\n')[0], rows: (text.match(/^\| row/gm) ?? []).length }).toEqual({ head: '# ADRs (database, 3 rows, first 3 shown)', rows: 3 })
  })

  it('names a page the integration cannot see, and a bad id, as text the phase can act on; it never throws', async () => {
    const { fetch } = fakeNotion({ [`/pages/${PAGE}/markdown`]: () => new Response('{"message":"Could not find page"}', { status: 404 }) })
    const tools = notionReadTools({ token: 'ntn_x', fetch })
    expect(await run(tools, 'notion_read', { url: PAGE })).toContain('is the page shared with the integration?')
    expect(await run(tools, 'notion_read', { url: 'not-an-id' })).toContain('Not a Notion page or database URL or id')
  })
})

describe('notion_search', () => {
  it('lists titles with their URLs for pages and databases', async () => {
    const { fetch, calls } = fakeNotion({
      ['/search']: () => json({ results: [{ object: 'database', url: 'https://n/db', title: [{ plain_text: 'Approved Technologies' }] }, { object: 'page', url: 'https://n/p', properties: { Name: { type: 'title', title: [{ plain_text: 'ADR-7' }] } } }] }),
    })
    const text = await run(notionReadTools({ token: 'ntn_x', fetch }), 'notion_search', { query: 'Approved' })
    expect({ text, calls }).toEqual({ text: '- Approved Technologies (database): https://n/db\n- ADR-7 (page): https://n/p', calls: ['POST /search'] })
  })
})

describe('cells and env', () => {
  it('flattens every property type a board or a guideline database uses', () => {
    expect([
      cellOf({ type: 'checkbox', checkbox: true }),
      cellOf({ type: 'number', number: 3 }),
      cellOf({ type: 'date', date: { start: '2026-10-21', end: '2026-10-22' } }),
      cellOf({ type: 'people', people: [{ name: 'David' }] }),
      cellOf({ type: 'url', url: 'https://x' }),
      cellOf({ type: 'formula', formula: { type: 'string', string: 'f' } }),
      cellOf({ type: 'unique_id', unique_id: { prefix: 'KIT', number: 54 } }),
      cellOf({ type: 'relation', relation: [{}, {}] }),
      cellOf(undefined),
    ]).toEqual(['yes', '3', '2026-10-21 to 2026-10-22', 'David', 'https://x', 'f', 'KIT-54', '2 linked', ''])
    expect(renderRows([])).toBe('No rows.')
  })

  it('exposes the tools only when NOTION_TOKEN is set', () => {
    expect(Object.keys(notionReadToolsFromEnv({}))).toEqual([])
    expect(Object.keys(notionReadToolsFromEnv({ NOTION_TOKEN: 'ntn_x' })).sort()).toEqual(['notion_read', 'notion_search'])
  })
})
