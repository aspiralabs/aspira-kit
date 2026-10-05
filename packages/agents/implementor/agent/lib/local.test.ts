import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DEFAULT_REQUIRED } from '@aspiralabs/agent-common/lib/knowledge'
import { afterEach, expect, it } from 'vitest'
import { runLocal, workerBriefTemplate, type LocalResult } from './local.ts'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PROCEDURE = 'agent/skills/aspira-implementor/SKILL.md'
const INSTRUCTIONS = 'agent/instructions.md'

const id = (n: number) => `3e73e59b2258${String(n).padStart(20, '0')}`
const url = (n: number) => `https://app.notion.com/p/${id(n)}`
const header = (title: string, n: number) => `<!-- ${title} · ${url(n)} · fetched 2026-10-05T00:00:00.000Z -->\n\n`
const INDEX = url(1)

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-local-')))
  temps.push(dir)
  // A copy of the agent's own files, so a test can edit them without touching the package.
  const pkg = join(dir, 'pkg')
  await mkdir(join(pkg, 'agent/skills/aspira-implementor'), { recursive: true })
  await cp(join(PACKAGE, PROCEDURE), join(pkg, PROCEDURE))
  await cp(join(PACKAGE, INSTRUCTIONS), join(pkg, INSTRUCTIONS))
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'feat/cart', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await git('config', 'init.defaultBranch', 'main')
  await mkdir(join(repo, 'specs/cart'), { recursive: true })
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'AGENTS.md'), '# Project\n')
  await writeFile(join(repo, 'specs/cart/spec.md'), '# Cart\n\n- [ ] F1: totals\n- [ ] F2: badge\n')
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  const env = { KNOWLEDGE_PAGE: INDEX }
  const spec = join(repo, 'specs/cart/spec.md')
  const work = join(repo, 'specs/cart/implementation')
  const knowledge = join(work, 'implementation.local/knowledge')
  const step = (extra: Partial<Parameters<typeof runLocal>[0]> = {}, envOverride: Record<string, string | undefined> = env) => runLocal({ source: spec, ...extra }, { packageDir: pkg, env: envOverride })
  return { dir, pkg, repo, git, spec, work, knowledge, env, step }
}

async function writeKnowledge(dir: string, options: { topics?: boolean } = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'INDEX.md'), `${header('Engineering', 1)}<page url="${url(2)}">Agent Instructions</page>\n`)
  await writeFile(
    join(dir, 'agent-instructions.md'),
    `${header('Agent Instructions', 2)}TS-001 MUST be typed.\n<table header-row="true">\n<tr><td>Any code change</td><td><mention-page url="${url(10)}"/>, <mention-page url="${url(11)}"/></td></tr>\n</table>\nLessons go to <mention-page url="${url(99)}"/>.\n`,
  )
  await writeFile(join(dir, 'review-verification.md'), `${header('Review Verification', 3)}REV-001 read gotchas.\n`)
  if (options.topics !== false) {
    await writeFile(join(dir, 'common-patterns.md'), `${header('Common Patterns', 10)}CP-001 small functions.\n`)
    await writeFile(join(dir, 'testing-standards.md'), `${header('Testing Standards', 11)}TEST-001 tests first.\n`)
  }
}

function pending(result: LocalResult) {
  if (!result.pending) throw new Error(`expected a pending stage, got ${JSON.stringify(result)}`)
  return result
}
function staged(result: LocalResult) {
  const value = pending(result)
  if (value.stage === 'knowledge') throw new Error('expected a model stage, got knowledge')
  return value
}

