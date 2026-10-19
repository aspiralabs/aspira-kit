import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { board, type Board } from './board'
import { blocksToMarkdown, type Block } from './notion-markdown'
import { ticketCli } from './ticket-cli'
import { afterRun, beforeRun, verifyRun, type BeforeRun, type DriverContext } from './ticket-driver'
import { readTicketMd } from './ticket-flow'
import { TICKET_FILE, renderTicketMd, type Skill, type TicketRecord } from './ticket'

// KIT-19 hand-run telemetry at the shared seams (T13-T20): ticketCli start/finish for default/cloud
// runs, and beforeRun/afterRun/verifyRun for --local runs. Only the boundaries are faked (TEST-007):
// Notion is a local HTTP server that answers from the recorded NOM-4 shapes and keeps what it is
// sent, and time is the faked Date. The board client is the real board() pointed at that server.
// The --local session is a stub that does to the working folder what a Notion MCP session would.

const fixture = (name: string): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(new URL(`./fixtures/board/${name}`, import.meta.url), 'utf8')))

const DS = 'b4e393d4-a4a6-46b8-bbd1-3d6c0f45a01e'
const PAGE = '3ec3e59b-2258-8102-becf-ce78d66142e1'
const PAGE_HEX = '3ec3e59b22588102becfce78d66142e1'
const URL_OF_TICKET = `https://www.notion.so/Explore-pagination-${PAGE_HEX}`
const TOKEN = 'test-token'
const UPLOAD_HOST = 'https://uploads.notion.test'

// The guidelines tree the knowledge walk reaches from KNOWLEDGE_PAGE: Engineering Central › AI-DLC › Feature Board.
const ROOT = '3e73e59b-2258-8032-b0c4-c2c10bd18cab'
const AIDLC = '3e83e59b-2258-817b-8658-f355337a4917'
const FEATURE_BOARD = '3e93e59b-2258-81bb-a552-f8e336ad08ad'
const KNOWLEDGE_PAGE = `https://app.notion.com/p/${ROOT.replaceAll('-', '')}`
const RULES_LISTING =
  '**BOARD-003 — MUST** put the spec and plan on the ticket as child pages named Spec and Plan, never as file attachments. One other write into the ticket page is allowed: every `/aspira-*` run on the ticket may append one run telemetry file block at the end of the page body, holding that run\'s telemetry file `<run-id>.json` (KIT-19).\n'
const RULES_WITHOUT = '**BOARD-003 — MUST** put the spec and plan on the ticket as child pages named Spec and Plan, never as file attachments.\n'
const link = (id: string, title: string) => `<page url="https://app.notion.com/p/${id.replaceAll('-', '')}">${title}</page>`

// Injected times: T0 is when the run starts; the expected nanosecond values are worked out by hand from them.
const T0 = '2026-10-15T09:00:00.000Z'
const T0_MS = 1792054800000
const T0_NS = '1792054800000000000'
const AT_5M = '2026-10-15T09:05:00.000Z'
const AT_5M_NS = '1792055100000000000'
const AT_6M = '2026-10-15T09:06:00.000Z'
const AT_6M_NS = '1792055160000000000'
const AT_20M = '2026-10-15T09:20:00.000Z'
const AT_20M_NS = '1792056000000000000'
const RUN_T0 = 'run-20261015T090000Z'

// ---------------------------------------------------------------------------------------------
// The mock Notion server.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>
type Call = { method: string; path: string; contentType: string; raw: string; body: Json | undefined }

const jsonRecord = z.record(z.string(), z.unknown())
const isRecord = (value: unknown): value is Json => jsonRecord.safeParse(value).success
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])

let server: Server
let api: string
let calls: Call[]
let status: string
/** Block children by parent id, as the server stored them. */
let blocks: Map<string, Json[]>
/** Child pages the server created, by id. */
let pages: Map<string, { id: string; url: string; title: string; lastEdited: string }>
/** Pages of the guidelines tree, answered on /pages/{id}/markdown. */
let markdownPages: Map<string, string>
let nextId: number
/** Every POST /v1/file_uploads/{id}/send answers 500. */
let failSend: boolean

const newId = () => `00000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`
const nowIso = () => new Date().toISOString()

function ticketPage(): Json {
  const base = z.looseObject({ properties: jsonRecord }).parse(fixture('nom-4.page.json'))
  return { ...base, properties: { ...base.properties, Status: { id: 'bEBnag', type: 'select', select: { name: status } } } }
}

function store(parent: string, children: Json[]): Json[] {
  const list = blocks.get(parent) ?? []
  blocks.set(parent, list)
  return children.map((child) => {
    const id = newId()
    const { children: nested, ...rest } = child
    const kids = records(nested)
    const saved: Json = { object: 'block', id, has_children: kids.length > 0, created_time: nowIso(), last_edited_time: nowIso(), ...rest }
    list.push(saved)
    if (kids.length > 0) store(id, kids)
    return saved
  })
}

function touchPage(id: string) {
  const page = pages.get(id)
  if (page !== undefined) pages.set(id, { ...page, lastEdited: nowIso() })
}

function listed(path: string, all: Json[]): { status: number; body: Json } {
  const cursor = new URL(path, 'http://mock').searchParams.get('start_cursor')
  const start = cursor === null ? 0 : Number(cursor)
  const end = start + 100
  return { status: 200, body: { object: 'list', results: all.slice(start, end), has_more: end < all.length, next_cursor: end < all.length ? String(end) : null } }
}

