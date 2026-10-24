// T64 (plan.json P11): pins the contract of code-analyzer's --local knowledge stage once runLocal
// is wired to the shared walk (F48, F49, F50, F52; plan.json P26/P27, which depend on P11).
// knowledge.ts already has a live-Notion path (resolveKnowledge, loadKnowledgeFromNotion:154-264),
// written as "the same breadth-first walk... into a host folder" (knowledge.ts:3-6) -- a host copy
// of the shared walk this plan replaces. But runLocal (local.ts:204-211) never calls resolveKnowledge:
// without --knowledge it calls checkKnowledgeDir against `<work>/knowledge` directly, so that folder
// must already exist (the session's job today), and checkKnowledgeDir never checks a topic file's
// provenance header, so an edited REQUIRED.md or a header-less legacy folder is accepted today. There
// is no "blocked" status at all: a missing folder throws KnowledgeRequired (exit 0, pending), caught
// only by scripts/local.ts. Every assertion here fails for one of those reasons (the outcome
// plan.json records for P11) until P27 lands.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/ai/common/lib/knowledge-walk'
import { KnowledgeRequired, runLocal, type LocalDeps } from './local.ts'

const exec = promisify(execFile)
type FutureDeps = LocalDeps & { fetch?: typeof fetch; api?: string }

const TOKEN = 'test-notion-token'
const ROOT_ID = '11111111111111111111111111111111'
const REVIEW_ID = '22222222222222222222222222222222'
const ROOT = `https://www.notion.so/Agent-Instructions-${ROOT_ID}`

async function mockNotion(): Promise<{ api: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const page = (title: string) => ({ properties: { Name: { type: 'title', title: [{ plain_text: title }] } } })
  const markdown = (id: string) =>
    id === ROOT_ID
      ? { markdown: `<page url="https://www.notion.so/Review-Verification-${REVIEW_ID}">Review Verification</page>\n`, truncated: false }
      : { markdown: 'REV-001 Verify every claim.\n', truncated: false }
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    const match = req.url?.match(/^\/v1\/pages\/([0-9a-f-]+)(\/markdown)?$/)
    res.setHeader('content-type', 'application/json')
    if (!match) { res.statusCode = 404; res.end('{}'); return }
    const id = match[1]!.replaceAll('-', '')
    res.end(JSON.stringify(match[2] ? markdown(id) : page(id === ROOT_ID ? 'Agent Instructions' : 'Review Verification')))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { api: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/** A real app repository to analyze, with no knowledge folder yet. */
async function repo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'code-analyzer-knowledge-stage-')))
  await exec('git', ['init', '-q', dir])
  await writeFile(join(dir, 'index.js'), 'const x = 1\nmodule.exports = { x }\n')
  await exec('git', ['-C', dir, 'add', '.'])
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  return dir
}

/**
 * A folder load-knowledge really wrote: the one shared walk (knowledge-walk.ts) over the mock Notion
 * tree, written with its provenance block in REQUIRED.md. A hand-written folder with per-file
 * comments only is not one verifyKnowledgeDir can accept (F50), so the test builds the real thing.
 */
async function verifiedKnowledge(dir: string, api: string) {
  const walk = await walkKnowledge({ token: TOKEN, page: ROOT, required: ['Agent Instructions', 'Review Verification'], fetch, api })
  await writeKnowledgeFolder(dir, walk)
}

describe('the code-analyzer --local knowledge stage (T64)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('without --knowledge, the shared walk loads <work>/knowledge itself, no host walk copy', async () => {
    const source = await repo()
    const env = { KNOWLEDGE_PAGE: ROOT, NOTION_TOKEN: TOKEN }
    const deps: FutureDeps = { env, fetch, api: notion.api }
    const result = await runLocal({ source }, deps)
    expect(notion.requests.length).toBeGreaterThan(0)
    expect(result.pending).toBeDefined()
  })

  it('accepts a verified --knowledge dir', async () => {
    const source = await repo()
    const knowledge = join(source, 'knowledge')
    await verifiedKnowledge(knowledge, notion.api)
    const result = await runLocal({ source, knowledge, noFix: true }, {})
    expect(result).not.toBeInstanceOf(KnowledgeRequired)
  })

  it('refuses an edited --knowledge dir whose REQUIRED.md no longer matches its topic file, naming the load-knowledge command', async () => {
    const source = await repo()
    const knowledge = join(source, 'knowledge')
    await verifiedKnowledge(knowledge, notion.api)
    // Hand-edited after load-knowledge wrote it: the page text no longer matches its own provenance.
    const required = join(knowledge, 'REQUIRED.md')
    const written = await readFile(required, 'utf8')
    expect(written).toContain('REV-001 Verify every claim.')
    await writeFile(required, written.replace('REV-001 Verify every claim.', 'Tampered text that was never fetched from Notion.'))
    const error = await runLocal({ source, knowledge, noFix: true }, {}).then(() => null, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(KnowledgeRequired)
    expect((error as Error).message).toMatch(/load-knowledge/i)
  })

  it('refuses a legacy session-written dir with no provenance header, naming the load-knowledge command', async () => {
    const source = await repo()
    const knowledge = join(source, 'knowledge')
    await mkdir(knowledge, { recursive: true })
    // Pre-shared-walk shape: no "<!-- title · url · fetched ... -->" header on any file.
    await writeFile(join(knowledge, 'INDEX.md'), '# Engineering\n')
    await writeFile(join(knowledge, 'REQUIRED.md'), '---\n\n# Agent Instructions\n\nAGT-001 Read this first.\n\n---\n\n# Review Verification\n\nREV-001 Verify every claim.\n')
    const error = await runLocal({ source, knowledge, noFix: true }, {}).then(() => null, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(KnowledgeRequired)
    expect((error as Error).message).toMatch(/load-knowledge/i)
  })

  it('ends blocked (exit 1) with no token anywhere, not a pending session knowledge stage', async () => {
    const source = await repo()
    const deps: FutureDeps = { env: {}, fetch, api: notion.api }
    const result = await runLocal({ source }, deps).then(
      (value) => value,
      (cause: unknown) => cause,
    )
    expect(result).not.toBeInstanceOf(KnowledgeRequired)
    expect((result as { pending?: boolean }).pending).toBe(false)
    expect((result as { status?: string }).status).toBe('blocked')
  })
})
