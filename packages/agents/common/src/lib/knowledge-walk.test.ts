// T53 (F45, F46, F47): knowledge-walk.ts does not exist yet (P26). This file is its contract.
//
// walkKnowledge({ token, page, required, fetch, api }) does the one breadth-first walk (depth
// MAX_DEPTH, MAX_PAGES pages, from ./knowledge.ts) and returns a WalkResult: `pages` (every page
// fetched, in visit order, each `{ id, title, url, file, markdown, notionMarkdown, truncated }`
// where `file` is the basename the page would be written under — INDEX.md for the root — and
// `markdown` has local links rewritten while `notionMarkdown` keeps the raw Notion markdown, for
// hashing), `required` (the resolved required pages, in requested order) and `notLoaded` (pages
// the walk knows about but did not reach because MAX_PAGES was hit, `{ title, url }`). A fetch
// error, a 404/403, or a truncated page makes the whole walk throw, naming the page. A required
// page that stays unreached (cap or otherwise) makes it throw too, naming the page.
//
// writeKnowledgeFolder(out, walk, opts?) writes `pages` (one file each) and, when `required` is
// non-empty, REQUIRED.md with the provenance header, into `out`: through a temporary sibling
// directory renamed into place, so a reader never sees a half-written folder. `opts.cwd` and
// `opts.homedir` default to `process.cwd()` and `os.homedir()`; `opts.ticketFolder`, when given,
// is a folder `out` may sit under and get rebuilt in even when it is non-empty and carries no
// header. Before writing anything it calls guardOut(out, opts), which refuses (throwing, nothing
// touched) when the resolved `out` is `/`, is `opts.homedir`, is `opts.cwd` or an ancestor of it,
// is a symlink, or is a non-empty directory with no header-carrying REQUIRED.md — unless `out` is
// under `opts.ticketFolder`, where that last rule does not apply.
//
// loadKnowledgeCommand(argv, deps?) is the load-knowledge CLI's testable core: parses `--out DIR`
// (required), `--page URL` and `--required a,b` from argv (falling back to deps.page/deps.required
// when the flags are absent), runs walkKnowledge then writeKnowledgeFolder, and never throws:
// `{ code: 0, message }` on success (message names the file count and, when non-empty, the
// not-loaded count), `{ code: 1, message }` naming the reason on any failure (a thrown walk error,
// a thrown guard refusal, or a missing --out/token/page). deps may carry `token`, `fetch`, `api`,
// `cwd`, `homedir` and `ticketFolder`, all forwarded as above.

import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadKnowledgeCommand, writeKnowledgeFolder, type WalkResult } from './knowledge-walk'
import { MAX_PAGES } from './knowledge'

const TOKEN = 'test-token'

/** A 32-hex Notion page id, dashed the way pageIdFrom expects, distinct per `n`. */
function fakeId(n: number): string {
  const hex = `eeee${n.toString(16).padStart(28, '0')}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const urlFor = (id: string, title: string) => `https://www.notion.so/${title.replace(/[^a-zA-Z0-9]+/g, '-')}-${id.replace(/-/g, '')}`

type PageDef = { title: string; markdown: string; truncated?: boolean; status?: number; database?: boolean }

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
    // What the real API answers when a page link or mention points at a database (the guidelines tree links several).
    if (def.database === true) return json(400, { object: 'error', status: 400, code: 'validation_error', message: `Provided ID ${id} is a database, not a page. Use the retrieve database API instead, \`GET /databases/:database_id\`.` })
    if (def.status !== undefined && def.status !== 200) return json(def.status, { object: 'error', status: def.status, message: `page ${id} failed` })
    if (match?.[2] === '/markdown') return json(200, { markdown: def.markdown, truncated: def.truncated === true })
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

describe('loadKnowledgeCommand writing a good tree', () => {
  it('rebuilds the folder: INDEX.md, one file per page, REQUIRED.md with the provenance header, through a temporary sibling renamed into place', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const repo = await tempDir('kw-good-repo-')
    const out = join(repo, 'knowledge')
    const before = await readdir(repo)

    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })

    expect(result.code).toBe(0)
    const files = (await readdir(out)).sort()
    expect(files).toEqual(['INDEX.md', 'REQUIRED.md', 'agent-instructions.md', 'review-verification.md', 'topic-a.md'])
    const required = await readFile(join(out, 'REQUIRED.md'), 'utf8')
    expect(required).toMatch(/<!--[\s\S]*fetched[\s\S]*-->/)
    expect(required).toContain('Agent Instructions')
    expect(required).toContain('Review Verification')
    // Nothing but the final folder is left beside it (no stray temporary sibling).
    expect((await readdir(repo)).filter((entry) => !before.includes(entry))).toEqual(['knowledge'])
  })
})

