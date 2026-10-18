// T57 (F50): knowledge-snapshot.ts (verifySnapshot, verifyKnowledgeDir) does not exist yet (P26).
// This file is their verify contract: a snapshot is trusted only when it sits exactly where it
// was written, carries an intact header whose per-page hashes match the file's current content,
// and names the root the run is configured for — anything else is refused, naming what failed,
// with a hint pointing at the load-knowledge command to run instead of trusting a stale copy.
//
// verifySnapshot(path, { expectedRootId }) reads `path`, requires a parseable provenance header
// (knowledge-snapshot's renderProvenance/parseProvenance — see knowledge-provenance.test.ts) whose
// recorded `path` equals the argument (refused otherwise: the file was moved), that is not under
// any path segment named `trace` (refused: a trace/ copy is a historical record, never a live
// snapshot to trust), whose `rootId` equals `expectedRootId` (refused otherwise, naming both ids),
// and whose every page's recorded sectionHash matches a sha256 of that page's current section text
// (refused otherwise, naming the page). Returns { ok: true, message } on success — `message` says
// the snapshot is unverified against Notion unless a caller also runs compareSnapshot — or
// { ok: false, reason, hint } with `hint` naming the load-knowledge command to run instead.
//
// verifyKnowledgeDir(dir, { expectedRootId }) is the same check against `join(dir, 'REQUIRED.md')`.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadKnowledgeCommand } from './knowledge-walk'
import { verifyKnowledgeDir, verifySnapshot } from './knowledge-snapshot'

const TOKEN = 'test-token'

/** A 32-hex Notion page id, dashed the way pageIdFrom expects, distinct per `n`. */
function fakeId(n: number): string {
  const hex = `ccdd${n.toString(16).padStart(28, '0')}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const urlFor = (id: string, title: string) => `https://www.notion.so/${title.replace(/[^a-zA-Z0-9]+/g, '-')}-${id.replace(/-/g, '')}`

type PageDef = { title: string; markdown: string }

/** A minimal Notion server: GET /v1/pages/{id} (title only) and GET /v1/pages/{id}/markdown, from `pages`. */
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
    if (match?.[2] === '/markdown') return json(200, { markdown: def.markdown, truncated: false })
    return json(200, { properties: { title: { id: 'title', type: 'title', title: [{ plain_text: def.title }] } } })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { api, close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))) }
}

// KNOWLEDGE_PAGE set to the default "Agent Instructions" page itself (the tree's root/index page
// is the first required page, as a small org's guidelines tree might genuinely be shaped).
const ROOT = fakeId(0)
const OTHER_ROOT = fakeId(66)
const REVIEW_VERIFICATION = fakeId(1)
const REQUIRED = ['Agent Instructions', 'Review Verification']
const AGENT_INSTRUCTIONS_MARKDOWN = '**TS-004 — MUST** validate external data.'

function tag(id: string, title: string): string {
  return `<page url="${urlFor(id, title)}">${title}</page>`
}

function tree(): Map<string, PageDef> {
  const pages = new Map<string, PageDef>()
  pages.set(ROOT, { title: 'Agent Instructions', markdown: `# Agent Instructions\n\n${AGENT_INSTRUCTIONS_MARKDOWN}\n\n${tag(REVIEW_VERIFICATION, 'Review Verification')}\n` })
  pages.set(REVIEW_VERIFICATION, { title: 'Review Verification', markdown: '**REV-001 — MUST** read AGENTS.md.' })
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

/** Writes a fresh, valid snapshot at `out` (default `<repo>/knowledge`) through the real command, and returns its REQUIRED.md path and text. */
async function writtenAt(out?: string): Promise<{ path: string; text: string }> {
  const { api, close } = await notionServer(tree())
  cleanups.push(close)
  const repo = await tempDir('gv-repo-')
  const dir = out ?? join(repo, 'knowledge')
  const result = await loadKnowledgeCommand(['--out', dir], { token: TOKEN, api, page: urlFor(ROOT, 'Agent Instructions'), required: REQUIRED })
  expect(result.code).toBe(0)
  const path = join(dir, 'REQUIRED.md')
  return { path, text: await readFile(path, 'utf8') }
}

describe('verifySnapshot on an untouched, just-written file', () => {
  it('passes, and says it is unverified against Notion unless compared', async () => {
    const { path } = await writtenAt()

    const result = await verifySnapshot(path, { expectedRootId: ROOT })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.message.toLowerCase()).toContain('notion')
    expect(result.message.toLowerCase()).toMatch(/compar|verif/)
  })
})

