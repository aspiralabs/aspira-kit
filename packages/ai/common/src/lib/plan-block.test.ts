// T50, T51: the Plan page's fenced ```json block (F36, F37). The planner pushes one plan.json
// and the implementor's gate fields onto the Plan page; a fresh machine's pull rebuilds
// plan.review/trace/plan.json and plan.review/trace/review.json from it, or refuses cleanly when
// the block cannot be trusted. Notion is mocked at the HTTP boundary (`board.pageMarkdown`), never
// by stubbing plan-block.ts's own functions.
//
// The contract this test fixes for plan-block.ts (none of it exists yet):
//   PLAN_BLOCK_FILES: readonly string[]                      -- the two fixed destinations, repository-relative
//   renderPlanBlock({ pageMarkdown, plan, review, pageTextSha256 }): string
//     -- `pageMarkdown` with one more ```json block appended: { plan, review: <gate fields>,
//        renderSha256: sha256(renderPlan(plan)), pageTextSha256 }. `review` is exactly status,
//        decisions, repoCommit and problems (already redacted to repository-relative paths by the
//        caller, per S3-11's existing redaction utility -- not plan-block.ts's job): never `input`,
//        `models`, `mcp` or timings, which this module drops even if the caller's object still has them.
//   pageTextHash(pageMarkdown): string                        -- sha256 of the markdown with any
//     trailing plan-block stripped, trimmed: "the page text outside the block".
//   recoverPlan({ pageMarkdown, truncated, folder, pageUrl }): Promise<RecoverResult>
//     -- RecoverResult = { recovered: true; files: string[] } | { recovered: false; reason: string; file: string }
//     -- always writes (on success) to `folder`/PLAN_BLOCK_FILES[0] and [1], never a path the block names.

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { board } from './board.ts'
import type { DecisionRecord } from './decisions.ts'
import { PLAN_BLOCK_FILES, pageTextHash, recoverPlan, renderPlanBlock } from './plan-block.ts'
import { planSchema, renderPlan, type Plan } from './plan.ts'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const DS = '3e73e59b225881a1a1a1a1a1a1a1a1a1'
const TOKEN = 'test-token'
const PLAN_PAGE_ID = '3ec3e59b22588102becfce78d66142e1'
const PLAN_PAGE_URL = `https://www.notion.so/${PLAN_PAGE_ID}`

const PROSE = ['# Implementation plan', '', 'Status: **ready**', '', 'Source spec: specs/cart/spec.md', '## Intent', '', 'Cart totals.', ''].join('\n')

const PLAN: Plan = {
  summary: 'Cart totals.',
  tasks: [
    { id: 'P1', title: 'price tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/price.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest src/price.test.ts'], outcome: 'red' },
    { id: 'P2', title: 'price', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'modify', path: 'src/price.ts', symbols: ['price'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest src/price.test.ts'], outcome: 'green' },
    { id: 'P3', title: 'verify', kind: 'verification', featureIds: ['F1'], dependsOn: ['P2'], testIds: [], changes: [], commands: ['pnpm test'], outcome: 'all green' },
  ],
  tests: [{ id: 'T1', kind: 'unit', path: 'src/price.test.ts', featureIds: ['F1'], setup: 's', action: 'a', assertions: ['x'] }],
  checks: [],
  decisions: [],
  gaps: [],
}
// planSchema is satisfied: confirm once, so a schema drift fails loudly here rather than inside the server.
if (!planSchema.safeParse(PLAN).success) throw new Error('fixture PLAN is not a valid Plan')

const DECISIONS: DecisionRecord[] = [{ id: 'D1', question: 'Keep saved items forever?', options: ['Keep forever', 'Expire after 30 days'], recommended: 'Keep forever', reasoning: 'nothing else expires', whyYours: 'storage cost', decidedBy: 'agent', answer: 'Keep forever' }]

const REPO_COMMIT = 'a'.repeat(40)
// Already repository-relative (S3-11's redaction runs before renderPlanBlock is ever called; this
// module's own job is only to drop `input`/`models`/`mcp`/timings, never to redact a path itself).
const REDACTED_PROBLEMS = ['src/badge.ts: Cannot find module']
const REVIEW = { status: 'ready', decisions: DECISIONS, repoCommit: REPO_COMMIT, problems: REDACTED_PROBLEMS }
// What a planner's real trace/review.json also carries, and F36 says a published block never does:
// even handed a review object still carrying these (a caller's mistake), plan-block.ts drops them.
const HOST_ONLY = { input: { specPath: '/Users/dev/aspira-kit/specs/cart/spec.md' }, models: { planning: 'claude-opus' }, mcp: ['notion'], prepareMs: 10, reviewMs: 20, totalMs: 30 }

let server: Server
let api: string
/** The Plan page's markdown, as the mock Notion server answers it; `null` serves `truncated: true`. */
let pageMarkdown: string | null
let truncated: boolean

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === `/v1/pages/${PLAN_PAGE_ID}/markdown`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ markdown: pageMarkdown ?? '', truncated }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 'object_not_found', message: `no route: ${req.method} ${req.url}` }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  pageMarkdown = null
  truncated = false
})