const asBlock = (json: Json): Block => ({ ...json, type: typeof json.type === 'string' ? json.type : 'unsupported' })

const titleOf = z.object({ properties: z.object({ title: z.object({ title: z.array(z.object({ text: z.object({ content: z.string() }) })) }) }) })
const parentOf = z.object({ parent: z.object({ page_id: z.string() }) })
const statusOf = z.object({ properties: z.object({ Status: z.object({ select: z.object({ name: z.string() }) }) }) })

function route(call: Call): { status: number; body: Json } {
  const { method, path, body } = call
  const json = (value: Json, code = 200) => ({ status: code, body: value })
  const missing = () => json({ object: 'error', status: 404, code: 'object_not_found', message: `no route for ${method} ${path}` }, 404)
  if (method === 'GET' && path === '/v1/users/me') return json({ object: 'user', id: 'bot-1', type: 'bot', bot: {} })
  if (method === 'GET' && path === `/v1/data_sources/${DS}`) return json(fixture('feature-board.data-source.json'))
  if (method === 'POST' && path === `/v1/data_sources/${DS}/query`) return json({ object: 'list', results: [ticketPage()], has_more: false, next_cursor: null })
  if (method === 'POST' && path === '/v1/file_uploads') {
    const id = newId()
    return json({ object: 'file_upload', id, status: 'pending', filename: body?.filename, content_type: body?.content_type, upload_url: `${UPLOAD_HOST}/${id}/send` })
  }
  const send = path.match(/^\/v1\/file_uploads\/([^/]+)\/send$/)
  if (method === 'POST' && send !== null) {
    if (failSend) return json({ object: 'error', status: 500, code: 'internal_server_error', message: 'send failed' }, 500)
    return json({ object: 'file_upload', id: send[1], status: 'uploaded', filename: 'telemetry.json', content_type: 'application/json' })
  }
  if (method === 'GET' && path === `/v1/pages/${PAGE}`) return json(ticketPage())
  if (method === 'PATCH' && path === `/v1/pages/${PAGE}`) {
    const next = statusOf.safeParse(body)
    if (next.success) status = next.data.properties.Status.select.name
    return json(ticketPage())
  }
  if (method === 'GET' && path === `/v1/pages/${PAGE}/markdown`) return json({ object: 'page_markdown', id: PAGE, markdown: '## Idea\nEvery list stops at 10.\n', truncated: false, unknown_block_ids: [] })
  const markdown = path.match(/^\/v1\/pages\/([^/]+)\/markdown$/)
  if (method === 'GET' && markdown !== null) {
    const id = markdown[1] ?? ''
    const guideline = markdownPages.get(id)
    if (guideline !== undefined) return json({ object: 'page_markdown', id, markdown: guideline, truncated: false, unknown_block_ids: [] })
    if (!pages.has(id)) return missing()
    return json({ object: 'page_markdown', id, markdown: blocksToMarkdown((blocks.get(id) ?? []).map(asBlock)), truncated: false, unknown_block_ids: [] })
  }
  const pageMatch = path.match(/^\/v1\/pages\/([^/]+)$/)
  const created = pageMatch === null ? undefined : pages.get(pageMatch[1] ?? '')
  if (method === 'GET' && created !== undefined) return json({ object: 'page', id: created.id, url: created.url, last_edited_time: created.lastEdited, properties: {} })
  if (method === 'POST' && path === '/v1/pages') {
    const parent = parentOf.parse(body).parent.page_id
    const title = titleOf.safeParse(body).data?.properties.title.title[0]?.text.content ?? ''
    const id = newId()
    const page = { id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, title, lastEdited: nowIso() }
    pages.set(id, page)
    store(id, records(body?.children))
    const list = blocks.get(parent) ?? []
    blocks.set(parent, [...list, { object: 'block', id, type: 'child_page', child_page: { title }, has_children: true, last_edited_time: page.lastEdited }])
    return json({ object: 'page', id, url: page.url, last_edited_time: page.lastEdited })
  }
  const children = path.match(/^\/v1\/blocks\/([^/?]+)\/children(?:\?.*)?$/)
  if (method === 'GET' && children !== null) return listed(path, blocks.get(children[1] ?? '') ?? [])
  if (method === 'PATCH' && children !== null) {
    const parent = children[1] ?? ''
    const results = store(parent, records(body?.children))
    touchPage(parent)
    return json({ object: 'list', results })
  }
  const single = path.match(/^\/v1\/blocks\/([^/]+)$/)
  if (method === 'DELETE' && single !== null) {
    for (const [parent, list] of blocks) {
      if (!list.some((block) => block.id === single[1])) continue
      blocks.set(
        parent,
        list.filter((block) => block.id !== single[1]),
      )
      touchPage(parent)
    }
    return json({ object: 'block', id: single[1], in_trash: true })
  }
  return missing()
}

