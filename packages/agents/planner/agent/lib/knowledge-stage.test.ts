// T59 (plan.json P11): pins the contract of the planner's --local knowledge stage once it fetches
// the engineering guidelines itself (F48, F49, F50, F52; the shared walk of plan.json P26/P27,
// which depend on P11). Today runLocal (local.ts:149-157) calls inspectKnowledge (local-knowledge.ts)
// against <work>/knowledge: when that folder is incomplete it returns `{ stage: 'knowledge', ... }`
// and asks the session to fetch the pages with the Notion MCP (local.ts:94). There is no
// NOTION_TOKEN check at all today: inspectKnowledge only reads KNOWLEDGE_PAGE/KNOWLEDGE_REQUIRED.
// `fetch`/`api` are not yet read by LocalDeps, so the mock server below is never called: every
// assertion here fails for that reason (the outcome plan.json records for P11) until P27 lands.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { files, spec } from './fixtures.test-helper.ts'
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

/** A plan-ready repository and reviewed spec, with no knowledge folder: this driver must build it itself. */
async function workspace() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'planner-knowledge-stage-')))
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'tests'), { recursive: true })
  for (const [path, text] of files) await writeFile(join(repo, path), text)
  await exec('git', ['init', '-q', repo])
  await exec('git', ['-C', repo, 'add', '.'])
  await exec('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  const specPath = join(dir, 'feature', 'spec.reviewed', 'spec.reviewed.md')
  await mkdir(dirname(specPath), { recursive: true })
  await writeFile(specPath, spec)
  const outputDir = join(dir, 'out', 'plan.review')
  return { dir, repo, specPath, outputDir, input: { specPath, repoPath: repo, outputDir } }
}

function pending(result: LocalResult) {
  if (!result.pending) throw new Error(`expected a pending stage, got ${JSON.stringify(result)}`)
  return result
}

describe('the planner --local knowledge stage (T59)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('loads the folder itself before any prompt is written, and a later stage of the same run reads it again without a new request', async () => {
    const ws = await workspace()
    const env = { KNOWLEDGE_PAGE: ROOT, NOTION_TOKEN: TOKEN }
    const deps: FutureDeps = { env, fetch, api: notion.api }

    const first = pending(await runLocal(ws.input, deps))
    expect(notion.requests.length).toBeGreaterThan(0)
    expect(first.stage).not.toBe('knowledge')
    for (const task of first.tasks) expect(await readFile(task.prompt, 'utf8')).not.toMatch(/Notion MCP/i)

    const afterFirst = notion.requests.length
    // A later stage of the same run: the research output now exists, so the next call advances.
    await writeFile(first.tasks[0]!.output, JSON.stringify({ facts: [], constraints: [], questions: [], risks: [], gaps: [] }))
    const second = pending(await runLocal(ws.input, deps))
    expect(second.stage).not.toBe('knowledge')
    expect(notion.requests.length).toBe(afterFirst)
  })

  it('never reads an earlier run\'s folder for a new run id', async () => {
    const ws1 = await workspace()
    const ws2 = await workspace()
    const env = { KNOWLEDGE_PAGE: ROOT, NOTION_TOKEN: TOKEN }
    const deps: FutureDeps = { env, fetch, api: notion.api }
    pending(await runLocal(ws1.input, deps))
    const afterFirstRun = notion.requests.length
    expect(afterFirstRun).toBeGreaterThan(0)
    pending(await runLocal(ws2.input, deps))
    expect(notion.requests.length).toBeGreaterThan(afterFirstRun)
  })

  it('ends blocked with no token anywhere, naming NOTION_TOKEN and the env files, and no stage asks the session to fetch guidelines', async () => {
    const ws = await workspace()
    const deps: FutureDeps = { env: { KNOWLEDGE_PAGE: ROOT }, fetch, api: notion.api }
    const result = await runLocal(ws.input, deps)
    expect(result.pending).toBe(false)
    expect((result as { status: string }).status).toBe('blocked')
    const reason = JSON.stringify(result)
    expect(reason).toContain('NOTION_TOKEN')
    expect(reason).toMatch(/\.env\.local/)
    expect(reason).not.toContain('--guidelines')
  })

  it('no --guidelines flag given and no token: no Notion MCP guideline-fetch stage is printed either', async () => {
    const ws = await workspace()
    const deps: FutureDeps = { env: {}, fetch, api: notion.api }
    const result = await runLocal(ws.input, deps)
    expect(JSON.stringify(result)).not.toMatch(/Notion MCP/i)
  })
})
