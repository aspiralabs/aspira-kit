// T60 (plan.json P11): pins the contract of the spec writer's --local knowledge stage once it
// fetches the engineering guidelines itself (F48, F49, F50, F52; the shared walk of plan.json
// P26/P27, which depend on P11). Today runLocal (local.ts:121-127) calls resolveKnowledge, which
// calls loadKnowledge (local-knowledge.ts) directly: when the folder is missing or incomplete it
// throws KnowledgeRequired (local-knowledge.ts:3-7 says the session fetches the pages the error
// names, over the Notion MCP) and the CLI prints that as the pending knowledge stage, uncaught by
// runLocal itself. `fetch`/`api` are not yet read by LocalDeps, so the mock server below is never
// called: every assertion here fails for that reason (the outcome plan.json records for P11) until
// P27 lands.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeRequired } from './local-knowledge.ts'
import { runLocal, type LocalDeps } from './local.ts'

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

/** An idea and a real repository, at the start of a spec-writer run: no knowledge folder yet. */
async function workspace() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'spec-writer-knowledge-stage-')))
  const repo = join(dir, 'repo')
  await mkdir(repo, { recursive: true })
  await exec('git', ['init', '-q', repo])
  await writeFile(join(repo, 'src.ts'), 'export const items: string[] = []\n')
  await exec('git', ['-C', repo, 'add', '.'])
  await exec('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  const ideaPath = join(dir, 'idea.md')
  await writeFile(ideaPath, 'Let shoppers save an item for later.')
  const agentDir = await mkdtemp(join(tmpdir(), 'spec-writer-agent-'))
  return { dir, repo, ideaPath, input: { ideaPath, repoPath: repo, uiRequired: false }, agentDir }
}

describe('the spec writer --local knowledge stage (T60)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('loads the folder itself once per run before any prompt is written', async () => {
    const ws = await workspace()
    await writeFile(join(ws.agentDir, '.env.local'), `KNOWLEDGE_PAGE=${ROOT}\nNOTION_TOKEN=${TOKEN}\n`)
    const deps: FutureDeps = { agentDir: ws.agentDir, fetch, api: notion.api }

    const first = await runLocal(ws.input, deps)
    expect(notion.requests.length).toBeGreaterThan(0)
    if (!first.pending) throw new Error(`expected pending, got ${JSON.stringify(first)}`)
    expect(first.stage).not.toBe('knowledge')
    expect(JSON.stringify(first)).not.toMatch(/notion-fetch/i)

    const afterFirst = notion.requests.length
    await writeFile(first.tasks[0]!.output, JSON.stringify({ facts: [], constraints: [], questions: [], uiEvidence: [], gaps: [] }))
    await runLocal(ws.input, deps)
    expect(notion.requests.length).toBe(afterFirst)
  })

  it('ends blocked with no token anywhere, naming NOTION_TOKEN and the env files, with no session fetch instruction', async () => {
    const ws = await workspace()
    await writeFile(join(ws.agentDir, '.env.local'), `KNOWLEDGE_PAGE=${ROOT}\n`)
    const deps: FutureDeps = { agentDir: ws.agentDir, fetch, api: notion.api }

    const error = await runLocal(ws.input, deps).then(
      (result) => result,
      (cause: unknown) => cause,
    )
    const blocked = error instanceof KnowledgeRequired ? false : (error as { pending?: boolean }).pending === false && (error as { status?: string }).status === 'blocked'
    expect(blocked).toBe(true)
    const reason = error instanceof Error ? error.message : JSON.stringify(error)
    expect(reason).toContain('NOTION_TOKEN')
    expect(reason).toMatch(/\.env\.local/)
    expect(reason).not.toMatch(/notion-fetch/i)
  })
})