describe('verifySnapshot on an edited section', () => {
  it('refuses, naming the edited page, and hints the load-knowledge command', async () => {
    const { path, text } = await writtenAt()
    expect(text).toContain(AGENT_INSTRUCTIONS_MARKDOWN)
    await writeFile(path, text.replace(AGENT_INSTRUCTIONS_MARKDOWN, 'TS-004 has been rewritten by hand.'))

    const result = await verifySnapshot(path, { expectedRootId: ROOT })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('Agent Instructions')
    expect(result.hint).toContain('load-knowledge')
  })
})

describe('verifySnapshot on a copy moved to another path', () => {
  it('refuses the moved copy and hints the load-knowledge command', async () => {
    const { text } = await writtenAt()
    const elsewhere = join(await tempDir('gv-moved-'), 'REQUIRED.md')
    await writeFile(elsewhere, text)

    const result = await verifySnapshot(elsewhere, { expectedRootId: ROOT })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.hint).toContain('load-knowledge')
  })
})

describe('verifySnapshot on a copy under a trace/ folder', () => {
  it('refuses even a copy written exactly where its own header says, naming the trace folder', async () => {
    const repo = await tempDir('gv-trace-repo-')
    const { path } = await writtenAt(join(repo, 'spec.reviewed', 'trace', 'knowledge'))

    const result = await verifySnapshot(path, { expectedRootId: ROOT })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason.toLowerCase()).toContain('trace')
    expect(result.hint).toContain('load-knowledge')
  })
})

describe('verifySnapshot on a file with its header stripped', () => {
  it('refuses, and hints the load-knowledge command', async () => {
    const path = join(await tempDir('gv-noheader-'), 'REQUIRED.md')
    await writeFile(path, '# Not a real snapshot\n\nNo header here.\n')

    const result = await verifySnapshot(path, { expectedRootId: ROOT })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.hint).toContain('load-knowledge')
  })
})

describe('verifySnapshot against a header naming another root page', () => {
  it('refuses, naming both the expected and the recorded root id', async () => {
    const { path, text } = await writtenAt()
    // Only the id strings change; every hash stays valid for its (untouched) section, so this
    // isolates the root-id check from the section-hash check.
    await writeFile(path, text.replaceAll(ROOT, OTHER_ROOT))

    const result = await verifySnapshot(path, { expectedRootId: ROOT })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain(ROOT)
    expect(result.reason).toContain(OTHER_ROOT)
    expect(result.hint).toContain('load-knowledge')
  })
})

describe('verifyKnowledgeDir', () => {
  it('passes for a freshly written folder and refuses once its REQUIRED.md is edited', async () => {
    const { path, text } = await writtenAt()
    const dir = dirname(path)

    const clean = await verifyKnowledgeDir(dir, { expectedRootId: ROOT })
    expect(clean.ok).toBe(true)

    await writeFile(path, text.replace(AGENT_INSTRUCTIONS_MARKDOWN, 'edited by hand'))
    const dirty = await verifyKnowledgeDir(dir, { expectedRootId: ROOT })
    expect(dirty.ok).toBe(false)
    if (dirty.ok) throw new Error('unreachable')
    expect(dirty.hint).toContain('load-knowledge')
  })
})
