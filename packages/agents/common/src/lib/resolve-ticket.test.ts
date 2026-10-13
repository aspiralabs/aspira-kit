// scripts/resolve-ticket.ts as `kit next`, `kit cleanup` and `kit worktree` run it: a separate Node process
// whose stdout key=value lines and exit code are the contract. The board is the system boundary (TEST-007):
// a preload points fetch at a local mock Notion server that answers from the recorded NOM-4 fixtures.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = new URL('../../scripts/resolve-ticket.ts', import.meta.url).pathname
const DS = 'b4e393d4-a4a6-46b8-bbd1-3d6c0f45a01e'
const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const OTHER_PAGE = '11111111-2222-3333-4444-555555555555'

type Json = Record<string, unknown>
const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/board/${name}`, import.meta.url), 'utf8')) as Json
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

let server: Server
let api: string
/** The NOM-4 page's Type select, or null for a card without one. */
let type: string | null
/** Every Notion route answers 500. */
let failing: boolean

function page(): Json {
  const base = fixture('nom-4.page.json')
  const properties = isRecord(base.properties) ? base.properties : {}
  return { ...base, properties: { ...properties, Type: { id: 'YH08dA', type: 'select', select: type === null ? null : { name: type } } } }
}

async function body(request: IncomingMessage): Promise<Json> {
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  const parsed: unknown = raw === '' ? {} : JSON.parse(raw)
  return isRecord(parsed) ? parsed : {}
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  const path = request.url ?? ''
  const method = request.method ?? 'GET'
  if (failing) return json({ object: 'error', status: 500, code: 'internal_server_error', message: 'Notion is down' }, 500)
  if (method === 'GET' && path === `/v1/data_sources/${DS}`) return json(fixture('feature-board.data-source.json'))
  if (method === 'POST' && path === `/v1/data_sources/${DS}/query`) {
    const filter = (await body(request)).filter
    const uniqueId = isRecord(filter) && isRecord(filter.unique_id) ? filter.unique_id.equals : undefined
    return json({ ...fixture('query.nom-4.json'), results: uniqueId === 4 ? [page()] : [] })
  }
  if (method === 'GET' && path === `/v1/pages/${PAGE}`) return json(page())
  if (method === 'GET' && path === `/v1/pages/${OTHER_PAGE}`) return json({ object: 'page', id: OTHER_PAGE, url: `https://www.notion.so/${OTHER_PAGE}`, parent: { type: 'page_id', page_id: PAGE }, properties: {} })
  if (method === 'GET' && path.startsWith(`/v1/blocks/${PAGE}/children`)) return json(fixture('nom-4.children.json'))
  if (method === 'GET' && path.startsWith('/v1/blocks/')) return json({ object: 'list', results: [], next_cursor: null, has_more: false })
  if (method === 'GET' && path === `/v1/pages/${PAGE}/markdown`) return json(fixture('nom-4.markdown.json'))
  return json({ object: 'error', status: 404, code: 'object_not_found', message: `No route ${method} ${path}` }, 404)
}

/** Points the script's fetch at the mock server: the one network boundary it has. */
const PRELOAD = `data:text/javascript,${encodeURIComponent("const real = globalThis.fetch; globalThis.fetch = (url, init) => real(String(url).replace('https://api.notion.com', process.env.MOCK_NOTION_ORIGIN), init)")}`

type Run = { code: number | null; stdout: string; stderr: string }

/** Runs the script; `token: null` runs it with no NOTION_TOKEN at all. */
function resolve(args: string[], token: string | null = 'test-token'): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, MOCK_NOTION_ORIGIN: api }
  delete env.NOTION_TOKEN
  if (token !== null) env.NOTION_TOKEN = token
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

const lines = (stdout: string) => stdout.split('\n').filter((line) => line !== '')

beforeAll(async () => {
  server = createServer((request, response) => void handle(request, response))
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}` // listen(0) on a TCP host always yields an AddressInfo
})

afterAll(async () => {
  await new Promise((closed) => server.close(closed))
})

beforeEach(() => {
  type = 'Feature'
  failing = false
})

describe('resolve-ticket on a ticket the board has', () => {
  it('prints the ticket keys, its Type and its working-folder name, and exits 0', async () => {
    const run = await resolve(['NOM-4', '--board', DS])
    expect({ code: run.code, lines: lines(run.stdout) }).toEqual({
      code: 0,
      lines: [
        'id=NOM-4',
        'title=Explore pagination',
        'url=https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1',
        'status=In Review: Implementation',
        'pr=https://github.com/aspiralabs/nomnomzz/pull/2',
        'dev=Claude',
        'type=Feature',
        'folder=nom-4-explore-pagination',
      ],
    })
  })

  it('prints an empty type= line for a card with no Type', async () => {
    type = null
    const run = await resolve(['NOM-4', '--board', DS])
    expect(lines(run.stdout)).toContain('type=')
  })
})

describe('resolve-ticket on a ticket the board does not have', () => {
  it('prints error=unknown and exits 1 for an ID the board has no card for', async () => {
    const run = await resolve(['NOM-99', '--board', DS])
    expect({ code: run.code, stdout: lines(run.stdout), stderr: run.stderr.trim() }).toEqual({ code: 1, stdout: ['error=unknown'], stderr: 'resolve-ticket: No ticket NOM-99 on the board' })
  })

  it('prints error=unknown and exits 1 for an ID with another board prefix', async () => {
    const run = await resolve(['KIT-4', '--board', DS])
    expect({ code: run.code, stdout: lines(run.stdout) }).toEqual({ code: 1, stdout: ['error=unknown'] })
  })

  it('prints error=unknown and exits 1 for a page URL that is not on this board', async () => {
    const run = await resolve([`https://www.notion.so/${OTHER_PAGE.replaceAll('-', '')}`, '--board', DS])
    expect({ code: run.code, stdout: lines(run.stdout) }).toEqual({ code: 1, stdout: ['error=unknown'] })
  })
})

describe('resolve-ticket when the board cannot answer', () => {
  it('prints error=unreachable and exits 1 when Notion fails', async () => {
    failing = true
    const run = await resolve(['NOM-4', '--board', DS])
    expect({ code: run.code, stdout: lines(run.stdout), stderr: run.stderr }).toEqual({ code: 1, stdout: ['error=unreachable'], stderr: expect.stringContaining('resolve-ticket: Notion 500') })
  })

  it('prints error=unreachable and exits 1 without a Notion token', async () => {
    const run = await resolve(['NOM-4', '--board', DS], null)
    expect({ code: run.code, stdout: lines(run.stdout) }).toEqual({ code: 1, stdout: ['error=unreachable'] })
  })

  it('prints error=unreachable and exits 1 on a usage error', async () => {
    const run = await resolve(['NOM-4'])
    expect({ code: run.code, stdout: lines(run.stdout), stderr: run.stderr }).toEqual({ code: 1, stdout: ['error=unreachable'], stderr: expect.stringContaining('resolve-ticket: Usage:') })
  })
})
