// SCOOP-7, SCOOP-8: a step subagent called the final `local` again right after a ready export. The run
// directory was gone, so a new run started and its gate read the build's own commits as plan drift,
// rewriting the trace as refused. A call after a ready export, with HEAD where the build left it, now
// answers from that export.

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { runLocal } from './local.ts'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const plan = {
  summary: 'Price.',
  tests: [{ id: 'T1', kind: 'unit', path: 'src/price.test.ts', featureIds: ['F1'], setup: 's', action: 'a', assertions: ['x'] }],
  tasks: [
    { id: 'P1', title: 'price tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/price.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest'], outcome: 'red' },
    { id: 'P2', title: 'price', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'modify', path: 'src/price.ts', symbols: ['price'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest'], outcome: 'green' },
    { id: 'P3', title: 'verify', kind: 'verification', featureIds: ['F1'], dependsOn: ['P2'], testIds: [], changes: [], commands: ['pnpm test'], outcome: 'all green' },
  ],
  checks: [], decisions: [], gaps: [],
}

const id = (n: number) => `3e73e59b2258${String(n).padStart(20, '0')}`
const url = (n: number) => `https://app.notion.com/p/${id(n)}`
const header = (title: string, n: number) => `<!-- ${title} · ${url(n)} · fetched 2026-10-05T00:00:00.000Z -->\n\n`
async function writeKnowledge(dir: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'INDEX.md'), `${header('Engineering', 1)}<page url="${url(2)}">Agent Instructions</page>\n`)
  await writeFile(join(dir, 'agent-instructions.md'), `${header('Agent Instructions', 2)}TS-001 MUST be typed.\n`)
  await writeFile(join(dir, 'review-verification.md'), `${header('Review Verification', 3)}REV-001 read gotchas.\n`)
}

async function built() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-after-export-')))
  temps.push(dir)
  const pkg = join(dir, 'pkg')
  await mkdir(join(pkg, 'agent/skills/aspira-implementor'), { recursive: true })
  for (const file of ['agent/skills/aspira-implementor/SKILL.md', 'agent/instructions.md']) await cp(join(PACKAGE, file), join(pkg, file))
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'main', repo])
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])).stdout.trim()
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  const planned = await git('rev-parse', 'HEAD')
  // The build's own commit: it creates the file P1 plans to create, which a fresh gate reads as drift.
  await writeFile(join(repo, 'src/price.test.ts'), 'test("price", () => {})\n')
  await git('add', '.')
  await git('commit', '-qm', 'P1 tests')
  const head = await git('rev-parse', 'HEAD')
  const review = join(repo, 'specs/cart/plan.review')
  await mkdir(join(review, 'trace'), { recursive: true })
  await writeFile(join(review, 'plan.reviewed.md'), '# Plan\n')
  await writeFile(join(review, 'trace/plan.json'), JSON.stringify(plan))
  await writeFile(join(review, 'trace/review.json'), JSON.stringify({ status: 'ready', problems: [], decisions: [], repoCommit: planned }))
  await writeKnowledge(join(review, 'implementation.local/knowledge'))
  return { pkg, repo, git, review, head, env: { KNOWLEDGE_PAGE: url(1) } }
}

const readyTrace = (review: string, head: string) => JSON.stringify({ mode: 'local', source: { kind: 'plan', path: review }, status: 'ready', reason: null, reasonCode: null, branch: 'feature/kit-1', apps: ['.'], head, calls: [] })

it('answers a call after a ready export from the export, leaving the trace as it was', async () => {
  const { pkg, review, head, env } = await built()
  const tracePath = join(review, 'trace/implementation-local.json')
  await writeFile(tracePath, readyTrace(review, head))
  const result = await runLocal({ source: review }, { packageDir: pkg, env })
  expect(result).toMatchObject({ pending: false, status: 'ready', export: tracePath, branch: 'feature/kit-1', apps: ['.'], head })
  expect(JSON.parse(await readFile(tracePath, 'utf8'))).toMatchObject({ status: 'ready', head })
})

it('starts a new run, gate included, once HEAD has moved past the export', async () => {
  const { pkg, repo, git, review, head, env } = await built()
  await writeFile(join(review, 'trace/implementation-local.json'), readyTrace(review, head))
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 3\n')
  await git('commit', '-qam', 'a human change after the build')
  const result = await runLocal({ source: review }, { packageDir: pkg, env })
  expect(result).toMatchObject({ pending: false, status: 'refused', reasonCode: 'plan-drift' })
})
