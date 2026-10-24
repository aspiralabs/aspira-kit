// T65 (plan.json P11): pins the contract of pr-reviewer's --local knowledge stage once it fetches
// the engineering guidelines itself (F48, F49, F50, F52; the shared walk of plan.json P26/P27,
// which depend on P11). Today runLocal's inline knowledge stage (local.ts:323-413: KnowledgeRequired,
// knowledgeConfig, checkKnowledge) only ever checks a folder already on disk -- the session's job,
// over the Notion MCP -- and never makes a Notion request itself; checkKnowledge never checks a
// topic file's provenance header either, so a header-less legacy folder is accepted today. A missing
// folder throws KnowledgeRequired, mapped by scripts/local.ts to exit 3 (REFUSED), the same code as a
// board refusal; there is no "blocked" status distinct from that. Every assertion here fails for one
// of those reasons (the outcome plan.json records for P11) until P27 lands.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
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

/** A local branch with a reviewable change, with no knowledge folder yet. */
async function gitRepo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pr-reviewer-knowledge-stage-')))
  const repo = join(dir, 'repo')
  await mkdir(repo)
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim()
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'a.ts'), 'export const a = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  await git('checkout', '-qb', 'feat/x')
  await writeFile(join(repo, 'a.ts'), 'export const a = 2\n')
  await git('add', '.')
  await git('commit', '-qm', 'feat: change a')
  return { dir, repo }
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

describe('the pr-reviewer --local knowledge stage (T65)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('loads the folder itself once per run before any prompt is written', async () => {
    const { repo } = await gitRepo()
    const env = { KNOWLEDGE_PAGE: ROOT, NOTION_TOKEN: TOKEN }
    const deps: FutureDeps = { env, fetch, api: notion.api }
    const first = await runLocal({ source: repo }, deps)
    expect(notion.requests.length).toBeGreaterThan(0)
    if (!first.pending) throw new Error(`expected pending, got ${JSON.stringify(first)}`)
  })

  it('a header-less --knowledge dir is refused', async () => {
    const { repo } = await gitRepo()
    const knowledge = join(repo, 'knowledge')
    // Pre-shared-walk shape: REQUIRED.md's headings are present, but no page carries its provenance header.
    await mkdir(knowledge, { recursive: true })
    await writeFile(join(knowledge, 'INDEX.md'), '# Engineering\n')
    await writeFile(join(knowledge, 'REQUIRED.md'), '---\n\n# Agent Instructions\n\nREV-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-002 Verify.\n')
    const error = await runLocal({ source: repo, knowledge }, {}).then(() => null, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(KnowledgeRequired)
    expect((error as Error).message).toMatch(/load-knowledge/i)
  })

  it('ends blocked with no token anywhere (exit 1), no longer refused with exit 3', async () => {
    const { repo } = await gitRepo()
    const deps: FutureDeps = { env: {}, fetch, api: notion.api }
    const result = await runLocal({ source: repo }, deps).then(
      (value) => value,
      (cause: unknown) => cause,
    )
    expect(result).not.toBeInstanceOf(KnowledgeRequired)
    expect((result as { pending?: boolean }).pending).toBe(false)
    expect((result as { status?: string }).status).toBe('blocked')
    expect((result as { status?: string }).status).not.toBe('refused')
  })

  it('a verified --knowledge dir is accepted, with no Notion request', async () => {
    const { repo } = await gitRepo()
    const knowledge = join(repo, 'knowledge')
    await verifiedKnowledge(knowledge, notion.api)
    // Building the folder is load-knowledge's own walk; only the run's requests count from here.
    notion.requests.length = 0
    const result = await runLocal({ source: repo, knowledge, noComment: true }, {})
    expect(result).not.toBeInstanceOf(KnowledgeRequired)
    expect(notion.requests.length).toBe(0)
  })
})