async function readBody(request: IncomingMessage): Promise<{ raw: string; body: Json | undefined }> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString()
  if (raw === '' || !(request.headers['content-type'] ?? '').startsWith('application/json')) return { raw, body: undefined }
  return { raw, body: jsonRecord.parse(JSON.parse(raw)) }
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const { raw, body } = await readBody(request)
    const call: Call = { method: request.method ?? 'GET', path: request.url ?? '/', contentType: request.headers['content-type'] ?? '', raw, body }
    calls.push(call)
    const reply = (code: number, payload: Json) => {
      response.writeHead(code, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { object: 'error', status: 401, code: 'unauthorized', message: 'bad token' })
    const answer = route(call)
    reply(answer.status, answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the mock Notion server has no TCP address')
  api = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

// ---------------------------------------------------------------------------------------------
// The repository, the clock and the readers of what a run leaves behind.
// ---------------------------------------------------------------------------------------------

let repo: string

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'ticket-telemetry-')))
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: DS }))
  calls = []
  status = 'Ready: Idea'
  blocks = new Map()
  pages = new Map()
  markdownPages = new Map([
    [ROOT, `Engineering rules.\n${link(AIDLC, 'AI-DLC (AI Development Lifecycle)')}`],
    [AIDLC, `How work moves.\n${link(FEATURE_BOARD, 'Feature Board')}`],
    [FEATURE_BOARD, RULES_LISTING],
  ])
  nextId = 0
  failSend = false
  vi.stubEnv('KNOWLEDGE_PAGE', KNOWLEDGE_PAGE)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T0))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  const telemetry = join(folderOf(), 'telemetry')
  if (existsSync(telemetry)) await chmod(telemetry, 0o700)
  await rm(repo, { recursive: true, force: true })
})

const folderOf = () => join(repo, '.work', 'nom-4-explore-pagination')
const telemetryFiles = async (): Promise<string[]> => (existsSync(join(folderOf(), 'telemetry')) ? (await readdir(join(folderOf(), 'telemetry'))).toSorted() : [])
/** Every file under the repository whose path matches, relative to the repository. */
const filesUnder = async (pattern: RegExp): Promise<string[]> => (await readdir(repo, { recursive: true })).filter((file) => pattern.test(file)).toSorted()
const at = (iso: string) => vi.setSystemTime(new Date(iso))
/** A file's modification time set to the faked now, as a file written at that moment would have. */
const touch = async (file: string) => utimes(file, new Date(), new Date())
const writeAt = async (file: string, text: string) => {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, text)
  await touch(file)
}

const attributeSchema = z.object({ key: z.string(), value: jsonRecord })
const spanSchema = z.looseObject({ spanId: z.string(), parentSpanId: z.string().optional(), name: z.string(), startTimeUnixNano: z.string(), endTimeUnixNano: z.string(), attributes: z.array(attributeSchema).default([]) })
type Span = z.infer<typeof spanSchema>
const traceSchema = z.object({ resourceSpans: z.array(z.object({ resource: z.object({ attributes: z.array(attributeSchema) }), scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) })) })

/** A telemetry file as OTLP JSON: its resource attributes and every span. */
async function readTelemetry(runId: string) {
  const trace = traceSchema.parse(JSON.parse(await readFile(join(folderOf(), 'telemetry', `${runId}.json`), 'utf8')))
  const spans = trace.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
  const root = spans.find((span) => span.parentSpanId === undefined || span.parentSpanId === '')
  if (root === undefined) throw new Error(`${runId}.json has no root span`)
  return { resource: trace.resourceSpans.flatMap((resource) => resource.resource.attributes), spans, root, others: spans.filter((span) => span !== root) }
}

const stringAttribute = (span: Span, key: string): string | undefined => {
  const value = span.attributes.find((attribute) => attribute.key === key)?.value.stringValue
  return typeof value === 'string' ? value : undefined
}

/** Every string anywhere in a JSON value. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn)
  return []
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

// ---------------------------------------------------------------------------------------------
// The default/cloud seam: ticketCli start and finish, as the launchers run them.
// ---------------------------------------------------------------------------------------------

const ENV = { NOTION_TOKEN: TOKEN, KNOWLEDGE_PAGE }
/** A board client made after KNOWLEDGE_PAGE is set, against the mock server. */
const client = (): Board => board({ token: TOKEN, board: DS, api })

async function cli(skill: Skill, args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await ticketCli(skill, args, { out: (text) => out.push(text), err: (text) => err.push(text) }, ENV, client())
  return { code, out, err }
}

const valueOf = (lines: string[], key: string): string | undefined => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)

/** `ticket.ts start` at a time; the run id and start time it printed. */
async function handStart(skill: Skill, when: string, extra: string[] = []) {
  at(when)
  const result = await cli(skill, ['start', 'NOM-4', '--repo', repo, ...extra])
  return { ...result, runId: valueOf(result.out, 'run-id'), started: valueOf(result.out, 'run-started') }
}

type Started = Awaited<ReturnType<typeof handStart>>

/** `ticket.ts finish` at a time, carrying the run id and start time its start printed, as the launcher does. */
async function handFinish(skill: Skill, run: Started, when: string, fields: { runStatus: string; exportDir: string; extra?: string[] }) {
  if (run.runId === undefined || run.started === undefined) throw new Error(`start printed no run-id/run-started lines: ${[...run.out, ...run.err].join(' | ')}`)
  at(when)
  return cli(skill, ['finish', '--repo', repo, '--folder', folderOf(), '--ok', '--run-status', fields.runStatus, '--export', fields.exportDir, '--run-id', run.runId, '--run-started', run.started, ...(fields.extra ?? [])])
}

