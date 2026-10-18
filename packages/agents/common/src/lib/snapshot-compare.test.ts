// T55 (F41): knowledge-snapshot.ts (compareSnapshot) does not exist yet (P26). This file is its
// compare contract: compareSnapshot(text, { token, api, fetch }) parses the provenance header off
// `text` (REQUIRED.md as the command writes it; see knowledge-walk.test.ts and
// knowledge-provenance.test.ts) and refetches every listed page's raw markdown, comparing its
// sha256 to the recorded markdownHash.
//
// Returns { comparable: true, changed: Page[], notCompared: NotComparedPage[], message } when at
// least one page could be refetched: `changed` and `notCompared` (each `{id, title, url}`, the
// latter carrying `reason`) list every page in the corresponding state, and `message` always
// names both counts ("N changed, M not compared (<titles>)") — a zero changed count is never
// reported on its own when pages were not compared, so a caller cannot mistake "nothing changed"
// for "nothing could be checked".
//
// Returns { comparable: false, reason } when not one single page could be reached (every request
// failed the same way Notion being down would): the comparison was not made at all, which reads
// differently from some pages individually 404/500ing while others still compare.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadKnowledgeCommand } from './knowledge-walk'
import { compareSnapshot } from './knowledge-snapshot'

const TOKEN = 'test-token'

/** A 32-hex Notion page id, dashed the way pageIdFrom expects, distinct per `n`. */
function fakeId(n: number): string {
  const hex = `ffff${n.toString(16).padStart(28, '0')}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const urlFor = (id: string, title: string) => `https://www.notion.so/${title.replace(/[^a-zA-Z0-9]+/g, '-')}-${id.replace(/-/g, '')}`

type PageDef = { title: string; markdown: string; status?: number }

/** A minimal Notion server: GET /v1/pages/{id} (title only) and GET /v1/pages/{id}/markdown, from `pages`. Mutating the map between calls changes what the next fetch sees. */
async function notionServer(pages: Map<string, PageDef>): Promise<{ api: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const json = (code: number, body: unknown) => {
      response.writeHead(code, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const match = request.url?.match(/^\/v1\/pages\/([^/]+)(\/markdown)?$/)
    const id = match?.[1]
    const def = id === undefined ? undefined : pages.get(id)
    if (def === undefined) return json(404, { object: 'error', status: 404, message: `no page ${id}` })
    if (def.status !== undefined && def.status !== 200) return json(def.status, { object: 'error', status: def.status, message: `page ${id} failed` })
    if (match?.[2] === '/markdown') return json(200, { markdown: def.markdown, truncated: false })
    return json(200, { properties: { title: { id: 'title', type: 'title', title: [{ plain_text: def.title }] } } })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { api, close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))) }
}

const ROOT = fakeId(0)
const AGENT_INSTRUCTIONS = fakeId(1)
const REVIEW_VERIFICATION = fakeId(2)
const TOPIC_A = fakeId(3)
const REQUIRED = ['Agent Instructions', 'Review Verification']

function tag(id: string, title: string): string {
  return `<page url="${urlFor(id, title)}">${title}</page>`
}

function basicTree(): Map<string, PageDef> {
  const pages = new Map<string, PageDef>()
  pages.set(ROOT, { title: 'Engineering', markdown: `# Engineering\n\n${tag(AGENT_INSTRUCTIONS, 'Agent Instructions')}\n${tag(REVIEW_VERIFICATION, 'Review Verification')}\n${tag(TOPIC_A, 'Topic A')}\n` })
  pages.set(AGENT_INSTRUCTIONS, { title: 'Agent Instructions', markdown: '**TS-004 — MUST** validate external data.' })
  pages.set(REVIEW_VERIFICATION, { title: 'Review Verification', markdown: '**REV-001 — MUST** read AGENTS.md.' })
  pages.set(TOPIC_A, { title: 'Topic A', markdown: 'Some notes on Topic A.' })
  return pages
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Writes REQUIRED.md through the real command against `pages`, and returns its text plus the server's close/api so a case can mutate `pages` before comparing. */
async function writtenSnapshot(pages: Map<string, PageDef>): Promise<{ text: string; api: string; close: () => Promise<void> }> {
  const { api, close } = await notionServer(pages)
  const repo = await tempDir('sc-repo-')
  const out = join(repo, 'knowledge')
  const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
  expect(result.code).toBe(0)
  const text = await readFile(join(out, 'REQUIRED.md'), 'utf8')
  return { text, api, close }
}

describe('compareSnapshot against an unchanged tree', () => {
  it('reports 0 changed and 0 not compared', async () => {
    const pages = basicTree()
    const { text, api, close } = await writtenSnapshot(pages)
    cleanups.push(close)

    const result = await compareSnapshot(text, { token: TOKEN, api })

    expect(result).toMatchObject({ comparable: true, changed: [], notCompared: [] })
  })
})

describe('compareSnapshot against one changed page', () => {
  it('reports 1 changed', async () => {
    const pages = basicTree()
    const { text, api, close } = await writtenSnapshot(pages)
    cleanups.push(close)
    pages.set(TOPIC_A, { ...pages.get(TOPIC_A)!, markdown: 'Some notes on Topic A, now revised.' })

    const result = await compareSnapshot(text, { token: TOKEN, api })

    expect(result.comparable).toBe(true)
    if (!result.comparable) throw new Error('unreachable')
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.title).toBe('Topic A')
    expect(result.notCompared).toHaveLength(0)
  })
})

describe('compareSnapshot when one page 404s and another 500s', () => {
  it('reports "N changed, M not compared" naming the pages, even when N is 0', async () => {
    const pages = basicTree()
    const { text, api, close } = await writtenSnapshot(pages)
    cleanups.push(close)
    pages.set(AGENT_INSTRUCTIONS, { ...pages.get(AGENT_INSTRUCTIONS)!, status: 404 })
    pages.set(TOPIC_A, { ...pages.get(TOPIC_A)!, status: 500 })

    const result = await compareSnapshot(text, { token: TOKEN, api })

    expect(result.comparable).toBe(true)
    if (!result.comparable) throw new Error('unreachable')
    expect(result.changed).toHaveLength(0)
    expect(result.notCompared.map((p: { title: string }) => p.title).sort()).toEqual(['Agent Instructions', 'Topic A'])
    expect(result.message).toContain('0 changed')
    expect(result.message).toContain('2 not compared')
    expect(result.message).toContain('Agent Instructions')
    expect(result.message).toContain('Topic A')
  })
})

describe('compareSnapshot when Notion cannot be reached at all', () => {
  it('reports that the comparison was not made, distinctly from a partial failure', async () => {
    const pages = basicTree()
    const { text, api, close } = await writtenSnapshot(pages)
    await close()

    const result = await compareSnapshot(text, { token: TOKEN, api })

    expect(result.comparable).toBe(false)
    if (result.comparable) throw new Error('unreachable')
    expect(result.reason.toLowerCase()).toMatch(/not (made|reached|compared)/)
  })
})
