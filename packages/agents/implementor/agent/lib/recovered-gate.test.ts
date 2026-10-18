// T52: the implementor's --local gate on a recovered plan (F36). A review.json carrying
// `recoveredFrom` (the plan.json and gate fields were rebuilt from the Plan page's fenced block,
// not produced by this machine's own planner run) needs a stronger check than an ordinary reviewed
// plan: the card's live ticket.md Status must read "Ready: Plan" and the recorded repoCommit must
// be an ancestor of HEAD, and the accepted run's report must say the plan was recovered from Notion.

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderTicketMd } from '@aspiralabs/agent-common/lib/ticket'
import { afterEach, describe, expect, it } from 'vitest'
import { runLocal, type LocalResult } from './local.ts'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PROCEDURE = 'agent/skills/aspira-implementor/SKILL.md'
const INSTRUCTIONS = 'agent/instructions.md'

const id = (n: number) => `3e73e59b2258${String(n).padStart(20, '0')}`
const url = (n: number) => `https://app.notion.com/p/${id(n)}`
const header = (title: string, n: number) => `<!-- ${title} · ${url(n)} · fetched 2026-10-05T00:00:00.000Z -->\n\n`
const INDEX = url(1)
const PLAN_PAGE = 'https://app.notion.com/p/3e73e59b2258plan0000000000000000'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

// A minimal valid plan: one feature, one test task, one implementation task, one verification task.
const plan = {
  summary: 'Price.',
  tests: [{ id: 'T1', kind: 'unit', path: 'src/price.test.ts', featureIds: ['F1'], setup: 's', action: 'a', assertions: ['x'] }],
  tasks: [
    { id: 'P1', title: 'price tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/price.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest src/price.test.ts'], outcome: 'red' },
    { id: 'P2', title: 'price', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'modify', path: 'src/price.ts', symbols: ['price'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest src/price.test.ts'], outcome: 'green' },
    { id: 'P3', title: 'verify', kind: 'verification', featureIds: ['F1'], dependsOn: ['P2'], testIds: [], changes: [], commands: ['pnpm test'], outcome: 'all green' },
  ],
  checks: [],
  decisions: [],
  gaps: [],
}

async function writeKnowledge(dir: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'INDEX.md'), `${header('Engineering', 1)}<page url="${url(2)}">Agent Instructions</page>\n`)
  await writeFile(
    join(dir, 'agent-instructions.md'),
    `${header('Agent Instructions', 2)}TS-001 MUST be typed.\n<table header-row="true">\n<tr><td>Any code change</td><td><mention-page url="${url(10)}"/>, <mention-page url="${url(11)}"/></td></tr>\n</table>\nLessons go to <mention-page url="${url(99)}"/>.\n`,
  )
  await writeFile(join(dir, 'review-verification.md'), `${header('Review Verification', 3)}REV-001 read gotchas.\n`)
  await writeFile(join(dir, 'common-patterns.md'), `${header('Common Patterns', 10)}CP-001 small functions.\n`)
  await writeFile(join(dir, 'testing-standards.md'), `${header('Testing Standards', 11)}TEST-001 tests first.\n`)
  await writeFile(join(dir, 'approved-technologies.md'), `${header('Approved Technologies', 12)}| Name | Status |\n| --- | --- |\n| Zod | Adopt |\n`)
}

/** A temp git repository with two commits, so a review.json can cite the first as an ancestor of HEAD. */
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-plan-gate-')))
  temps.push(dir)
  const pkg = join(dir, 'pkg')
  await mkdir(join(pkg, 'agent/skills/aspira-implementor'), { recursive: true })
  await cp(join(PACKAGE, PROCEDURE), join(pkg, PROCEDURE))
  await cp(join(PACKAGE, INSTRUCTIONS), join(pkg, INSTRUCTIONS))
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'main', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'AGENTS.md'), '# Project\n')
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  const ancestor = (await git('rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 2\n')
  await git('add', '.')
  await git('commit', '-qm', 'second')
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()
  const env = { KNOWLEDGE_PAGE: INDEX }
  const review = join(repo, 'specs/cart/plan.review')
  await mkdir(join(review, 'trace'), { recursive: true })
  await writeFile(join(review, 'plan.reviewed.md'), '# Plan\n')
  await writeFile(join(review, 'trace/plan.json'), JSON.stringify(plan))
  await writeKnowledge(join(review, 'implementation.local/knowledge'))
  return { dir, pkg, repo, git, env, review, ancestor, head }
}

async function writeTicket(folder: string, status: string) {
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'ticket.md'),
    renderTicketMd({ id: 'KIT-2', title: 'Recovered plan', url: 'https://www.notion.so/kit-2', status, type: 'Feature', area: [], idea: 'Idea.', pulledAt: '2026-10-15T09:00:00.000Z', pages: {} }),
  )
}

async function writeReview(review: string, extra: Record<string, unknown>) {
  await writeFile(join(review, 'trace/review.json'), JSON.stringify({ status: 'ready', problems: [], decisions: [], recoveredFrom: PLAN_PAGE, ...extra }))
}

function pending(result: LocalResult) {
  if (!result.pending) throw new Error(`expected a pending stage, got ${JSON.stringify(result)}`)
  return result
}

describe('the implementor --local gate on a recovered plan', () => {
  it('accepts Ready: Plan with an ancestor commit and reports the plan was recovered from Notion', async () => {
    const { repo, env, pkg, review, ancestor } = await fixture()
    await writeTicket(dirname(review), 'Ready: Plan')
    await writeReview(review, { repoCommit: ancestor })

    const result = pending(await runLocal({ source: review }, { packageDir: pkg, env }))
    expect(result.stage).toBe('parallelize')
    const prompt = await readFile(result.tasks[0]!.prompt, 'utf8')
    // The recovered-from-Notion notice the gate records: the Plan page's own URL verbatim, and the
    // word "recovered" framing it, both land in the facts every later stage's prompt embeds.
    expect(prompt).toContain(PLAN_PAGE)
    expect(prompt).toMatch(/recovered/i)
    void repo
  })

  it('refuses a recovered plan whose live ticket.md Status is not Ready: Plan', async () => {
    const { env, pkg, review, ancestor } = await fixture()
    await writeTicket(dirname(review), 'In Review: Plan')
    await writeReview(review, { repoCommit: ancestor })

    const result = await runLocal({ source: review }, { packageDir: pkg, env })
    expect(result).toMatchObject({ pending: false, status: 'refused' })
    expect(JSON.stringify(result)).toMatch(/ready: plan/i)
  })

  it('refuses a recovered plan whose repoCommit is not an ancestor of HEAD', async () => {
    const { env, pkg, review } = await fixture()
    await writeTicket(dirname(review), 'Ready: Plan')
    await writeReview(review, { repoCommit: 'f'.repeat(40) })

    const result = await runLocal({ source: review }, { packageDir: pkg, env })
    expect(result).toMatchObject({ pending: false, status: 'refused' })
    expect(JSON.stringify(result)).toMatch(/ancestor/i)
  })
})