describe('loadKnowledgeCommand refuses an unsafe --out and deletes nothing', () => {
  it('refuses the filesystem root', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const result = await loadKnowledgeCommand(['--out', '/'], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).not.toBe(0)
  })

  it('refuses the home directory', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const home = await tempDir('kw-home-')
    const result = await loadKnowledgeCommand(['--out', home], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED, homedir: home })
    expect(result.code).not.toBe(0)
    expect(existsSync(home)).toBe(true)
  })

  it('refuses the repository root (cwd itself)', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const repo = await tempDir('kw-cwd-')
    const before = await readdir(repo)
    const result = await loadKnowledgeCommand(['--out', repo], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED, cwd: repo })
    expect(result.code).not.toBe(0)
    expect(await readdir(repo)).toEqual(before)
  })

  it('refuses an ancestor of cwd', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const repo = await tempDir('kw-ancestor-')
    const cwd = join(repo, 'apps', 'web')
    await mkdir(cwd, { recursive: true })
    const before = await readdir(repo)
    const result = await loadKnowledgeCommand(['--out', repo], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED, cwd })
    expect(result.code).not.toBe(0)
    expect(await readdir(repo)).toEqual(before)
  })

  it('refuses a symlink', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const repo = await tempDir('kw-symlink-repo-')
    const real = join(repo, 'real-knowledge')
    await mkdir(real)
    const link = join(repo, 'knowledge-link')
    await symlink(real, link)
    const result = await loadKnowledgeCommand(['--out', link], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED, cwd: await tempDir('kw-symlink-cwd-') })
    expect(result.code).not.toBe(0)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('refuses a non-empty directory whose REQUIRED.md carries no header', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const out = await tempDir('kw-dirty-')
    await writeFile(join(out, 'REQUIRED.md'), '# Not a real snapshot\n')
    await writeFile(join(out, 'random.txt'), 'leftover')
    const before = (await readdir(out)).sort()
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED, cwd: await tempDir('kw-dirty-cwd-') })
    expect(result.code).not.toBe(0)
    expect((await readdir(out)).sort()).toEqual(before)
  })
})

describe('loadKnowledgeCommand inside a ticket folder', () => {
  it('deletes and rebuilds a legacy knowledge folder under the ticket folder, header or not', async () => {
    const { api, close } = await notionServer(basicTree())
    cleanups.push(close)
    const ticketFolder = await tempDir('kw-ticket-')
    const out = join(ticketFolder, 'knowledge')
    await mkdir(out)
    await writeFile(join(out, 'stale.md'), 'old guidance, no header')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED, cwd: await tempDir('kw-ticket-cwd-'), ticketFolder })
    expect(result.code).toBe(0)
    const files = (await readdir(out)).sort()
    expect(files).not.toContain('stale.md')
    expect(files).toContain('REQUIRED.md')
  })
})

describe('loadKnowledgeCommand on a page that fails to load', () => {
  it('exits non-zero naming a page the server 404s, leaving no complete folder behind', async () => {
    const pages = basicTree()
    pages.set(TOPIC_A, { ...pages.get(TOPIC_A)!, status: 404 })
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-404-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).not.toBe(0)
    expect(result.message).toContain('Topic A')
    expect(existsSync(join(out, 'INDEX.md'))).toBe(false)
  })

  it('exits non-zero naming a truncated page, leaving no complete folder behind', async () => {
    const pages = basicTree()
    pages.set(TOPIC_A, { ...pages.get(TOPIC_A)!, truncated: true })
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-truncated-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).not.toBe(0)
    expect(result.message).toContain('Topic A')
    expect(existsSync(join(out, 'INDEX.md'))).toBe(false)
  })
})