const plan = {
  summary: 'Cart totals and badge.',
  tests: [
    { id: 'T1', kind: 'unit', path: 'src/price.test.ts', featureIds: ['F1'], setup: 's', action: 'a', assertions: ['x'] },
    { id: 'T2', kind: 'unit', path: 'src/badge.test.ts', featureIds: ['F2'], setup: 's', action: 'a', assertions: ['y'] },
  ],
  tasks: [
    { id: 'P1', title: 'price tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/price.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest src/price.test.ts'], outcome: 'red' },
    { id: 'P2', title: 'badge tests', kind: 'tests', featureIds: ['F2'], dependsOn: [], testIds: ['T2'], changes: [{ operation: 'create', path: 'src/badge.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest src/badge.test.ts'], outcome: 'red' },
    { id: 'P3', title: 'price', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'modify', path: 'src/price.ts', symbols: ['price'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest src/price.test.ts'], outcome: 'green' },
    { id: 'P4', title: 'badge', kind: 'implementation', featureIds: ['F2'], dependsOn: ['P2'], testIds: ['T2'], changes: [{ operation: 'create', path: 'src/badge.ts', symbols: ['badge'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest src/badge.test.ts'], outcome: 'green' },
    { id: 'P5', title: 'verify', kind: 'verification', featureIds: ['F1', 'F2'], dependsOn: ['P3', 'P4'], testIds: [], changes: [], commands: ['pnpm test'], outcome: 'all green' },
  ],
  checks: [],
  decisions: [],
  gaps: [],
}

it('refuses to start without the Notion rules: the first step is the knowledge stage, with the pages from the agent config', async () => {
  const { step, knowledge, work } = await fixture()
  const first = pending(await step())
  expect(first.stage).toBe('knowledge')
  if (first.stage !== 'knowledge') return
  expect(first.knowledgeDir).toBe(knowledge)
  expect(first.pages.find((p) => p.role === 'index')).toMatchObject({ url: INDEX, file: 'INDEX.md', present: false })
  expect(first.pages.filter((p) => p.role === 'required').map((p) => p.title)).toEqual(DEFAULT_REQUIRED)
  // No prompt is written and no plan stage is offered until the rules are there.
  expect(await readdir(join(work, 'implementation.local')).catch(() => [])).not.toContain('prompts')
  await expect(step({ finish: true })).rejects.toThrow(/knowledge/i)
})

it('takes the required pages from KNOWLEDGE_REQUIRED, as load-knowledge does, and the topic pages from their routing tables', async () => {
  const { step, knowledge } = await fixture()
  const custom = pending(await step({}, { KNOWLEDGE_PAGE: INDEX, KNOWLEDGE_REQUIRED: 'Agent Instructions, Security Rules' }))
  if (custom.stage !== 'knowledge') throw new Error('expected knowledge')
  expect(custom.pages.filter((p) => p.role === 'required').map((p) => p.title)).toEqual(['Agent Instructions', 'Security Rules'])
  expect(custom.config.required).toEqual(['Agent Instructions', 'Security Rules'])

  await writeKnowledge(knowledge, { topics: false })
  const topics = pending(await step())
  if (topics.stage !== 'knowledge') throw new Error('expected knowledge')
  const routed = topics.pages.filter((p) => p.role === 'topic')
  // The two pages in the routing table; the Slop Repo link outside the table is not a topic page.
  expect(routed.map((p) => p.url)).toEqual([url(10), url(11)])
  expect(routed.every((p) => !p.present)).toBe(true)
})

it('builds REQUIRED.md like load-knowledge, then writes a plan prompt that embeds the live bytes of the agent files', async () => {
  const { step, knowledge, pkg, work } = await fixture()
  await writeKnowledge(knowledge)
  const result = staged(await step())
  expect(result.stage).toBe('plan')
  const required = await readFile(join(knowledge, 'REQUIRED.md'), 'utf8')
  expect(required).toContain('# Agent Instructions')
  expect(required.indexOf('# Agent Instructions')).toBeLessThan(required.indexOf('# Review Verification'))
  const task = result.tasks[0]!
  expect(task).toMatchObject({ id: 'plan', agent: 'orchestrator', output: join(work, 'plan.json'), schema: 'PLAN' })
  const prompt = await readFile(task.prompt, 'utf8')
  expect(prompt).toContain(await readFile(join(pkg, PROCEDURE), 'utf8'))
  expect(prompt).toContain(await readFile(join(pkg, INSTRUCTIONS), 'utf8'))
  expect(prompt).toContain(required)
  expect(prompt).toContain(join(knowledge, 'common-patterns.md'))
  expect(prompt).toContain('## 3. Draft the plan')

  // The agent's file changes: the next step's prompt changes with it. Nothing is cached.
  await writeFile(join(pkg, PROCEDURE), `${await readFile(join(pkg, PROCEDURE), 'utf8')}\nA NEW RULE ADDED TODAY.\n`)
  const again = staged(await step())
  expect(await readFile(again.tasks[0]!.prompt, 'utf8')).toContain('A NEW RULE ADDED TODAY.')
})

it('uses the package files when no package is injected', async () => {
  const { spec, knowledge, env } = await fixture()
  await writeKnowledge(knowledge)
  const result = staged(await runLocal({ source: spec }, { env }))
  const prompt = await readFile(result.tasks[0]!.prompt, 'utf8')
  expect(prompt).toContain(await readFile(join(PACKAGE, PROCEDURE), 'utf8'))
})

it('refuses a knowledge folder that changed after the run started', async () => {
  const { step, knowledge } = await fixture()
  await writeKnowledge(knowledge)
  staged(await step())
  await writeFile(join(knowledge, 'common-patterns.md'), `${header('Common Patterns', 10)}CP-001 changed.\n`)
  await expect(step()).rejects.toThrow(/knowledge.*changed/i)
})

it('accepts a --guidelines snapshot instead of live Notion', async () => {
  const { step, dir, knowledge } = await fixture()
  const snapshot = join(dir, 'REQUIRED.md')
  await writeFile(snapshot, '<!-- Required reading -->\n# Agent Instructions\nTS-001.\n')
  const result = staged(await step({ guidelines: snapshot }))
  expect(result.stage).toBe('plan')
  expect(await readFile(join(knowledge, 'REQUIRED.md'), 'utf8')).toBe(await readFile(snapshot, 'utf8'))
})

it('gates a reviewed plan: incomplete is refused, drift is blocked', async () => {
  const { repo, git, env, pkg } = await fixture()
  const review = join(repo, 'specs/cart/plan.review')
  await mkdir(join(review, 'trace'), { recursive: true })
  await writeFile(join(review, 'plan.reviewed.md'), '# Plan\n')
  await writeFile(join(review, 'trace/plan.json'), JSON.stringify(plan))
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(review, 'trace/review.json'), JSON.stringify({ status: 'incomplete', problems: ['no tests for F2'], repoCommit: head }))
  await writeKnowledge(join(review, 'implementation.local/knowledge'))
  const refused = await runLocal({ source: review }, { packageDir: pkg, env })
  expect(refused).toMatchObject({ pending: false, status: 'refused' })
  expect(JSON.stringify(refused)).toContain('no tests for F2')

  await writeFile(join(review, 'trace/review.json'), JSON.stringify({ status: 'ready', problems: [], repoCommit: 'f'.repeat(40) }))
  await writeFile(join(repo, 'src/badge.ts'), 'export const badge = 1\n')
  const blocked = await runLocal({ source: join(review, 'plan.reviewed.md') }, { packageDir: pkg, env })
  expect(blocked).toMatchObject({ pending: false, status: 'blocked' })
  expect(JSON.stringify(blocked)).toContain('src/badge.ts')
})

it('runs the plan in waves: worker briefs from the procedure, schema checks with one retry, commits, verification and an export that records the rules', async () => {
  const { step, knowledge, work, repo, git, pkg } = await fixture()
  await writeKnowledge(knowledge)
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'plan.json'), JSON.stringify(plan))
  await writeFile(join(work, 'plan.md'), '# Plan\n')

  const par = staged(await step())
  expect(par.stage).toBe('parallelize')
  const parPrompt = await readFile(par.tasks[0]!.prompt, 'utf8')
  expect(parPrompt).toContain('## 4. Analyze the plan and decide how to parallelize')
  // The baseline: P1, P2 first; P3, P4 next; P5 last.
  expect(parPrompt).toContain('"P1"')

  // Two lanes writing the same file in one wave is refused.
  const clash = { waves: [{ lanes: [{ id: 'A', tasks: ['P1', 'P3'], worker: true, writeScope: ['src/price.test.ts', 'src/price.ts'], rules: [] }, { id: 'B', tasks: ['P2', 'P4'], worker: true, writeScope: ['src/badge.test.ts', 'src/badge.ts', 'src/price.ts'], rules: [] }] }, { lanes: [{ id: 'V', tasks: ['P5'], worker: false, writeScope: [] }] }] }
  await writeFile(par.tasks[0]!.output, JSON.stringify(clash))
  const retried = staged(await step())
  expect(retried.stage).toBe('parallelize')
  expect(retried.tasks[0]!.error).toContain('src/price.ts')
  expect(retried.tasks[0]!.retry).toBe(true)

  const lanes = { waves: [{ lanes: [{ id: 'A', tasks: ['P1', 'P3'], worker: true, writeScope: ['src/price.test.ts', 'src/price.ts'], rules: ['TS-001 MUST be typed.'] }, { id: 'B', tasks: ['P2', 'P4'], worker: true, writeScope: ['src/badge.test.ts', 'src/badge.ts'], rules: [] }] }, { lanes: [{ id: 'V', tasks: ['P5'], worker: false, writeScope: [] }] }] }
  await writeFile(par.tasks[0]!.output, JSON.stringify(lanes))
  const wave = staged(await step())
  expect(wave).toMatchObject({ stage: 'wave', wave: 1, parallel: true })
  expect(wave.tasks.map((t) => t.id)).toEqual(['wave-1-A', 'wave-1-B'])
  expect(wave.tasks.every((t) => t.agent === 'worker')).toBe(true)
  const brief = await readFile(wave.tasks[0]!.prompt, 'utf8')
  expect(brief).toContain(workerBriefTemplate(await readFile(join(pkg, PROCEDURE), 'utf8')))
  expect(brief).toContain('src/price.ts')
  expect(brief).toContain('TS-001 MUST be typed.')
  expect(brief).toContain(join(knowledge, 'REQUIRED.md'))
  expect(brief).toContain(join(repo, 'AGENTS.md'))
  expect(brief).toContain('"id": "P3"')
  expect(brief).not.toContain('"id": "P4"')

  const report = (task: string) => ({ tasks: [{ id: task, status: 'done' }], filesChanged: [], red: 'failed as planned', green: [{ command: 'vitest', exitCode: 0 }], deviations: [], blockers: [] })
  await writeFile(wave.tasks[0]!.output, JSON.stringify({ ...report('P1'), tasks: [{ id: 'P1', status: 'done' }, { id: 'P3', status: 'done' }] }))
  await writeFile(wave.tasks[1]!.output, '{"tasks": "nope"}')
  const resend = staged(await step())
  expect(resend.tasks.map((t) => t.id)).toEqual(['wave-1-B'])
  expect(resend.tasks[0]!.retry).toBe(true)
  await writeFile(resend.tasks[0]!.output, JSON.stringify({ ...report('P2'), tasks: [{ id: 'P2', status: 'done' }, { id: 'P4', status: 'done' }] }))

  const commit = staged(await step())
  expect(commit).toMatchObject({ stage: 'wave-commit', wave: 1 })
  expect(commit.tasks[0]).toMatchObject({ id: 'wave-1', agent: 'orchestrator', schema: 'WAVE_RESULT' })
  await writeFile(commit.tasks[0]!.output, JSON.stringify({ status: 'committed', commit: 'f'.repeat(40), tasks: [{ id: 'P1', status: 'done' }, { id: 'P2', status: 'done' }, { id: 'P3', status: 'done' }, { id: 'P4', status: 'done' }] }))
  const unknownCommit = staged(await step())
  expect(unknownCommit.tasks[0]!.error).toMatch(/commit/)
  await writeFile(join(repo, 'src/badge.ts'), 'export const badge = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'wave 1')
  const sha = (await git('rev-parse', 'HEAD')).stdout.trim()
  await writeFile(commit.tasks[0]!.output, JSON.stringify({ status: 'committed', commit: sha, tasks: [{ id: 'P1', status: 'done' }, { id: 'P2', status: 'done' }, { id: 'P3', status: 'done' }, { id: 'P4', status: 'done' }] }))

  // Wave 2 has no worker lane: the orchestrator runs it in its commit step.
  const second = staged(await step())
  expect(second).toMatchObject({ stage: 'wave-commit', wave: 2 })
  await writeFile(second.tasks[0]!.output, JSON.stringify({ status: 'committed', commit: sha, tasks: [{ id: 'P5', status: 'done' }] }))

  const verify = staged(await step())
  expect(verify.stage).toBe('verification')
  expect(await readFile(verify.tasks[0]!.prompt, 'utf8')).toContain('## 6. Final verification')
  const features = [{ id: 'F1', tasks: ['P3'], tests: ['T1'], passing: true }, { id: 'F2', tasks: ['P4'], tests: ['T2'], passing: true }]
  await writeFile(verify.tasks[0]!.output, JSON.stringify({ status: 'done', features, deviations: [], blockers: [], assumptions: [] }))
  const noLog = staged(await step())
  expect(noLog.tasks[0]!.error).toContain('implementation.md')
  await writeFile(join(work, 'implementation.md'), '# Implementation\n')
  await writeFile(verify.tasks[0]!.output, JSON.stringify({ status: 'done', features, deviations: [], blockers: [], assumptions: [] }))

  const done = await step()
  expect(done).toMatchObject({ pending: false, status: 'complete' })
  if (done.pending) return
  const exported = JSON.parse(await readFile(done.export!, 'utf8'))
  expect(exported.knowledge.source).toBe('notion')
  expect(exported.knowledge.pages.map((p: { title: string }) => p.title)).toEqual(expect.arrayContaining(['Agent Instructions', 'Review Verification', 'Common Patterns', 'Testing Standards']))
  expect(exported.calls.map((c: { id: string }) => c.id)).toEqual(['plan', 'parallelize', 'wave-1-A', 'wave-1-B', 'wave-1', 'wave-2', 'verification'])
  expect(exported.rejections.parallelize).toHaveLength(1)
  await expect(readdir(join(work, 'implementation.local'))).rejects.toThrow()
})

it('refuses to build on the default branch', async () => {
  const { step, knowledge, work, git } = await fixture()
  await writeKnowledge(knowledge)
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'plan.json'), JSON.stringify(plan))
  const par = staged(await step())
  await writeFile(par.tasks[0]!.output, JSON.stringify({ waves: [{ lanes: [{ id: 'A', tasks: ['P1', 'P2', 'P3', 'P4', 'P5'], worker: false, writeScope: ['src/price.test.ts', 'src/badge.test.ts', 'src/price.ts', 'src/badge.ts'] }] }] }))
  await git('switch', '-q', '-c', 'main')
  await expect(step()).rejects.toThrow(/default branch/)
})

it('--finish exports what exists as incomplete, with the missing stages listed', async () => {
  const { step, knowledge, work } = await fixture()
  await writeKnowledge(knowledge)
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'plan.json'), JSON.stringify(plan))
  staged(await step())
  const done = await step({ finish: true })
  expect(done).toMatchObject({ pending: false, status: 'incomplete' })
  if (done.pending) return
  expect(done.missing.map((m) => m.id)).toContain('parallelize')
})

it('quotes procedure headings verbatim, on one line', async () => {
  const { procedureHeading } = await import('./local.ts')
  const procedure = await readFile(join(PACKAGE, PROCEDURE), 'utf8')
  expect(procedureHeading(procedure, 'Run to completion')).toBe('## Run to completion')
  expect(procedureHeading(procedure, 4)).toBe('## 4. Analyze the plan and decide how to parallelize')
  expect(() => procedureHeading(procedure, 9)).toThrow('## 9.')
})