/** What a spec-writer run leaves in the folder: the spec it pushes and its usage ledger, written mid-run. */
async function seedSpecWriterExport(when: string): Promise<string> {
  const exportDir = join(folderOf(), 'spec.written')
  await writeFile(join(folderOf(), 'spec.md'), '## Intent\n\nPeople can reach every recipe.\n')
  const turn = (phase: string, n: number, input: number, output: number, cost: string) => ({
    phase,
    model: 'anthropic/claude-opus-5.5',
    turn: n,
    startedMs: n * 1000,
    durationMs: 30000,
    status: 'completed',
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    providerMetadata: { gateway: { cost } },
    text: 'the draft text',
    toolCalls: [{ toolName: 'read', args: { path: '/Users/someone/secret.ts' } }],
  })
  const ledger = join(exportDir, 'trace', 'usage.json')
  await mkdir(join(exportDir, 'trace'), { recursive: true })
  await writeFile(ledger, JSON.stringify({ scope: 'Direct writer and review calls only; excludes eve router.', turns: [turn('explore', 1, 1000, 200, '0.05'), turn('explore', 2, 800, 100, '0.04'), turn('draft', 3, 2000, 900, '0.11')] }))
  await utimes(ledger, new Date(when), new Date(when))
  return exportDir
}

const telemetryRequests = () => calls.filter((call) => (call.method === 'POST' && call.path.startsWith('/v1/file_uploads')) || (call.method === 'PATCH' && call.path === `/v1/blocks/${PAGE}/children`))
const uploads = () => calls.filter((call) => call.method === 'POST' && call.path === '/v1/file_uploads')
const appends = () => calls.filter((call) => call.method === 'PATCH' && call.path === `/v1/blocks/${PAGE}/children`)
const noticeOf = (lines: string[]) => lines.find((line) => line.startsWith('Telemetry not'))