describe('loadKnowledgeCommand on a tree that links databases', () => {
  // The real guidelines tree links databases (Approved Technologies, Architecture Decision
  // Records, AI Agent Slop Repo) by mention; Notion answers /pages/<id> for them with 400
  // "is a database, not a page". The walk skips them, as the walk before it did, and still
  // writes the folder.
  const DATABASE = fakeId(40)
  const mention = (id: string, title: string) => `<mention-page url="${urlFor(id, title)}"/>`

  it('skips a database reached by a mention and writes the folder', async () => {
    const pages = basicTree()
    pages.set(TOPIC_A, { title: 'Topic A', markdown: `See ${mention(DATABASE, 'Approved Technologies')} for the list.` })
    pages.set(DATABASE, { title: 'Approved Technologies', markdown: '', database: true })
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-db-mention-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.message).not.toContain('is a database')
    expect(result.code).toBe(0)
    expect(result.message).toContain('1 database')
    expect((await readdir(out)).sort()).toEqual(['INDEX.md', 'REQUIRED.md', 'agent-instructions.md', 'review-verification.md', 'topic-a.md'])
  })

  it('skips a database reached by a titled page link', async () => {
    const pages = basicTree()
    pages.set(TOPIC_A, { title: 'Topic A', markdown: tag(DATABASE, 'Architecture Decision Records') })
    pages.set(DATABASE, { title: 'Architecture Decision Records', markdown: '', database: true })
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-db-page-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).toBe(0)
    expect(existsSync(join(out, 'architecture-decision-records.md'))).toBe(false)
  })

  it('still fails on a mentioned page that is missing or unshared', async () => {
    const pages = basicTree()
    pages.set(TOPIC_A, { title: 'Topic A', markdown: `See ${mention(DATABASE, 'Gone')}.` })
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-db-missing-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).not.toBe(0)
    expect(result.message).toContain('404')
    expect(existsSync(join(out, 'INDEX.md'))).toBe(false)
  })
})

describe('loadKnowledgeCommand against pages beyond the MAX_PAGES cap', () => {
  /** root + 3 named + `extra` filler children, all at depth 1 so only MAX_PAGES governs. */
  function overflowTree(extra: number, rename?: { index: number; title: string }): { pages: Map<string, PageDef>; fillerTitle: (n: number) => string } {
    const pages = basicTree()
    const fillerTitle = (n: number) => (rename && n === rename.index ? rename.title : `Filler ${n}`)
    const tags: string[] = [tag(AGENT_INSTRUCTIONS, 'Agent Instructions'), tag(REVIEW_VERIFICATION, 'Review Verification'), tag(TOPIC_A, 'Topic A')]
    for (let n = 1; n <= extra; n += 1) {
      const id = fakeId(100 + n)
      const title = fillerTitle(n)
      pages.set(id, { title, markdown: `Filler page ${n}.` })
      tags.push(tag(id, title))
    }
    pages.set(ROOT, { title: 'Engineering', markdown: `# Engineering\n\n${tags.join('\n')}\n` })
    return { pages, fillerTitle }
  }

  it('lists an unvisited non-required page in INDEX.md as not loaded, and counts it', async () => {
    const extra = MAX_PAGES + 5
    const { pages } = overflowTree(extra)
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-overflow-ok-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).toBe(0)
    const index = await readFile(join(out, 'INDEX.md'), 'utf8')
    expect(index.toLowerCase()).toContain('not loaded')
    // BFS visits root + 3 named pages + the first (MAX_PAGES - 4) fillers before the cap is hit;
    // the rest of the `extra` fillers are known (named in root's markdown) but never fetched.
    const expectedNotLoaded = extra - (MAX_PAGES - 4)
    expect(expectedNotLoaded).toBe(9)
    expect(index).toContain(`${expectedNotLoaded} page`)
    expect(index).toMatch(/Filler \d+/)
  })

  it('fails when a required page sits beyond the cap', async () => {
    const extra = MAX_PAGES + 5
    const { pages } = overflowTree(extra, { index: extra, title: 'Review Verification' })
    // Drop the earlier, reachable "Review Verification" page so only the overflowed one carries that title.
    pages.delete(REVIEW_VERIFICATION)
    const rootPage = pages.get(ROOT)!
    pages.set(ROOT, { ...rootPage, markdown: rootPage.markdown.replace(tag(REVIEW_VERIFICATION, 'Review Verification') + '\n', '') })
    const { api, close } = await notionServer(pages)
    cleanups.push(close)
    const repo = await tempDir('kw-overflow-fail-repo-')
    const out = join(repo, 'knowledge')
    const result = await loadKnowledgeCommand(['--out', out], { token: TOKEN, api, page: urlFor(ROOT, 'Engineering'), required: REQUIRED })
    expect(result.code).not.toBe(0)
    expect(result.message).toContain('Review Verification')
    expect(existsSync(join(out, 'INDEX.md'))).toBe(false)
  })
})

describe('writeKnowledgeFolder (direct)', () => {
  it('refuses to write without ever deleting the pre-existing destination', async () => {
    const out = await tempDir('kw-direct-existing-')
    await writeFile(join(out, 'keep.md'), 'keep me')
    const walk: WalkResult = { rootId: ROOT, rootUrl: urlFor(ROOT, 'Engineering'), fetchedAt: '2026-10-15T00:00:00.000Z', pages: [], required: [], notLoaded: [] }
    await expect(writeKnowledgeFolder(out, walk, { cwd: await tempDir('kw-direct-cwd-') })).rejects.toThrow()
    expect(await readdir(out)).toEqual(['keep.md'])
  })
})
