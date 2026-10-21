// T63 (plan.json P11): pins the contract of the implementor's --local knowledge stage once it
// fetches the engineering guidelines itself (F48, F49, F50, F52; the shared walk of plan.json
// P26/P27, which depend on P11). Today runLocal's loadKnowledge (local.ts:252-274) checks
// <run>/knowledge with inspectKnowledge and, when incomplete, returns a `stage: 'knowledge'` result
// naming the pages for the session to fetch with the Notion MCP (SKILL.md:113) -- never a Notion
// request from the driver itself, and no NOTION_TOKEN check anywhere. `fetch`/`api` are not yet read
// by LocalDeps, so the mock server below is never called: every assertion here fails for that reason
// (the outcome plan.json records for P11) until P27 lands.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLocal, type LocalDeps, type LocalResult } from './local.ts'

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

/** A reviewed-plan ticket folder on its own branch, with no knowledge folder yet. */
async function workspace() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-knowledge-stage-')))
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'feat/cart', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await mkdir(join(repo, 'specs/cart'), { recursive: true })
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'AGENTS.md'), '# Project\n')
  await writeFile(join(repo, 'specs/cart/spec.md'), '# Cart\n\n- [ ] F1: totals\n')
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  const spec = join(repo, 'specs/cart/spec.md')
  const work = join(repo, 'specs/cart/implementation')
  const knowledge = join(work, 'implementation.local/knowledge')
  return { dir, repo, spec, work, knowledge, input: { source: spec } }
}

describe('the implementor --local knowledge stage (T63)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('loads the folder itself once per run before any prompt is written, and a lane stage reads it again without a new request', async () => {
    const ws = await workspace()
    const env = { KNOWLEDGE_PAGE: ROOT, NOTION_TOKEN: TOKEN }
    const deps: FutureDeps = { env, fetch, api: notion.api }

    const first: LocalResult = await runLocal(ws.input, deps)
    expect(notion.requests.length).toBeGreaterThan(0)
    // `as string`: there is no knowledge stage in the type any more; the guard still catches one at runtime.
    if (!first.pending || (first.stage as string) === 'knowledge') throw new Error(`expected a model stage, got ${JSON.stringify(first)}`)
    for (const task of first.tasks) expect(await readFile(task.prompt, 'utf8')).not.toMatch(/Notion MCP[^.]*guideline|guideline[^.]*Notion MCP/i) // KIT-54: the Notion MCP is a research tool; the rules still come from the folder

    const afterFirst = notion.requests.length
    const second: LocalResult = await runLocal(ws.input, deps)
    if (!second.pending || (second.stage as string) === 'knowledge') throw new Error(`expected a model stage, got ${JSON.stringify(second)}`)
    expect(notion.requests.length).toBe(afterFirst)
  })

  it('ends blocked with no token anywhere, naming NOTION_TOKEN and the env files', async () => {
    const ws = await workspace()
    const deps: FutureDeps = { env: { KNOWLEDGE_PAGE: ROOT }, fetch, api: notion.api }
    const result = await runLocal(ws.input, deps)
    expect(result.pending).toBe(false)
    expect((result as { status: string }).status).toBe('blocked')
    const reason = JSON.stringify(result)
    expect(reason).toContain('NOTION_TOKEN')
    expect(reason).toMatch(/\.env\.local/)
  })
})
