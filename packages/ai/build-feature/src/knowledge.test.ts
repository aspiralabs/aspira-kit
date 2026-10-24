// KIT-48: the engineering guidelines are built once per ticket by build-feature and verified against
// Notion before every later step; a changed page rebuilds the whole folder; without a token or an
// index page nothing is built and the step loads its own.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureKnowledge, knowledgeFlag, knowledgeRecordOf } from '#build-feature/knowledge.ts'
import { emptyRunState } from '#build-feature/run-state.ts'

type PageDef = { title: string; markdown: string }
const fakeId = (n: number) => `${'0'.repeat(31)}${n}`.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
const ROOT = fakeId(0)
const AGENT_INSTRUCTIONS = fakeId(1)
const REVIEW_VERIFICATION = fakeId(2)
const urlFor = (id: string) => `https://www.notion.so/${id.replaceAll('-', '')}`
const tag = (id: string, title: string) => `<page url="${urlFor(id)}">${title}</page>`

function tree(): Map<string, PageDef> {
  const pages = new Map<string, PageDef>()
  pages.set(ROOT, { title: 'Engineering', markdown: `# Engineering\n\n${tag(AGENT_INSTRUCTIONS, 'Agent Instructions')}\n${tag(REVIEW_VERIFICATION, 'Review Verification')}\n` })
  pages.set(AGENT_INSTRUCTIONS, { title: 'Agent Instructions', markdown: '**TS-004 — MUST** validate external data.' })
  pages.set(REVIEW_VERIFICATION, { title: 'Review Verification', markdown: '**REV-001 — MUST** read AGENTS.md.' })
  return pages
}

async function notionServer(pages: Map<string, PageDef>): Promise<{ api: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '')
    const json = (code: number, body: unknown) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
    const match = request.url?.match(/^\/v1\/pages\/([^/]+)(\/markdown)?$/)
    const def = match?.[1] === undefined ? undefined : pages.get(match[1])
    if (def === undefined) return json(404, { object: 'error', status: 404, message: 'no page' })
    if (match?.[2] === '/markdown') return json(200, { markdown: def.markdown, truncated: false })
    return json(200, { properties: { title: { id: 'title', type: 'title', title: [{ plain_text: def.title }] } } })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, hits, close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))) }
}

// Tests in this package run concurrently, so each test owns and closes its own server and temp dir.
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'build-feature-knowledge-'))
  const pages = tree()
  const server = await notionServer(pages)
  const close = async () => { await server.close(); await rm(dir, { recursive: true, force: true }) }
  const env = { NOTION_TOKEN: 'secret', KNOWLEDGE_PAGE: urlFor(ROOT), KNOWLEDGE_REQUIRED: 'Agent Instructions, Review Verification' }
  const folder = join(dir, '.work', 'kit-48-x')
  return { dir, pages, server, env, folder, close, input: { env, repo: dir, folder, now: '2026-10-21T00:00:00.000Z', api: server.api } }
}

describe('ensureKnowledge', () => {
  it('builds the folder on the first step, reuses it unchanged on the next, and rebuilds it whole when a page changed', async () => {
    const { pages, server, folder, input, close } = await setup()
    try {
    const first = await ensureKnowledge(emptyRunState(), input)
    expect(first.note).toBeNull()
    expect(first.knowledge).toEqual({ dir: join(folder, 'knowledge'), requiredFile: join(folder, 'knowledge', 'REQUIRED.md') })
    expect(await readFile(join(folder, 'knowledge', 'REQUIRED.md'), 'utf8')).toContain('TS-004')
    expect(knowledgeRecordOf(first.state)).toMatchObject({ dir: join(folder, 'knowledge'), pages: 3, rebuilds: 0 })
    server.hits.length = 0
    const second = await ensureKnowledge(first.state, { ...input, now: '2026-10-21T01:00:00.000Z' })
    expect(second.knowledge).toEqual(first.knowledge)
    expect(knowledgeRecordOf(second.state)).toMatchObject({ builtAt: '2026-10-21T00:00:00.000Z', verifiedAt: '2026-10-21T01:00:00.000Z', rebuilds: 0 })
    // The check fetched each page's markdown once and wrote nothing new.
    expect(server.hits.every((hit) => hit.endsWith('/markdown'))).toBe(true)
    pages.set(AGENT_INSTRUCTIONS, { title: 'Agent Instructions', markdown: '**TS-004 — MUST** validate external data.\n\n**TS-009 — MUST** name the boundary.' })
    const third = await ensureKnowledge(second.state, { ...input, now: '2026-10-21T02:00:00.000Z' })
    expect(third.knowledge).toEqual(first.knowledge)
    expect(await readFile(join(folder, 'knowledge', 'REQUIRED.md'), 'utf8')).toContain('TS-009')
    expect(knowledgeRecordOf(third.state)).toMatchObject({ builtAt: '2026-10-21T02:00:00.000Z', rebuilds: 1 })
    } finally { await close() }
  })

  it('builds nothing without a token or an index page, and lets the step load its own', async () => {
    const { input, close } = await setup()
    try {
      expect(await ensureKnowledge(emptyRunState(), { ...input, env: { KNOWLEDGE_PAGE: input.env.KNOWLEDGE_PAGE } })).toMatchObject({ knowledge: null, note: null })
      expect(await ensureKnowledge(emptyRunState(), { ...input, env: { NOTION_TOKEN: 'secret' } })).toMatchObject({ knowledge: null, note: null })
    } finally { await close() }
  })

  it("takes the index page from aspira.json's knowledge when the environment names none (NOM-38)", async () => {
    const { folder, input, close } = await setup()
    try {
      const built = await ensureKnowledge(emptyRunState(), { ...input, env: { NOTION_TOKEN: 'secret', KNOWLEDGE_REQUIRED: input.env.KNOWLEDGE_REQUIRED }, page: input.env.KNOWLEDGE_PAGE })
      expect(built.knowledge).toEqual({ dir: join(folder, 'knowledge'), requiredFile: join(folder, 'knowledge', 'REQUIRED.md') })
    } finally { await close() }
  })

  it('names the flag each step takes the folder through', () => {
    const shared = { dir: '/w/.work/kit-48-x/knowledge', requiredFile: '/w/.work/kit-48-x/knowledge/REQUIRED.md' }
    expect(knowledgeFlag('spec-writer', shared)).toBe('--guidelines /w/.work/kit-48-x/knowledge/REQUIRED.md')
    expect(knowledgeFlag('planner', shared)).toBe('--guidelines /w/.work/kit-48-x/knowledge/REQUIRED.md')
    expect(knowledgeFlag('code-analyzer', shared)).toBe('--knowledge /w/.work/kit-48-x/knowledge')
    expect(knowledgeFlag('pr-reviewer', shared)).toBe('--knowledge /w/.work/kit-48-x/knowledge')
  })
})
