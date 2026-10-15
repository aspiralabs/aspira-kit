// T62 (plan.json P11): pins the contract of the groomer's --local knowledge stage once it runs
// load-knowledge itself (F48, F49, F50, F52; plan.json P26/P27, which depend on P11). Today
// runLocal (local.ts:311) calls loadKnowledge (local-knowledge.ts) on every invocation, but
// loadKnowledge never calls Notion: it only inspects a folder the session was expected to build
// with the Notion MCP, and the round prompt's knowledgeNote (local.ts:209-212) points a session
// without that folder at the Notion MCP directly (the design F49/F27 drop). These tests drive the
// real runLocal with a mock Notion server and a NOTION_TOKEN fixture and expect it to load the
// folder itself, read it again (not refetch it) for a later stage of the same round, and end
// blocked with no token. `fetch`/`api` are not yet read by LocalDeps, so the mock server is never
// called: every assertion below fails for that reason (the outcome plan.json records for P11)
// until P27 lands.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeGroomRecord } from '@aspiralabs/agent-common/lib/groom-record'
import { renderTicketMd } from '@aspiralabs/agent-common/lib/ticket'
import { runLocal, type LocalDeps } from './local.ts'

type FutureDeps = LocalDeps & { fetch?: typeof fetch; api?: string }

const TOKEN = 'test-notion-token'
const ROOT_ID = '11111111111111111111111111111111'
const REVIEW_ID = '22222222222222222222222222222222'
const ROOT = `https://www.notion.so/Agent-Instructions-${ROOT_ID}`
const IDEA = 'Let shoppers see why the cart stops at ten items.\n'

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

async function writeText(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}
const writeJson = (file: string, value: unknown) => writeText(file, JSON.stringify(value, null, 2))

/** A ticket folder at Grooming, with round 1 confirmed and round state pointing the run at round 2 -- no knowledge folder: this driver must build it itself. */
async function workspace() {
  const repo = await mkdtemp(join(tmpdir(), 'groomer-knowledge-stage-'))
  execFileSync('git', ['init', '-q', repo])
  await writeText(join(repo, 'src', 'cart.ts'), 'export const LIMIT = 10\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: repo })
  const folder = join(repo, '.work', 'kit-9-cart-limit')
  await writeText(join(folder, 'ticket.md'), renderTicketMd({
    id: 'KIT-9', title: 'Cart limit', url: 'https://www.notion.so/kit-9', status: 'Grooming', type: 'Feature', area: [], idea: IDEA,
    pulledAt: '2026-10-11T09:00:00.000Z', pages: { 'Grooming Decisions': { id: 'gd', title: 'Grooming Decisions', url: 'https://www.notion.so/gd', lastEditedAt: '2026-10-11T09:00:00.000Z' } },
  }))
  await writeText(join(folder, 'idea.md'), IDEA)
  const previous = {
    decisions: [{ id: 'Q1', branch: 'problem', question: 'Which problem?', options: ['A', 'B'], recommended: 'A', reasoning: 'r', whyYours: 'w', facts: [], decidedBy: 'author' as const, answer: 'A' }],
    branches: [{ id: 'problem', state: 'visited' as const }],
    round: 1, startedAt: '2026-10-11T09:00:00.000Z', open: 0, page: { id: 'gd', url: 'https://www.notion.so/gd' }, status: 'needs-author' as const, reasonCode: null, reason: null,
  }
  await writeGroomRecord(folder, previous)
  await writeJson(join(folder, '.local', 'groomer', 'board.json'), { round: 2 })
  const appDir = join(repo, 'app')
  await writeText(join(appDir, '.env.local'), `NOTION_TOKEN=${TOKEN}\nKNOWLEDGE_PAGE=${ROOT}\n`)
  return { repo, folder, input: { folder, repoPath: repo }, appDir }
}

describe('the groomer --local knowledge stage (T62)', () => {
  let notion: Awaited<ReturnType<typeof mockNotion>>

  beforeEach(async () => { notion = await mockNotion() })
  afterEach(async () => { await notion.close() })

  it('loads round 2\'s folder itself from Notion, and a later stage of round 2 reads it again without a new request', async () => {
    const ws = await workspace()
    const env = { KNOWLEDGE_PAGE: ROOT, NOTION_TOKEN: TOKEN }
    const deps: FutureDeps = { env, fetch, api: notion.api }

    const first = await runLocal(ws.input, deps)
    expect(notion.requests.length).toBeGreaterThan(0)
    expect(first).toMatchObject({ round: 2, stage: 'round' })
    const prompt = first.pending && 'task' in first ? await readFile((first as { task: { prompt: string } }).task.prompt, 'utf8') : ''
    expect(prompt).not.toMatch(/Notion MCP/i)

    const afterFirst = notion.requests.length
    // A later stage of round 2: the round file now exists, so the next call reaches the answers stage.
    await writeJson(join(ws.folder, 'groom', 'round-2.json'), { round: 2, searched: ['cart limit'], facts: [], questions: [], branches: [] })
    const second = await runLocal(ws.input, deps)
    expect(second).toMatchObject({ round: 2, stage: 'answers' })
    expect(notion.requests.length).toBe(afterFirst)
  })

  it('ends blocked with no token anywhere, naming NOTION_TOKEN and the env files', async () => {
    const ws = await workspace()
    const deps: FutureDeps = { env: {}, fetch, api: notion.api }
    const result = await runLocal(ws.input, deps)
    expect((result as { pending: boolean }).pending).toBe(false)
    expect((result as { status: string }).status).toBe('blocked')
    const reason = JSON.stringify(result)
    expect(reason).toContain('NOTION_TOKEN')
    expect(reason).toMatch(/\.env\.local/)
  })
})
