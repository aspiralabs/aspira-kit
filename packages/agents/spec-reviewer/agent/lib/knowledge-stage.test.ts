// T61 (plan.json P11): pins the contract of the spec reviewer's --local knowledge stage once it
// fetches the engineering guidelines itself (F48, F49, F50, F52; the shared walk of plan.json
// P26/P27, which depend on P11). Today runLocal calls resolveKnowledge, which calls loadKnowledge
// (local-knowledge.ts, the sibling of spec-writer's: same module, same throw) directly: a missing or
// incomplete folder throws KnowledgeRequired, uncaught, naming the pages the session must fetch over
// the Notion MCP. snapshotKnowledge accepts any --guidelines file unconditionally today, including an
// exported trace/guidelines.md copy fed back in as input -- the new design refuses that case and
// points at load-knowledge instead. `fetch`/`api` are not yet read by LocalDeps, so the mock server
// below is never called: every assertion here fails for that reason (the outcome plan.json records
// for P11) until P27 lands.

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
import { writeSnapshot } from './snapshot.test-helper.ts'

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

/** A spec at In Review: Spec and a real repository, with no knowledge folder yet. */
async function workspace() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'spec-reviewer-knowledge-stage-')))
  const repo = join(dir, 'repo')
  await mkdir(repo, { recursive: true })
  await exec('git', ['init', '-q', repo])
  await writeFile(join(repo, 'src.ts'), 'export const items: string[] = []\n')
  await exec('git', ['-C', repo, 'add', '.'])
  await exec('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  const specPath = join(dir, 'spec.md')
  await writeFile(specPath, '# Save items\n## Intent\nLet people save items.\n')
  const agentDir = await mkdtemp(join(tmpdir(), 'spec-reviewer-agent-'))
  return { dir, repo, specPath, input: { specPath, repoPath: repo, uiRequired: false }, agentDir }
}

describe('the spec reviewer --local knowledge stage (T61)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('without --guidelines, loads the folder itself once before any prompt is written', async () => {
    const ws = await workspace()
    // KNOWLEDGE_PAGE is the agent's own config; NOTION_TOKEN comes from the project's .env.local,
    // never the agent package's (F52).
    await writeFile(join(ws.agentDir, '.env.local'), `KNOWLEDGE_PAGE=${ROOT}\n`)
    await writeFile(join(ws.repo, '.env.local'), `NOTION_TOKEN=${TOKEN}\n`)
    const deps: FutureDeps = { agentDir: ws.agentDir, fetch, api: notion.api }
    const first = await runLocal(ws.input, deps)
    expect(notion.requests.length).toBeGreaterThan(0)
    if (!first.pending) throw new Error(`expected pending, got ${JSON.stringify(first)}`)
    expect(first.stage).not.toBe('knowledge')
  })

  it('with a verified --guidelines snapshot, makes no Notion request', async () => {
    const ws = await workspace()
    // A REQUIRED.md load-knowledge wrote, verified by its provenance header where it was written (F50).
    const snapshot = join(ws.dir, 'rules.md')
    await writeSnapshot(snapshot)
    const deps: FutureDeps = { agentDir: ws.agentDir, fetch, api: notion.api }
    await runLocal({ ...ws.input, guidelinesPath: snapshot }, deps)
    expect(notion.requests.length).toBe(0)
  })

  it('refuses a trace/guidelines.md export copy as --guidelines, naming the load-knowledge command', async () => {
    const ws = await workspace()
    const exported = join(ws.dir, 'earlier-review', 'trace', 'guidelines.md')
    await mkdir(join(ws.dir, 'earlier-review', 'trace'), { recursive: true })
    // A real snapshot, copied under trace/: refused for where it sits, not for a missing header.
    await writeSnapshot(exported)
    const deps: FutureDeps = { agentDir: ws.agentDir, fetch, api: notion.api }
    const error = await runLocal({ ...ws.input, guidelinesPath: exported }, deps).then(() => null, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/load-knowledge/i)
  })

  it('ends blocked with no token anywhere, naming NOTION_TOKEN and the env files', async () => {
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
  })
})