async function emptyFolder() {
  const dir = await mkdtemp(join(tmpdir(), 'plan-block-'))
  temps.push(dir)
  return dir
}

const client = () => board({ board: `collection://${DS}`, token: TOKEN, api })

async function assertNothingWritten(folder: string) {
  for (const file of PLAN_BLOCK_FILES) await expect(readFile(join(folder, file), 'utf8')).rejects.toThrow()
  // Not even an empty or partial file: the destination directory itself should hold nothing this pull made.
  const traceDir = join(folder, 'plan.review/trace')
  expect(await readdir(traceDir).catch(() => [])).toEqual([])
}

describe('T50: renderPlanBlock + recoverPlan round trip through the board api seam', () => {
  it('a fresh pull writes plan.json and review.json byte-identical to what was published, redacted and recovered, and ignores a destination the block names', async () => {
    const folder = await emptyFolder()

    // The planner's first push: no pageTextSha256 yet (it is only known after a read-back).
    const firstPush = renderPlanBlock({ pageMarkdown: PROSE, plan: PLAN, review: REVIEW, pageTextSha256: null })
    pageMarkdown = firstPush
    const afterFirstPush = await client().pageMarkdown(PLAN_PAGE_ID)
    expect(afterFirstPush.truncated).toBe(false)

    // The driver reads the page text back once and records its hash in a second, final push (A7/S3-2).
    const recordedPageTextSha256 = pageTextHash(afterFirstPush.markdown)
    const finalPush = renderPlanBlock({ pageMarkdown: PROSE, plan: PLAN, review: REVIEW, pageTextSha256: recordedPageTextSha256 })
    pageMarkdown = finalPush

    // A block that names its own destination, and whose review carries host-only fields no caller
    // should have put there: the pull must still land only at PLAN_BLOCK_FILES, and drop the rest.
    const tampered = finalPush.replace(/```json\n([\s\S]*?)\n```/, (_m: string, body: string) => {
      const parsed = JSON.parse(body) as { review: Record<string, unknown> }
      return `\`\`\`json\n${JSON.stringify({ ...parsed, destination: '../../evil.json', review: { ...parsed.review, ...HOST_ONLY } })}\n\`\`\``
    })
    pageMarkdown = tampered

    const pulled = await client().pageMarkdown(PLAN_PAGE_ID)
    const result = await recoverPlan({ pageMarkdown: pulled.markdown, truncated: pulled.truncated, folder, pageUrl: PLAN_PAGE_URL })
    expect(result).toMatchObject({ recovered: true })

    expect(await readdir(join(folder, 'plan.review/trace')).catch(() => [])).toEqual(expect.arrayContaining(['plan.json', 'review.json']))
    expect(await readdir(folder)).not.toContain('evil.json')
    await expect(readFile(join(folder.split('/').slice(0, -1).join('/'), 'evil.json'), 'utf8')).rejects.toThrow()

    const writtenPlanText = await readFile(join(folder, PLAN_BLOCK_FILES[0]!), 'utf8')
    expect(JSON.parse(writtenPlanText)).toEqual(PLAN)
    expect(sha256(renderPlan(JSON.parse(writtenPlanText), 'ready', { specPath: 'specs/cart/spec.md', commit: REPO_COMMIT, dirty: false }, []))).toBe(sha256(renderPlan(PLAN, 'ready', { specPath: 'specs/cart/spec.md', commit: REPO_COMMIT, dirty: false }, [])))

    const writtenReview = JSON.parse(await readFile(join(folder, PLAN_BLOCK_FILES[1]!), 'utf8'))
    expect(writtenReview).toMatchObject({ status: 'ready', decisions: DECISIONS, repoCommit: REPO_COMMIT, problems: REDACTED_PROBLEMS, recoveredFrom: PLAN_PAGE_URL })
    for (const key of Object.keys(HOST_ONLY)) expect(writtenReview).not.toHaveProperty(key)
  })
})