describe('hand-run telemetry', () => {
  describe('T13 F1 F5 F19: a default/cloud hand run writes one file per run, from its start to its finish', () => {
    async function twoRuns() {
      const first = await handStart('spec-writer', T0)
      const second = await handStart('spec-writer', T0)
      const exportDir = await seedSpecWriterExport('2026-10-15T09:02:00.000Z')
      await handFinish('spec-writer', first, AT_5M, { runStatus: 'ready', exportDir })
      await handFinish('spec-writer', second, AT_6M, { runStatus: 'ready', exportDir })
      return { first, second }
    }

    it('each start prints a run-id and a run-started line, with distinct ids for two starts in the same second', async () => {
      const first = await handStart('spec-writer', T0)
      const second = await handStart('spec-writer', T0)
      expect({ ids: [first.runId, second.runId], started: [first.started, second.started].map((iso) => (iso === undefined ? null : Date.parse(iso))) }).toEqual({
        ids: [RUN_T0, `${RUN_T0}-1`],
        started: [T0_MS, T0_MS],
      })
    })

    it('each finish writes telemetry/<its run id>.json whose root runs from its start to its finish, with the ledger phases beneath it', async () => {
      const { first, second } = await twoRuns()
      const shapeOf = async (runId: string | undefined) => {
        const file = await readTelemetry(runId ?? 'none')
        return { root: file.root.name, start: file.root.startTimeUnixNano, end: file.root.endTimeUnixNano, phases: [...new Set(file.others.map((span) => span.name))].toSorted(), runIdInFile: file.resource.some((attribute) => attribute.value.stringValue === runId) }
      }
      expect([await shapeOf(first.runId), await shapeOf(second.runId)]).toEqual([
        { root: 'spec-writer', start: T0_NS, end: AT_5M_NS, phases: ['draft', 'explore'], runIdInFile: true },
        { root: 'spec-writer', start: T0_NS, end: AT_6M_NS, phases: ['draft', 'explore'], runIdInFile: true },
      ])
    })

    it('telemetry/ holds exactly the two runs\' files', async () => {
      await twoRuns()
      expect(await telemetryFiles()).toEqual([`${RUN_T0}-1.json`, `${RUN_T0}.json`])
    })
  })

  describe('T14 F14 F16: the attach under BOARD-003, deduplicated by run id, never failing the finish', () => {
    async function oneRun() {
      const run = await handStart('spec-writer', T0)
      const exportDir = await seedSpecWriterExport('2026-10-15T09:02:00.000Z')
      const finished = await handFinish('spec-writer', run, AT_5M, { runStatus: 'ready', exportDir })
      return { run, exportDir, finished, runId: run.runId ?? 'none' }
    }
    const fileBlockId = () => {
      const id = (blocks.get(PAGE) ?? []).find((block) => block.type === 'file')?.id
      return typeof id === 'string' ? id : undefined
    }

    it('with the listing it uploads once, appends one file block to the end of the ticket page and records the attach by run id', async () => {
      const { runId } = await oneRun()
      const appended = appends().map((call) => ({ types: records(call.body?.children).map((child) => child.type), positioned: call.body?.position !== undefined }))
      expect({ uploads: uploads().length, appended, record: await readJson(join(folderOf(), '.local', 'telemetry', 'attached', `${runId}.json`)).catch(() => null) }).toEqual({
        uploads: 1,
        appended: [{ types: ['file'], positioned: false }],
        record: { runId, blockId: fileBlockId() },
      })
    })

    it('a repeated finish of the same run makes no second upload or append', async () => {
      const { run, exportDir } = await oneRun()
      await handFinish('spec-writer', run, AT_6M, { runStatus: 'ready', exportDir })
      expect({ uploads: uploads().length, appends: appends().length }).toEqual({ uploads: 1, appends: 1 })
    })

    it('rules without the line: no upload, a "Telemetry not attached" line, and the file stays', async () => {
      markdownPages.set(FEATURE_BOARD, RULES_WITHOUT)
      const { finished, runId } = await oneRun()
      expect({ uploads: uploads().length, notice: noticeOf(finished.out)?.startsWith('Telemetry not attached') ?? false, file: existsSync(join(folderOf(), 'telemetry', `${runId}.json`)) }).toEqual({ uploads: 0, notice: true, file: true })
    })

    it('rules unreadable: no upload, a "Telemetry not attached" line, and the file stays', async () => {
      markdownPages.delete(FEATURE_BOARD)
      const { finished, runId } = await oneRun()
      expect({ uploads: uploads().length, notice: noticeOf(finished.out)?.startsWith('Telemetry not attached') ?? false, file: existsSync(join(folderOf(), 'telemetry', `${runId}.json`)) }).toEqual({ uploads: 0, notice: true, file: true })
    })

    it('a failed send is a notice naming the reason; the exit code is 0 and no Push failed line is printed', async () => {
      failSend = true
      const { finished } = await oneRun()
      expect({ code: finished.code, namesReason: noticeOf(finished.out)?.includes('500') ?? false, pushFailed: finished.out.some((line) => line.startsWith('Push failed')) }).toEqual({ code: 0, namesReason: true, pushFailed: false })
    })

    it('an attached record for the run with its block deleted by a human: nothing is uploaded or appended', async () => {
      const run = await handStart('spec-writer', T0)
      const runId = run.runId ?? 'none'
      await mkdir(join(folderOf(), '.local', 'telemetry', 'attached'), { recursive: true })
      await writeFile(join(folderOf(), '.local', 'telemetry', 'attached', `${runId}.json`), JSON.stringify({ runId, blockId: '00000000-0000-4000-8000-0000000deeed' }))
      const exportDir = await seedSpecWriterExport('2026-10-15T09:02:00.000Z')
      await handFinish('spec-writer', run, AT_5M, { runStatus: 'ready', exportDir })
      expect(telemetryRequests().map((call) => `${call.method} ${call.path}`)).toEqual([])
    })

    it('trace/board.json records the attach as the block id and the file name only', async () => {
      const { exportDir, runId } = await oneRun()
      const text = await readFile(join(exportDir, 'trace', 'board.json'), 'utf8')
      const trace = z.looseObject({ telemetry: z.unknown().optional() }).parse(JSON.parse(text))
      expect({ telemetry: trace.telemetry, uploadUrl: text.includes(UPLOAD_HOST) }).toEqual({ telemetry: { file: `${runId}.json`, blockId: fileBlockId() }, uploadUrl: false })
    })
  })

  describe('T15 F1: each groomer cloud round is its own run', () => {
    async function twoRounds() {
      status = 'Idea'
      const exportDir = join(folderOf(), 'groom')
      const ledger = async (when: string) => {
        await mkdir(join(exportDir, 'trace'), { recursive: true })
        const file = join(exportDir, 'trace', 'usage.json')
        await writeFile(file, JSON.stringify({ scope: 'Direct groomer calls only; excludes the eve router and the fact-finder subagent.', turns: [{ phase: 'round', model: 'anthropic/claude-opus-5.5', turn: 1, startedMs: 0, durationMs: 20000, status: 'completed', usage: { inputTokens: 500, outputTokens: 100 } }] }))
        await utimes(file, new Date(when), new Date(when))
      }
      const first = await handStart('groomer', T0)
      await ledger('2026-10-15T09:02:00.000Z')
      const one = await handFinish('groomer', first, AT_5M, { runStatus: 'needs-author', exportDir })
      const second = await handStart('groomer', '2026-10-15T09:10:00.000Z')
      await ledger('2026-10-15T09:12:00.000Z')
      const two = await handFinish('groomer', second, '2026-10-15T09:15:00.000Z', { runStatus: 'ready', exportDir })
      return { one, two }
    }

    it('finishGroom writes two telemetry files with distinct run ids, one per round', async () => {
      await twoRounds()
      expect(await telemetryFiles()).toEqual([`${RUN_T0}.json`, 'run-20261015T091000Z.json'])
    })

    it('the groomer\'s exit code and recorded run-status are as before', async () => {
      const { one, two } = await twoRounds()
      // As the finish records them without telemetry (KIT-2, Decision Q4): a ready reported with Confirm unticked is recorded needs-author, and needs-author exits NEEDS_AUTHOR_EXIT (5) either way.
      expect([one, two].map((round) => ({ code: round.code, runStatus: valueOf(round.out, 'run-status') }))).toEqual([
        { code: 5, runStatus: 'needs-author' },
        { code: 5, runStatus: 'needs-author' },
      ])
    })
  })

  describe('T16 F1: a refused run and a --no-ticket run write and reserve nothing', () => {
    it('start exits 3 on a Status the gate refuses', async () => {
      status = 'In Review: Plan'
      expect((await handStart('spec-writer', T0)).code).toBe(3)
    })

    it('after a refused start and a --no-ticket beforeRun there is no telemetry file, no .pending marker and no upload request', async () => {
      status = 'In Review: Plan'
      await handStart('spec-writer', T0)
      await beforeRun({ skill: 'planner', repo, env: {} }, { positional: '/tmp/spec.md', noTicket: true })
      expect({ files: await filesUnder(/(^|\/)telemetry\/|\.pending$/), uploads: uploads().length }).toEqual({ files: [], uploads: 0 })
    })
  })

  describe('T17 F6: --parent-run on the cloud seam', () => {
    const PARENT_RUN = 'run-20261015T085000Z'
    const NONCE = '5f0c2b8e-3d4a-4f6b-9a1c-7e2d8b9f0a13'
    const OTHER_NONCE = '0b7e6c1d-2a3f-4e5d-8c9b-1a2b3c4d5e6f'

    beforeEach(async () => {
      const record: TicketRecord = { id: 'NOM-4', title: 'Explore pagination', url: URL_OF_TICKET, status: 'Ready: Idea', type: 'Feature', priority: 'P0 - Critical', area: ['Discover'], idea: 'Every list stops at 10.\n', pulledAt: '2026-10-15T08:49:00.000Z', pages: {} }
      await mkdir(folderOf(), { recursive: true })
      await writeFile(join(folderOf(), TICKET_FILE), renderTicketMd(record))
      const state = {
        runs: [{ runId: PARENT_RUN, command: '/aspira-build-feature NOM-4', startedAt: '2026-10-15T08:50:00.000Z', endedAt: null, ended: null, mode: 'cloud' }],
        inProgress: { runId: PARENT_RUN, startedAt: '2026-10-15T08:50:00.000Z' },
        steps: [],
        pending: { kind: 'step', nonce: NONCE, output: join(folderOf(), '.local', 'build-feature', 'step-spec-writer.json'), stage: { stage: 'step', step: 'spec-writer' }, startedAt: '2026-10-15T08:55:00.000Z' },
      }
      await mkdir(join(folderOf(), '.local', 'build-feature'), { recursive: true })
      await writeFile(join(folderOf(), '.local', 'build-feature', 'state.json'), JSON.stringify(state, null, 2))
    })

    it('a fresh ticket with only the build-feature folder (no ticket.md yet) resolves into that folder instead of refusing (KIT-21)', async () => {
      // A build-feature run on a ticket nobody ran a skill on by hand: `.work/nom-4/` holds its state and no ticket.md.
      const fresh = join(repo, '.work', 'nom-4')
      await mkdir(join(fresh, '.local', 'build-feature'), { recursive: true })
      await writeFile(join(fresh, '.local', 'build-feature', 'state.json'), await readFile(join(folderOf(), '.local', 'build-feature', 'state.json'), 'utf8'))
      await rm(folderOf(), { recursive: true, force: true })
      const before = await beforeRun({ skill: 'spec-writer', repo, env: {} }, { positional: 'NOM-4', parentRun: `${PARENT_RUN}:${NONCE}` })
      expect({ kind: before.kind, folder: before.kind === 'stage' ? before.stage.folder : null }).toEqual({ kind: 'stage', folder: fresh })
    })

    it('the in-progress run\'s pending step prints no run-id line, writes no telemetry file and makes no upload', async () => {
      const run = await handStart('spec-writer', T0, ['--parent-run', `${PARENT_RUN}:${NONCE}`])
      const exportDir = await seedSpecWriterExport('2026-10-15T09:02:00.000Z')
      at(AT_5M)
      await cli('spec-writer', ['finish', '--repo', repo, '--folder', folderOf(), '--ok', '--run-status', 'ready', '--export', exportDir, '--parent-run', `${PARENT_RUN}:${NONCE}`])
      expect({ code: run.code, idLines: run.out.filter((line) => line.startsWith('run-id=') || line.startsWith('run-started=')), files: await telemetryFiles(), uploads: uploads().length }).toEqual({ code: 0, idLines: [], files: [], uploads: 0 })
    })

    it.each([
      ['malformed', 'bad'],
      ['naming another nonce', `${PARENT_RUN}:${OTHER_NONCE}`],
    ])('a %s value exits 3 naming --parent-run before any Notion request', async (_label, value) => {
      const run = await handStart('spec-writer', T0, ['--parent-run', value])
      expect({ code: run.code, names: run.err.some((line) => line.includes('--parent-run')), requests: calls.length }).toEqual({ code: 3, names: true, requests: 0 })
    })
  })

  // -------------------------------------------------------------------------------------------
  // The --local seams: beforeRun, afterRun and verifyRun, with a stub session doing the board work.
  // -------------------------------------------------------------------------------------------

  const ticketRecord = (fields: Partial<TicketRecord>): TicketRecord => ({ id: 'NOM-4', title: 'Explore pagination', url: URL_OF_TICKET, status: 'Ready: Spec', type: 'Feature', priority: 'P0 - Critical', area: ['Discover'], idea: 'Every list stops at 10.\n', pulledAt: nowIso(), pages: {}, ...fields })

  async function editTicket(change: (ticket: TicketRecord) => TicketRecord) {
    const ticket = await readTicketMd(folderOf())
    if (ticket === null) throw new Error('ticket.md is missing')
    await writeAt(join(folderOf(), TICKET_FILE), renderTicketMd(change(ticket)))
  }

  const field = (action: object, key: string): string | undefined => {
    const value: unknown = Reflect.get(action, key)
    return typeof value === 'string' ? value : undefined
  }

  /** The stub session: what a Notion MCP session does to the working folder for each listed action, at the faked now. */
  async function perform(actions: readonly object[], seed: { resolveAs: TicketRecord; rules?: string }) {
    for (const action of actions) {
      const kind = field(action, 'action') ?? field(action, 'op')
      const strings = stringsIn(action)
      const rulesFile = strings.find((value) => value.endsWith('board-rules.md'))
      if (rulesFile !== undefined) {
        await writeAt(rulesFile, seed.rules ?? RULES_LISTING)
        continue
      }
      if (kind === 'resolve') await writeAt(join(folderOf(), TICKET_FILE), renderTicketMd({ ...seed.resolveAs, pulledAt: nowIso() }))
      else if (kind === 'pull') await writeAt(field(action, 'file') ?? '', '## Intent\n\nPulled by the session.\n')
      else if (kind === 'set') await editTicket((ticket) => ({ ...ticket, dev: field(action, 'value') ?? '' }))
      else if (kind === 'move') await editTicket((ticket) => ({ ...ticket, status: field(action, 'to') ?? ticket.status }))
      else if (kind === 'push') {
        const title = field(action, 'title') ?? ''
        await editTicket((ticket) => ({ ...ticket, pages: { ...ticket.pages, [title]: { id: '00000000-0000-4000-8000-00000000a1a1', title, url: 'https://www.notion.so/000000000000400080000000000a1a1', lastEditedAt: nowIso() } } }))
      }
    }
  }

  /** The board stages up to the ticket, each performed by the stub session. */
  async function localReady(context: DriverContext, resolveAs: TicketRecord): Promise<BeforeRun & { kind: 'ticket' }> {
    for (let step = 0; step < 5; step += 1) {
      const next = await beforeRun(context, { positional: 'NOM-4' })
      if (next.kind === 'ticket') return next
      if (next.kind !== 'stage') throw new Error(`expected a board stage, got ${next.kind}`)
      await perform(next.stage.actions, { resolveAs })
    }
    throw new Error('the board stage never reached the ticket')
  }

  describe('T18 F5 F9 F12 F14 F16: a --local planner run', () => {
    const planner: DriverContext = { skill: 'planner', repo: '', env: {} }
    const ctx = (): DriverContext => ({ ...planner, repo })
    const exportOf = () => join(folderOf(), 'plan.review')
    const reportOf = () => join(exportOf(), 'trace', 'session-usage.json')
    const resolveAs = () => ticketRecord({ status: 'Ready: Spec', pages: { 'Spec Reviewed': { id: '3ec3e59b-2258-8123-961c-ce4ccd8e662a', title: 'Spec Reviewed', url: 'https://www.notion.so/3ec3e59b22588123961cce4ccd8e662a', lastEditedAt: '2026-10-14T10:00:00.000Z' } } })

    /** beforeRun to the ticket at T0, the export with an empty ledger and (unless left out) the session usage report, then afterRun at T0+20m. */
    async function plannerRun(options: { report: boolean } = { report: true }) {
      const ready = await localReady(ctx(), resolveAs())
      await mkdir(join(exportOf(), 'trace'), { recursive: true })
      await writeFile(join(exportOf(), 'plan.reviewed.md'), '# Plan\n')
      await writeFile(join(exportOf(), 'trace', 'usage.json'), JSON.stringify({ scope: 'Direct planner calls only; excludes eve routing and guideline loading before entry.', turns: [] }))
      if (options.report) {
        await writeFile(
          reportOf(),
          JSON.stringify({
            runId: RUN_T0,
            subagents: [
              { label: 'research', startedAt: '2026-10-15T09:01:00.000Z', endedAt: '2026-10-15T09:06:00.000Z', totalTokens: 41000, toolUses: 12, wallMs: 300000, model: 'claude-opus-5-5' },
              { label: 'synthesis', startedAt: '2026-10-15T09:07:00.000Z', endedAt: '2026-10-15T09:15:00.000Z', totalTokens: 22000, toolUses: 0, wallMs: 480000 },
            ],
          }),
        )
      }
      at(AT_20M)
      const run = { status: 'ready' as const, exportDir: exportOf(), verifyCommand: 'planner.sh local NOM-4 --verify', sessionUsage: reportOf() }
      const end = await afterRun(ctx(), ready, run)
      return { ready, end }
    }

    /** The session performs the end stage, then calls --verify with its attach result. */
    async function verifyWith(end: Awaited<ReturnType<typeof plannerRun>>['end'], attach: { blockId: string } | { error: string }) {
      await perform(end.board.actions, { resolveAs: resolveAs() })
      const args = { positional: 'NOM-4', attach }
      return verifyRun(ctx(), args, exportOf)
    }

    it('board.json holds the run id and start time beforeRun reserved, and the file is named by that id', async () => {
      const ready = await localReady(ctx(), resolveAs())
      const persisted = stringsIn(await readJson(join(folderOf(), '.local', 'planner', 'board.json')))
      await mkdir(exportOf(), { recursive: true })
      await writeFile(join(exportOf(), 'plan.reviewed.md'), '# Plan\n')
      at(AT_20M)
      const run = { status: 'ready' as const, exportDir: exportOf(), verifyCommand: 'planner.sh local NOM-4 --verify', sessionUsage: reportOf() }
      await afterRun(ctx(), ready, run)
      expect({ id: persisted.includes(RUN_T0), start: persisted.some((value) => Date.parse(value) === T0_MS), files: await telemetryFiles() }).toEqual({ id: true, start: true, files: [`${RUN_T0}.json`] })
    })

    it('the root ends at the afterRun time with one span per reported subagent and no empty-ledger gap', async () => {
      await plannerRun()
      const file = await readTelemetry(RUN_T0)
      expect({ root: file.root.name, end: file.root.endTimeUnixNano, subagents: file.others.length, gaps: file.spans.flatMap((span) => stringAttribute(span, 'aspira.gap') ?? []) }).toEqual({ root: 'planner', end: AT_20M_NS, subagents: 2, gaps: [] })
    })

    it('without a session usage report the file carries aspira.gap=missing', async () => {
      await plannerRun({ report: false })
      const file = await readTelemetry(RUN_T0)
      expect(file.spans.some((span) => stringAttribute(span, 'aspira.gap') === 'missing')).toBe(true)
    })

    it('board.actions reads the board rules before the attach naming the ticket page and telemetry/<run-id>.json', async () => {
      const { end } = await plannerRun()
      const actions: readonly object[] = end.board.actions
      const read = actions.findIndex((action) => stringsIn(action).some((value) => value.includes('board-rules')))
      const attach = actions.findIndex((action) => {
        const values = stringsIn(action)
        return values.includes('attach') && values.some((value) => value.replaceAll('-', '').includes(PAGE_HEX)) && values.some((value) => value.endsWith(`telemetry/${RUN_T0}.json`))
      })
      expect({ read: read >= 0, attachAfterRead: attach > read }).toEqual({ read: true, attachAfterRead: true })
    })

    it('verify records trace.telemetry as the file name and the block id', async () => {
      const { end } = await plannerRun()
      await verifyWith(end, { blockId: '00000000-0000-4000-8000-0000000b10c1' })
      const trace = z.looseObject({ telemetry: z.unknown().optional() }).parse(await readJson(join(exportOf(), 'trace', 'board.json')))
      expect(trace.telemetry).toEqual({ file: `${RUN_T0}.json`, blockId: '00000000-0000-4000-8000-0000000b10c1' })
    })

    it('a failed attach is a "Telemetry not attached" notice; the run is verified with no problem', async () => {
      const { end } = await plannerRun()
      const verified = await verifyWith(end, { error: 'notion-create-attachment answered 500' })
      expect({ verified: verified.verified, problem: verified.problem, notice: JSON.stringify(verified).includes('Telemetry not attached') }).toEqual({ verified: true, problem: undefined, notice: true })
    })

    it('a second verify leaves the telemetry file byte-identical', async () => {
      const { end } = await plannerRun()
      const written = await readFile(join(folderOf(), 'telemetry', `${RUN_T0}.json`))
      await verifyWith(end, { blockId: '00000000-0000-4000-8000-0000000b10c1' })
      at('2026-10-15T09:30:00.000Z')
      await verifyRun(ctx(), { positional: 'NOM-4' }, exportOf)
      expect(Buffer.compare(await readFile(join(folderOf(), 'telemetry', `${RUN_T0}.json`)), written)).toBe(0)
    })
  })

  describe('T19 F13: --local groomer rounds', () => {
    const ctx = (): DriverContext => ({ skill: 'groomer', repo, env: {} })
    const exportOf = () => join(folderOf(), 'groom')
    const resolveAs = () => ticketRecord({ status: 'Grooming', type: 'Feature' })

    async function round(n: number, when: string) {
      await mkdir(join(exportOf(), 'trace'), { recursive: true })
      await writeFile(join(exportOf(), 'trace', 'decisions.md'), `# Grooming Decisions\n\nRound ${n}.\n`)
      at(when)
      const ready = await localReady(ctx(), resolveAs())
      const run = { status: 'needs-author' as const, exportDir: exportOf(), verifyCommand: 'groomer.sh local NOM-4 --verify', round: n, sessionUsage: join(exportOf(), 'trace', 'session-usage.json') }
      return { ready, run }
    }

    it('re-entering beforeRun keeps the run id it reserved', async () => {
      await localReady(ctx(), resolveAs())
      at('2026-10-15T09:01:00.000Z')
      await beforeRun(ctx(), { positional: 'NOM-4' })
      const persisted = stringsIn(await readJson(join(folderOf(), '.local', 'groomer', 'board.json')))
      expect({ kept: persisted.includes(RUN_T0), replaced: persisted.includes('run-20261015T090100Z') }).toEqual({ kept: true, replaced: false })
    })

    it('round 1 and round 2 write two files with distinct run ids', async () => {
      const first = await round(1, T0)
      at(AT_5M)
      await afterRun(ctx(), first.ready, first.run)
      const second = await round(2, '2026-10-15T09:10:00.000Z')
      at('2026-10-15T09:15:00.000Z')
      await afterRun(ctx(), second.ready, second.run)
      expect(await telemetryFiles()).toEqual([`${RUN_T0}.json`, 'run-20261015T091000Z.json'])
    })
  })

  describe('T20 F16: a telemetry write that fails changes nothing else', () => {
    it('the exit code and printed run status are those of a run whose write succeeds', async () => {
      const run = await handStart('spec-writer', T0)
      const exportDir = await seedSpecWriterExport('2026-10-15T09:02:00.000Z')
      await mkdir(join(folderOf(), 'telemetry'), { recursive: true })
      await chmod(join(folderOf(), 'telemetry'), 0o500)
      const finished = await handFinish('spec-writer', run, AT_5M, { runStatus: 'ready', exportDir })
      expect({ code: finished.code, status: finished.out.find((line) => line.startsWith('Status: ')) }).toEqual({ code: 0, status: 'Status: In Progress: Spec -> In Review: Spec' })
    })

    it('a "Telemetry not" line gives the reason', async () => {
      const run = await handStart('spec-writer', T0)
      const exportDir = await seedSpecWriterExport('2026-10-15T09:02:00.000Z')
      await mkdir(join(folderOf(), 'telemetry'), { recursive: true })
      await chmod(join(folderOf(), 'telemetry'), 0o500)
      const finished = await handFinish('spec-writer', run, AT_5M, { runStatus: 'ready', exportDir })
      expect(noticeOf(finished.out)).toMatch(/^Telemetry not \w+: .*(EACCES|permission denied)/i)
    })
  })
})
