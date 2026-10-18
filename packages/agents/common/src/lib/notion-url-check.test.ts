// T45 (F38): notion-url-check.ts does not exist yet (P25). This file is its contract: kit doctor's
// Notion checks (doctor-notion.test.ts, @aspiralabs/kit) call this module's `checkNotionUrls`
// through the installed package, the same way `kit next` already loads board.ts's resolver.
//
// checkNotionUrls(checks, { token, api }) resolves each `{ key, url, kind }` against Notion by id,
// never by the URL itself: `kind: 'database'` -> GET /v1/databases/{id}, `'page'` -> GET
// /v1/pages/{id}, `'data_source'` -> GET /v1/data_sources/{id} (knowledge.ts's NOTION_API,
// NOTION_VERSION and pageIdFrom extract the id the same way board.ts does). It returns one result
// per key: `{ ok: true }` on 2xx; `{ ok: false, status }` for 401/403/404 (a real failure); and
// `{ ok: false, unreachable: true, reason }` for a network error, 429 or 5xx — doctor does not fail
// on that branch. The reported reason never carries more than the response's first line.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { checkNotionUrls } from './notion-url-check'

const DB = 'd9e768e6-e796-4311-8781-14cbbe433ea1'
const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const DS = 'b4e393d4-a4a6-46b8-bbd1-3d6c0f45a01e'
const FAILING = '3f13e59b-2258-8106-ab5d-c457a42b0e1c'
const TOKEN = 'test-token'

type Call = { method: string; path: string }

let server: Server
let api: string
let calls: Call[]

beforeAll(async () => {
  server = createServer((request, response) => {
    calls.push({ method: request.method ?? 'GET', path: request.url ?? '/' })
    const json = (code: number, body: unknown) => {
      response.writeHead(code, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { object: 'error', status: 401, code: 'unauthorized', message: 'bad token' })
    if (request.url === `/v1/databases/${DB}`) return json(200, { object: 'database', id: DB })
    if (request.url === `/v1/pages/${PAGE}`) return json(403, { object: 'error', status: 403, code: 'restricted_resource', message: 'not shared with this integration' })
    if (request.url === `/v1/data_sources/${DS}`) return json(200, { object: 'data_source', id: DS })
    if (request.url === `/v1/databases/${FAILING}`) return json(500, { object: 'error', status: 500, code: 'internal_server_error', message: 'line one\nline two\nline three' })
    return json(404, { object: 'error', status: 404, code: 'object_not_found', message: `no route for ${request.url}` })
  })
  await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolveClosed, reject) => server.close((error) => (error ? reject(error) : resolveClosed())))
})

beforeEach(() => {
  calls = []
})

describe('checkNotionUrls resolves each key by id, as its own object type (T45, F38)', () => {
  it('checks a database URL under /v1/databases/{id} and reports it ok, never requesting the URL itself', async () => {
    const url = `https://www.notion.so/${DB.replace(/-/g, '')}`
    const result = await checkNotionUrls([{ key: 'board', url, kind: 'database' }], { token: TOKEN, api })
    expect(result.board).toEqual({ ok: true })
    expect(calls).toEqual([{ method: 'GET', path: `/v1/databases/${DB}` }])
    expect(calls.some((call) => call.path.includes(url))).toBe(false)
  })

  it('checks a page URL under /v1/pages/{id} and reports a 403 as failed, with the status', async () => {
    const url = `https://www.notion.so/Releases-${PAGE.replace(/-/g, '')}`
    const result = await checkNotionUrls([{ key: 'releases', url, kind: 'page' }], { token: TOKEN, api })
    expect(result.releases).toMatchObject({ ok: false, status: 403 })
  })

  it('checks a collection:// value under /v1/data_sources/{id} and reports it ok', async () => {
    const result = await checkNotionUrls([{ key: 'board', url: `collection://${DS}`, kind: 'data_source' }], { token: TOKEN, api })
    expect(result.board).toEqual({ ok: true })
    expect(calls).toEqual([{ method: 'GET', path: `/v1/data_sources/${DS}` }])
  })

  it('reports a 500 as unreachable, with a one-line reason even though the response body has three', async () => {
    const url = `https://www.notion.so/${FAILING.replace(/-/g, '')}`
    const result = await checkNotionUrls([{ key: 'glossary', url, kind: 'database' }], { token: TOKEN, api })
    expect(result.glossary).toMatchObject({ ok: false, unreachable: true })
    const reason = result.glossary!.ok ? '' : ((result.glossary as { reason: string }).reason ?? '')
    expect(reason.split('\n').length).toBe(1)
  })
})