describe('T51: a block that cannot be trusted refuses cleanly, naming the file, never writing a partial one', () => {
  const cases: { name: string; markdown: () => string; truncated?: boolean; reason: RegExp }[] = [
    { name: 'no block at all', markdown: () => PROSE, reason: /plan\.json|review\.json/i },
    { name: 'malformed JSON in the block', markdown: () => `${PROSE}\n\n\`\`\`json\n{ not: valid json\n\`\`\`\n`, reason: /plan\.json|review\.json/i },
    {
      name: 'JSON that fails planSchema',
      markdown: () => {
        const block = { plan: { ...PLAN, tasks: [] }, review: REVIEW, renderSha256: 'x', pageTextSha256: 'x' }
        return `${PROSE}\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`\n`
      },
      reason: /plan\.json/i,
    },
    {
      name: 'the page Notion reports as truncated',
      markdown: () => renderPlanBlock({ pageMarkdown: PROSE, plan: PLAN, review: REVIEW, pageTextSha256: pageTextHash(PROSE) }),
      truncated: true,
      reason: /truncat/i,
    },
  ]

  for (const scenario of cases) {
    it(`refuses: ${scenario.name}`, async () => {
      const folder = await emptyFolder()
      const result = await recoverPlan({ pageMarkdown: scenario.markdown(), truncated: scenario.truncated ?? false, folder, pageUrl: PLAN_PAGE_URL })
      expect(result).toMatchObject({ recovered: false })
      if (!result.recovered) expect(result.reason).toMatch(scenario.reason)
      await assertNothingWritten(folder)
    })
  }

  it('refuses a plan JSON that adds a task absent from the reviewed prose: renderPlan hash differs', async () => {
    const folder = await emptyFolder()
    const pushed = renderPlanBlock({ pageMarkdown: PROSE, plan: PLAN, review: REVIEW, pageTextSha256: pageTextHash(PROSE) })
    const tamperedPlan: Plan = { ...PLAN, tasks: [...PLAN.tasks, { id: 'P9', title: 'sneaked in', kind: 'implementation', featureIds: ['F1'], dependsOn: [], testIds: [], changes: [], commands: [], outcome: 'x' }] }
    const tampered = pushed.replace(/"plan":\s*\{[\s\S]*?\},\s*"review"/, () => `"plan": ${JSON.stringify(tamperedPlan)}, "review"`)

    const result = await recoverPlan({ pageMarkdown: tampered, truncated: false, folder, pageUrl: PLAN_PAGE_URL })
    expect(result).toMatchObject({ recovered: false })
    if (!result.recovered) expect(result.reason).toMatch(/does not match the reviewed plan/i)
    await assertNothingWritten(folder)
  })

  it('reports "the Plan page was edited after planning" and points the Next action at Step 5 when the prose outside the block changed since the push', async () => {
    const folder = await emptyFolder()
    const pushed = renderPlanBlock({ pageMarkdown: PROSE, plan: PLAN, review: REVIEW, pageTextSha256: pageTextHash(PROSE) })
    const editedProse = `${PROSE}\n\nSomeone added a sentence here after the push.\n`
    const edited = pushed.replace(PROSE, editedProse)

    const result = await recoverPlan({ pageMarkdown: edited, truncated: false, folder, pageUrl: PLAN_PAGE_URL })
    expect(result).toMatchObject({ recovered: false })
    if (!result.recovered) {
      expect(result.reason).toMatch(/the plan page was edited after planning/i)
      expect(result.reason).toMatch(/\/aspira-planner KIT-2/)
    }
    await assertNothingWritten(folder)
  })

  it('an unchanged page re-fetched after the push matches both recorded hashes', async () => {
    const pushed = renderPlanBlock({ pageMarkdown: PROSE, plan: PLAN, review: REVIEW, pageTextSha256: pageTextHash(PROSE) })
    pageMarkdown = pushed
    const refetched = await client().pageMarkdown(PLAN_PAGE_ID)
    expect(pageTextHash(refetched.markdown)).toBe(pageTextHash(PROSE))
    expect(sha256(renderPlan(PLAN, 'ready', { specPath: 'specs/cart/spec.md', commit: REPO_COMMIT, dirty: false }, []))).toBe(sha256(renderPlan(PLAN, 'ready', { specPath: 'specs/cart/spec.md', commit: REPO_COMMIT, dirty: false }, [])))
  })
})
