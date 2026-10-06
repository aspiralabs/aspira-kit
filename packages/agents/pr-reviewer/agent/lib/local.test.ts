import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { REVIEW_COMMENT_MARKER } from './github-comment.ts'
import { KnowledgeRequired, knowledgeConfig, planStep, runLocal, workDirFor, type LocalDeps, type LocalInput, type LocalResult, type LocalTask, type PendingPlan } from './local.ts'
import {
  SEATS,
  checkFindingsPrompt,
  openingPrompt,
  reviewDocPrompt,
  turnPrompt,
  verifyPrompt,
  workspacePaths,
  writeFindingsPrompt,
  writeReviewPrompt,
  type PrContext,
} from './review.ts'

const exec = promisify(execFile)
const PACKAGE_DIR = join(import.meta.dirname, '..', '..')

// The folder the session builds from Notion before the first step, in load-knowledge's shape.
const REQUIRED_MD = '# Agent Instructions\n\nREV-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-002 Verify.\n'
async function seedKnowledge(dir: string, required = REQUIRED_MD) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'REQUIRED.md'), required)
  await writeFile(join(dir, 'INDEX.md'), '# Engineering\n\n- [Testing](testing.md)\n')
  await writeFile(join(dir, 'testing.md'), '# Testing\n\nTST-001 Tests first.\n')
}

const turn = (agreed: boolean, openPoints: string[] = [], over: { raised?: string[]; disputed?: string[] } = {}) => ({ agreed, raised: over.raised ?? [], disputed: over.disputed ?? [], openPoints, note: 'n' })
const verify = (agreed: boolean, openPoints: string[] = []) => ({ agreed, openPoints, rejected: ['COLE1.1'], duplicates: [], note: 'n' })
const doc = (path: string) => ({ path, changed: true, note: 'n' })
const counts = (high: number, medium = 0) => ({ critical: 0, high, medium, low: 0, info: 0 })
const findingsOut = (path: string, high: number, medium = 0) => ({ ...doc(path), counts: counts(high, medium) })

describe('planStep', () => {
  const pr: PrContext = { label: 'o/n#1', repoPath: '/w/repo', paths: workspacePaths('/w') }
  const setup = (maxRounds: number) => {
    const outputs = new Map<string, unknown>()
    const plan = (finish = false) => planStep({ pr, maxRounds, finish, outputs: (id) => outputs.get(id) })
    const pending = (): PendingPlan => {
      const next = plan()
      if (next.done) throw new Error('expected a pending stage')
      return next
    }
    return { outputs, plan, pending }
  }

  it('runs six seats, then Quinn, and stops early when all seven agree', () => {
    const { outputs, plan, pending } = setup(4)
    const seats = pending()
    expect(seats).toMatchObject({ stage: 'seats', round: 1 })
    expect(seats.tasks.map((t) => t.id)).toEqual(SEATS.map((seat) => `round-1-${seat}`))
    expect(seats.tasks.map((t) => t.prompt)).toEqual(SEATS.map((seat) => openingPrompt(seat, pr)))
    // Round 1: Ava raises a finding, so the round is not settled and round 2 runs for the rulings to be answered.
    for (const seat of SEATS) outputs.set(`round-1-${seat}`, turn(seat !== 'ava', [], seat === 'ava' ? { raised: ['AVA1.1'] } : {}))

    const quinn = pending()
    expect(quinn).toMatchObject({ stage: 'verifier', round: 1 })
    expect(quinn.tasks).toEqual([expect.objectContaining({ id: 'round-1-quinn', agent: 'quinn', kind: 'verify', prompt: verifyPrompt(1, pr) })])
    outputs.set('round-1-quinn', verify(true))

    const second = pending()
    expect(second).toMatchObject({ stage: 'seats', round: 2 })
    expect(second.tasks.map((t) => t.prompt)).toEqual(SEATS.map((seat) => turnPrompt(seat, 2, pr)))
    // Round 2: every ruling accepted, nothing new: settled, whatever Quinn's flag says.
    for (const seat of SEATS) outputs.set(`round-2-${seat}`, turn(true))
    outputs.set('round-2-quinn', verify(false, ['AVA1.1 waiting for the fix']))

    const docs = pending()
    expect(docs).toMatchObject({ stage: 'documents', round: 2 })
    expect(docs.tasks.map((t) => [t.id, t.agent, t.kind, t.prompt])).toEqual([
      ['findings', 'nova', 'findings', writeFindingsPrompt(pr, true)],
      ['review', 'dex', 'doc', writeReviewPrompt(pr, true)],
    ])
    outputs.set('findings', findingsOut('/w/findings.md', 2))
    outputs.set('review', doc('/w/review.md'))

    const checks = pending()
    expect(checks).toMatchObject({ stage: 'checks', round: 2 })
    expect(checks.tasks.map((t) => [t.id, t.agent, t.kind, t.prompt])).toEqual([
      ['check-findings', 'quinn', 'findings', checkFindingsPrompt(pr)],
      ['check-review', 'nova', 'doc', reviewDocPrompt('nova', '/w/review.md', pr)],
    ])
    outputs.set('check-findings', findingsOut('/w/findings.md', 0, 1))
    outputs.set('check-review', doc('/w/review.md'))

    const done = plan()
    if (!done.done) throw new Error('expected done')
    // Quinn's sign-off counts win over Nova's, and the verdict is arithmetic on them.
    expect(done).toMatchObject({ agreed: true, settled: true, rounds: 2, counts: counts(0, 1), verdict: 'comment', openPoints: [], missing: [], rejected: ['COLE1.1'] })
    expect(done.calls.map((c) => c.id)).toEqual([...SEATS.map((s) => `round-1-${s}`), 'round-1-quinn', ...SEATS.map((s) => `round-2-${s}`), 'round-2-quinn', 'findings', 'review', 'check-findings', 'check-review'])
  })

  it('stops at the round cap without agreement and tells the writers so', () => {
    const { outputs, pending } = setup(2)
    for (const round of [1, 2]) {
      // Ava disputes Quinn every round: the review never settles and runs to the cap.
      for (const seat of SEATS) outputs.set(`round-${round}-${seat}`, turn(seat !== 'ava', seat === 'ava' ? ['AVA1.1 open'] : [], seat === 'ava' ? { disputed: ['AVA1.1'] } : {}))
      outputs.set(`round-${round}-quinn`, verify(false, ['AVA1.1 open', 'IRIS1.2 open']))
    }
    const docs = pending()
    expect(docs).toMatchObject({ stage: 'documents', round: 2 })
    expect(docs.tasks[0]!.prompt).toBe(writeFindingsPrompt(pr, false))
    expect(docs.tasks[0]!.prompt).toContain('## Unresolved')
    expect(docs.tasks[1]!.prompt).toBe(writeReviewPrompt(pr, false))
  })

  it('reports the open points from the seats and Quinn when the cap is hit', () => {
    const { outputs, plan } = setup(1)
    for (const seat of SEATS) outputs.set(`round-1-${seat}`, turn(seat !== 'ava', seat === 'ava' ? ['AVA1.1 open'] : [], seat === 'ava' ? { raised: ['AVA1.1'] } : {}))
    outputs.set('round-1-quinn', verify(false, ['AVA1.1 open', 'IRIS1.2 open']))
    outputs.set('findings', findingsOut('/w/findings.md', 1))
    outputs.set('review', doc('/w/review.md'))
    outputs.set('check-findings', findingsOut('/w/findings.md', 1))
    outputs.set('check-review', doc('/w/review.md'))
    const done = plan()
    if (!done.done) throw new Error('expected done')
    expect(done).toMatchObject({ agreed: false, settled: false, rounds: 1, verdict: 'block', openPoints: ['AVA1.1 open', 'IRIS1.2 open'] })
  })

  it('returns only the tasks still missing or invalid, with the schema error', () => {
    const { outputs, pending } = setup(4)
    for (const seat of SEATS.slice(1)) outputs.set(`round-1-${seat}`, turn(true))
    outputs.set('round-1-ava', { agreed: 'yes', raised: [], disputed: [], openPoints: [], note: '' })
    const retry = pending()
    expect(retry.tasks.map((t) => t.id)).toEqual(['round-1-ava'])
    expect(retry.tasks[0]!.error).toContain('agreed')
  })

  it('with finish, records what is missing and falls back to Nova\'s counts when Quinn\'s check is missing', () => {
    const { outputs, plan } = setup(4)
    for (const seat of SEATS) outputs.set(`round-1-${seat}`, turn(true))
    outputs.set('round-1-quinn', verify(true))
    outputs.set('findings', findingsOut('/w/findings.md', 1))
    outputs.set('review', doc('/w/review.md'))
    outputs.set('check-review', { path: 3 })
    const done = plan(true)
    if (!done.done) throw new Error('expected done')
    expect(done.counts).toEqual(counts(1))
    expect(done.verdict).toBe('block')
    expect(done.missing.map((m) => m.id)).toEqual(['check-findings', 'check-review'])
    expect(done.missing[1]!.reason).toContain('invalid output')
  })

  it('with finish and no fix list at all, computes no verdict rather than a false approve', () => {
    const { outputs, plan } = setup(4)
    for (const seat of SEATS) outputs.set(`round-1-${seat}`, turn(false))
    const done = plan(true)
    if (!done.done) throw new Error('expected done')
    expect(done).toMatchObject({ rounds: 1, agreed: false, counts: null, verdict: null })
    expect(done.missing.map((m) => m.id)).toEqual(['round-1-quinn', 'findings', 'review', 'check-findings', 'check-review'])
  })
})

// ---------------------------------------------------------------------------------------------
// End to end over real git, with the session's subagents simulated by writing their files.

async function gitRepo(options: { knowledge?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pr-review-local-')))
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
  await writeFile(join(repo, 'b.ts'), 'export const b = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'feat: change a')
  const knowledge = join(repo, '.work', 'x', 'pr-review.local', 'knowledge')
  if (options.knowledge !== false) await seedKnowledge(knowledge)
  return { dir, repo, git, knowledge }
}

const FINDINGS_MD = '# Findings: test\n\nTotals: 0 critical · 1 high · 0 medium · 0 low · 0 info\n\n## High\n\n### [AVA1.1] Unchecked input\n- **Location:** `a.ts:1`\n'
const REVIEW_MD = '# Review: test\n\n## What this change does\nChanges a.\n'
const CHECKED_REVIEW_MD = `${REVIEW_MD}\nChecked against the findings.\n`

// What a subagent does: write the files its prompt names, then its JSON result. With handBack, a
// document turn returns its document in the result instead, and Nova's check rewrites the review.
type AnswerOptions = { agreeAt?: number; handBack?: boolean }
async function answer(task: LocalTask, workDir: string, options: AnswerOptions = {}) {
  const agreeAt = options.agreeAt ?? 1
  const round = Number(task.id.match(/^round-(\d+)-/)?.[1] ?? 0)
  const write = (path: string, text: string) => mkdir(join(path, '..'), { recursive: true }).then(() => writeFile(path, text))
  const leave = async (path: string, text: string) => (options.handBack === true ? { document: text } : (await write(path, text), {}))
  let output: unknown
  if (round > 0) {
    await write(join(workDir, 'review', `round-${round}`, `${task.agent}.md`), `## Round ${round} — ${task.agent}\n\nNone.\n`)
    // Before the agreeing round a seat keeps disputing, so the stopping rule does not end the review early.
    output = task.agent === 'quinn' ? verify(round >= agreeAt) : turn(round >= agreeAt, [], round >= agreeAt ? {} : { disputed: [`${task.agent.toUpperCase()}1.1`] })
  } else if (task.id === 'findings') {
    output = { ...findingsOut(join(workDir, 'findings.md'), 1), ...(await leave(join(workDir, 'findings.md'), FINDINGS_MD)) }
  } else if (task.id === 'review') {
    output = { ...doc(join(workDir, 'review.md')), ...(await leave(join(workDir, 'review.md'), REVIEW_MD)) }
  } else if (task.id === 'check-findings') {
    output = { ...findingsOut(join(workDir, 'findings.md'), 1), changed: false }
  } else if (options.handBack === true) {
    output = { ...doc(join(workDir, 'review.md')), document: CHECKED_REVIEW_MD }
  } else {
    output = { ...doc(join(workDir, 'review.md')), changed: false }
  }
  await writeFile(task.output, JSON.stringify(output))
}

async function complete(input: LocalInput, deps: LocalDeps = {}, options: AnswerOptions = {}) {
  for (let step = 0; step < 40; step += 1) {
    const result = await runLocal(input, deps)
    if (!result.pending) return result
    for (const task of result.tasks) await answer(task, result.workDir, options)
  }
  throw new Error('the review never finished')
}

const pending = (result: LocalResult) => {
  if (!result.pending) throw new Error('expected a pending stage')
  return result
}
const finished = (result: LocalResult) => {
  if (result.pending) throw new Error('expected a finished review')
  return result
}

describe('runLocal, local repository', () => {
  it('writes each task\'s exact review.ts prompt, with the sandbox paths mapped to the work directory', async () => {
    const { repo, git } = await gitRepo()
    const first = pending(await runLocal({ source: repo }))
    const work = join(repo, '.work', 'x', 'pr-review.local')
    expect(first).toMatchObject({ stage: 'seats', round: 1, maxRounds: 4, workDir: work })
    expect(first.tasks.map((t) => t.agent)).toEqual([...SEATS])
    const pr: PrContext = {
      label: `${repo} @ feat/x vs main`,
      repoPath: repo,
      knowledgePath: join(work, 'knowledge'),
      knowledgeRequiredFile: join(work, 'knowledge', 'REQUIRED.md'),
      paths: workspacePaths(work),
      packet: await readFile(join(work, 'packet.md'), 'utf8'),
      target: first.target,
      maxSeatCalls: 8,
    }
    expect(first.target).toEqual({ baseSha: await git('rev-parse', 'main'), headSha: await git('rev-parse', 'feat/x'), since: null })
    // The packet: built once, every changed file at HEAD, the required reading, the first thing in every prompt.
    expect(first.packet).toMatchObject({ full: ['a.ts', 'b.ts'], excerpted: [], omitted: [], missing: [] })
    expect(pr.packet).toContain('1 | export const a = 2\n')
    expect(pr.packet).toContain('1 | export const b = 1\n')
    expect(pr.packet).toContain(REQUIRED_MD.trim())
    for (const task of first.tasks) {
      expect(task.output).toBe(join(work, 'outputs', `${task.id}.json`))
      expect(task.schema).toBe('TURN_OUTPUT_SCHEMA')
      const text = await readFile(task.prompt, 'utf8')
      expect(text).toContain(`\n## Task\n\n${openingPrompt(task.agent === 'quinn' ? 'ava' : task.agent, pr)}\n\n## Output schema\n`)
      expect(text).toContain(`# ${task.agent[0]!.toUpperCase()}${task.agent.slice(1)}\n`)
      expect(text).toContain(task.output)
      expect(text).not.toContain('/workspace/')
      expect(text).toContain(`Required reading is ${join(work, 'knowledge', 'REQUIRED.md')}`)
      expect(text).toContain('## Task\n\n# Review packet: ')
      expect(text).toContain('read_files is the Read tool over each path listed')
      // The seat's system prompt is its instructions.md, byte for byte, read on this call.
      expect(text).toContain(`## System\n\n${(await readFile(join(PACKAGE_DIR, 'agent', 'subagents', task.agent, 'instructions.md'), 'utf8')).trim()}\n\n## Task`)
    }
    expect(first.orchestrator).toBe(join(PACKAGE_DIR, 'agent', 'instructions.md'))
    expect(await readFile(join(work, 'pr.patch'), 'utf8')).toContain('b/b.ts')
    expect(await readFile(join(work, 'changed_files.txt'), 'utf8')).toBe('a.ts\nb.ts\n')
    expect(await readFile(join(work, 'pr.md'), 'utf8')).toContain('# feat: change a')
    // The work directory sits inside the reviewed working tree, and must not count as a change to it.
    expect(pending(await runLocal({ source: repo })).tasks).toHaveLength(6)
  })

  it('asks for one retry on a schema rejection, then says the retry is spent', async () => {
    const { repo } = await gitRepo()
    const first = pending(await runLocal({ source: repo }))
    const [ava, ...rest] = first.tasks
    for (const task of rest) await answer(task, first.workDir)
    await writeFile(ava!.output, '{"agreed": "yes", "raised": [], "disputed": [], "openPoints": [], "note": ""}')
    const retry = pending(await runLocal({ source: repo }))
    expect(retry.tasks).toHaveLength(1)
    expect(retry.tasks[0]).toMatchObject({ id: 'round-1-ava', retry: true })
    expect(retry.tasks[0]!.error).toContain('agreed')
    await writeFile(ava!.output, 'not json')
    const spent = pending(await runLocal({ source: repo }))
    expect(spent.tasks[0]).toMatchObject({ id: 'round-1-ava', retry: false })
    expect(spent.tasks[0]!.error).toContain('JSON')
    await answer(ava!, first.workDir)
    expect(pending(await runLocal({ source: repo }))).toMatchObject({ stage: 'verifier', round: 1 })
  })

  it('exports the agent\'s layout into <repo>/.work/<ticket>/pr-review/ and ignores .work/ in git', async () => {
    const { repo } = await gitRepo()
    const done = finished(await complete({ source: repo }))
    const dir = join(repo, '.work', 'x', 'pr-review')
    expect(done).toMatchObject({ status: 'complete', dir, verdict: 'block', counts: counts(1), agreed: true, settled: true, rounds: 1, comment: null })
    expect((await readdir(dir)).sort()).toEqual(['changed_files.txt', 'conversation.md', 'cost.md', 'findings.md', 'pr.md', 'pr.patch', 'review.md', 'trace'])
    // Round one with no dispute and no new finding ends the review in one round: seats + Quinn + the two writers and two checks.
    const reviewed = `Reviewed: base \`${done.target.baseSha}\` → head \`${done.target.headSha}\``
    expect(await readFile(join(dir, 'findings.md'), 'utf8')).toBe(FINDINGS_MD.replace('# Findings: test\n\n', `# Findings: test\n\n${reviewed}\n\n`))
    expect(await readFile(join(dir, 'review.md'), 'utf8')).toContain(`# Review: test\n\n${reviewed}\n\n## What`)
    expect(await readFile(join(dir, 'pr.md'), 'utf8')).toContain(`- ${reviewed}`)
    expect(await readFile(join(dir, 'conversation.md'), 'utf8')).toMatch(/^# Review: .* @ feat\/x vs main\n\n## Round 1 — ava/)
    const costMd = await readFile(join(dir, 'cost.md'), 'utf8')
    expect(costMd).toContain('Claude Code session')
    expect(costMd).toContain('over 1 round of 4 (ended by the stopping rule: a round with no dispute and no new finding)')
    expect(costMd).toMatch(/Packet: [\d,]+ characters, about [\d,]+ tokens/)
    expect(costMd).toContain('Budget: none.')
    expect(costMd).toContain('| ava | 1 | 0 | 1 |')
    expect(costMd).toContain('| quinn | 1 | 1 | 2 |')
    const trace = JSON.parse(await readFile(join(dir, 'trace', 'calls.json'), 'utf8'))
    expect(trace.calls).toHaveLength(SEATS.length + 1 + 4)
    expect(trace.target).toEqual(done.target)
    expect(trace.packet).toEqual(done.packet)
    expect(trace.calls[0]).toMatchObject({ id: 'round-1-ava', agent: 'ava', output: { agreed: true } })
    expect(trace.calls[0].prompt).toContain('You are Ava, the security seat')
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toContain('.work/')
    // The review records the rules it ran under.
    expect(await readFile(join(dir, 'trace', 'guidelines', 'REQUIRED.md'), 'utf8')).toBe(REQUIRED_MD)
    expect(await readFile(join(dir, 'trace', 'guidelines', 'testing.md'), 'utf8')).toContain('TST-001')
    expect(trace.knowledge).toMatchObject({ path: join(repo, '.work', 'x', 'pr-review.local', 'knowledge'), files: ['INDEX.md', 'REQUIRED.md', 'testing.md'] })
    // As the orchestrator, the session reports by the agent's own instructions, read at export.
    expect(done.orchestrator.text).toBe(await readFile(join(PACKAGE_DIR, 'agent', 'instructions.md'), 'utf8'))
    await expect(stat(workDirFor(dir))).rejects.toThrow()
  })

  it('writes the documents that the writers and checkers hand back, once each and in order', async () => {
    const { repo } = await gitRepo()
    let step = pending(await runLocal({ source: repo }))
    while (step.stage !== 'documents') {
      for (const task of step.tasks) await answer(task, step.workDir)
      step = pending(await runLocal({ source: repo }))
    }
    // Only the document turns are told to hand the document back, naming the file the driver writes.
    for (const task of step.tasks) {
      expect(await readFile(task.prompt, 'utf8')).toContain(`Do not write \`${join(step.workDir, `${task.id}.md`)}\` yourself`)
    }
    expect(await readFile(join(step.workDir, 'prompts', 'round-1-ava.md'), 'utf8')).not.toContain('Do not write')
    for (const task of step.tasks) await answer(task, step.workDir, { handBack: true })
    const checks = pending(await runLocal({ source: repo }))
    expect(checks.stage).toBe('checks')
    expect(await readFile(join(checks.workDir, 'findings.md'), 'utf8')).toBe(FINDINGS_MD)
    expect(await readFile(join(checks.workDir, 'review.md'), 'utf8')).toBe(REVIEW_MD)
    expect(await readFile(checks.tasks.find((t) => t.id === 'check-review')!.prompt, 'utf8')).toContain('Do not write')
    for (const task of checks.tasks) await answer(task, checks.workDir, { handBack: true })
    const done = finished(await runLocal({ source: repo }))
    expect(done).toMatchObject({ status: 'complete', verdict: 'block', counts: counts(1) })
    // Nova's checked review wins over Dex's draft: each document is written once, in stage order,
    // and the export stamps the shas under the title of both.
    const stamp = `Reviewed: base \`${done.target.baseSha}\` → head \`${done.target.headSha}\``
    expect(await readFile(join(done.dir, 'review.md'), 'utf8')).toBe(CHECKED_REVIEW_MD.replace('# Review: test\n\n', `# Review: test\n\n${stamp}\n\n`))
    expect(await readFile(join(done.dir, 'findings.md'), 'utf8')).toBe(FINDINGS_MD.replace('# Findings: test\n\n', `# Findings: test\n\n${stamp}\n\n`))
    const trace = JSON.parse(await readFile(join(done.dir, 'trace', 'calls.json'), 'utf8'))
    expect(trace.calls.find((c: { id: string }) => c.id === 'check-review').output).not.toHaveProperty('document')
  })

  it('reviews a branch that is not checked out from its own committed tree', async () => {
    const { repo, git } = await gitRepo()
    await git('checkout', '-q', 'main')
    const first = pending(await runLocal({ source: repo, branch: 'feat/x', base: 'main', maxRounds: 2 }))
    expect(first.maxRounds).toBe(2)
    expect(await readFile(join(first.workDir, 'repo', 'b.ts'), 'utf8')).toBe('export const b = 1\n')
    expect(await readFile(first.tasks[0]!.prompt, 'utf8')).toContain(`The repository is checked out at ${join(first.workDir, 'repo')}.`)
    const done = finished(await complete({ source: repo, branch: 'feat/x', base: 'main' }, {}, { agreeAt: 3 }))
    expect(done).toMatchObject({ agreed: false, rounds: 2, maxRounds: 2 })
  })

  it('exports what exists with --finish and records the missing stages', async () => {
    const { repo } = await gitRepo()
    const first = pending(await runLocal({ source: repo }))
    for (const task of first.tasks) await answer(task, first.workDir)
    const done = finished(await runLocal({ source: repo, finish: true }))
    expect(done).toMatchObject({ status: 'incomplete', verdict: null, counts: null })
    expect(done.missing.map((m) => m.id)).toEqual(['round-1-quinn', 'findings', 'review', 'check-findings', 'check-review'])
    expect(done.missingFiles).toEqual(['findings.md', 'review.md'])
    const trace = JSON.parse(await readFile(join(done.dir, 'trace', 'calls.json'), 'utf8'))
    expect(trace.calls.filter((c: { error?: string }) => c.error !== undefined)).toHaveLength(5)
    await expect(stat(first.workDir)).rejects.toThrow()
  })

  it('refuses to continue when the source changes mid-run', async () => {
    const { repo } = await gitRepo()
    await runLocal({ source: repo })
    await writeFile(join(repo, 'a.ts'), 'export const a = 3\n')
    await expect(runLocal({ source: repo })).rejects.toThrow('changed since this local review started')
  })

  it('refuses a different round cap mid-run and keeps the first one when none is given', async () => {
    const { repo } = await gitRepo()
    await runLocal({ source: repo, maxRounds: 2 })
    await expect(runLocal({ source: repo, maxRounds: 3 })).rejects.toThrow('--max-rounds')
    expect(pending(await runLocal({ source: repo })).maxRounds).toBe(2)
    await expect(runLocal({ source: repo, maxRounds: 11, output: join(repo, 'elsewhere') })).rejects.toThrow('1 to 10')
  })
})

// A stand-in GitHub: the PR, its diff, the token's user and the PR's comments. Every request is recorded.
function fakeGithub(pr: { head: string; base: string; diff: string }) {
  const calls: { method: string; url: string; accept: string | null; auth: string | null; body?: { body: string } }[] = []
  const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, url: String(url), accept: headers.get('accept'), auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const path = String(url).replace('https://api.github.com', '')
    if (path === '/repos/acme/app/pulls/7') {
      if (headers.get('accept') === 'application/vnd.github.diff') return new Response(pr.diff)
      return Response.json({ title: 'Change a', body: 'Body', html_url: 'https://github.com/acme/app/pull/7', user: { login: 'dev' }, base: { ref: 'main', sha: pr.base }, head: { ref: 'feat/x', sha: pr.head } })
    }
    if (path === '/user') return Response.json({ login: 'david' })
    if (method === 'GET' && path.startsWith('/repos/acme/app/issues/7/comments')) return Response.json([])
    if (method === 'POST' && path === '/repos/acme/app/issues/7/comments') return Response.json({ id: 1, html_url: 'https://github.com/acme/app/pull/7#issuecomment-1' })
    return new Response('not found', { status: 404 })
  }
  return { calls, request }
}

async function githubFixture() {
  const { dir, repo, git } = await gitRepo()
  const head = await git('rev-parse', 'feat/x')
  const base = await git('rev-parse', 'main')
  await git('update-ref', 'refs/pull/7/head', head)
  const diff = await git('diff', '--no-color', 'main...feat/x')
  const github = fakeGithub({ head, base, diff: `${diff}\n` })
  const deps: LocalDeps = { fetch: github.request, cloneUrl: () => `file://${repo}`, githubToken: async () => 'tok', packageDir: dir }
  await seedKnowledge(join(dir, 'reviews', `${new Date().toISOString().slice(0, 10)}-feat-x.local`, 'knowledge'))
  return { dir, repo, github, deps, head }
}

describe('runLocal, GitHub PR', () => {
  it('loads the PR from the API, shallow-clones its head, exports to reviews/<date>-<slug>/ and posts the comment', async () => {
    const { dir, repo, github, deps, head } = await githubFixture()
    const first = pending(await runLocal({ source: 'acme/app#7' }, deps))
    const date = new Date().toISOString().slice(0, 10)
    expect(first.workDir).toBe(join(dir, 'reviews', `${date}-feat-x.local`))
    expect(await readFile(join(first.workDir, 'repo', 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect((await exec('git', ['-C', join(first.workDir, 'repo'), 'rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
    expect(await readFile(join(first.workDir, 'changed_files.txt'), 'utf8')).toBe('a.ts\nb.ts\n')
    expect(await readFile(join(first.workDir, 'pr.md'), 'utf8')).toContain('- URL: https://github.com/acme/app/pull/7')
    expect(await readFile(first.tasks[0]!.prompt, 'utf8')).toContain('review of acme/app#7')

    const done = finished(await complete({ source: 'acme/app#7' }, deps))
    expect(done.dir).toBe(join(dir, 'reviews', `${date}-feat-x`))
    expect((await readdir(done.dir)).sort()).toEqual(['changed_files.txt', 'conversation.md', 'cost.md', 'findings.md', 'pr.md', 'pr.patch', 'review.md', 'trace'])
    expect(done.comment).toEqual({ posted: true, action: 'created', url: 'https://github.com/acme/app/pull/7#issuecomment-1' })
    const post = github.calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('https://api.github.com/repos/acme/app/issues/7/comments')
    expect(post?.body?.body.startsWith(REVIEW_COMMENT_MARKER)).toBe(true)
    expect(post?.body?.body).toContain('**Verdict: block**')
    expect(post?.body?.body).toContain(`Reviewed: base \`${await (await exec('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim()}\` → head \`${head}\``)
    expect(post?.body?.body).toContain(`# Review: test\n\nReviewed: base \`${(await exec('git', ['-C', repo, 'rev-parse', 'main'])).stdout.trim()}\` → head \`${head}\`\n\n## What this change does`)
    expect(github.calls.every((c) => c.auth === 'Bearer tok')).toBe(true)
    expect(github.calls.filter((c) => c.method !== 'GET').every((c) => c.url.includes('/repos/acme/app/'))).toBe(true)
  })

  it('does not post with --no-comment, and reports posted false with the reason when there is no token', async () => {
    const quiet = await githubFixture()
    const skipped = finished(await complete({ source: 'https://github.com/acme/app/pull/7', noComment: true }, quiet.deps))
    expect(skipped.comment).toEqual({ posted: false, reason: '--no-comment was given' })
    expect(quiet.github.calls.some((c) => c.method === 'POST' || c.method === 'PATCH')).toBe(false)

    const anonymous = await githubFixture()
    const noToken = finished(await complete({ source: 'acme/app#7' }, { ...anonymous.deps, githubToken: async () => undefined }))
    expect(noToken.comment).toMatchObject({ posted: false })
    expect(noToken.comment?.posted === false && noToken.comment.reason).toContain('token')
    expect(anonymous.github.calls.every((c) => c.auth === null)).toBe(true)
  })

  it('refuses to continue when the PR head moves mid-run', async () => {
    const { deps, github } = await githubFixture()
    await runLocal({ source: 'acme/app#7' }, deps)
    const moved: LocalDeps = {
      ...deps,
      fetch: async (url, init) => {
        const response = await github.request(url, init)
        if (new Headers(init?.headers).get('accept') !== 'application/vnd.github+json' || !String(url).endsWith('/pulls/7')) return response
        const body = await response.json()
        return Response.json({ ...body, head: { ...body.head, sha: 'f'.repeat(40) } })
      },
    }
    await expect(runLocal({ source: 'acme/app#7' }, moved)).rejects.toThrow('changed since this local review started')
  })
})

describe('runLocal, engineering guidelines', () => {
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (cause: unknown) => cause,
    )
    if (!(error instanceof KnowledgeRequired)) throw new Error(`expected a KnowledgeRequired refusal, got ${String(error)}`)
    return error
  }

  it('refuses to start without REQUIRED.md and INDEX.md, and starts nothing', async () => {
    const { repo, knowledge } = await gitRepo({ knowledge: false })
    const missing = await refusal(runLocal({ source: repo }))
    expect(missing.message).toContain('REQUIRED.md')
    expect(missing.plan.dir).toBe(knowledge)
    await expect(stat(join(repo, '.work', 'x', 'pr-review.local', 'state.json'))).rejects.toThrow()

    await mkdir(knowledge, { recursive: true })
    await writeFile(join(knowledge, 'REQUIRED.md'), REQUIRED_MD)
    await writeFile(join(knowledge, 'INDEX.md'), '  \n')
    expect((await refusal(runLocal({ source: repo }))).message).toContain('INDEX.md')

    await writeFile(join(knowledge, 'INDEX.md'), '# Engineering\n')
    await writeFile(join(knowledge, 'REQUIRED.md'), '# Agent Instructions\n\nREV-001\n')
    expect((await refusal(runLocal({ source: repo }))).message).toContain('Review Verification')

    await writeFile(join(knowledge, 'REQUIRED.md'), REQUIRED_MD)
    expect(pending(await runLocal({ source: repo })).stage).toBe('seats')
  })

  it('names the pages to fetch from the agent\'s own load-knowledge configuration', async () => {
    const agentDir = await realpath(await mkdtemp(join(tmpdir(), 'pr-review-agent-')))
    const root = 'https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef'
    await writeFile(join(agentDir, '.env.local'), `AI_GATEWAY_API_KEY=x\nKNOWLEDGE_PAGE=${root}\nNOTION_TOKEN=secret\n`)
    expect(await knowledgeConfig(agentDir, {})).toMatchObject({ root, required: ['Agent Instructions', 'Review Verification'] })
    await writeFile(join(agentDir, '.env.development.local'), 'KNOWLEDGE_REQUIRED="Agent Instructions, Security Rules"\n')
    expect((await knowledgeConfig(agentDir, {})).required).toEqual(['Agent Instructions', 'Security Rules'])
    expect((await knowledgeConfig(agentDir, { KNOWLEDGE_REQUIRED: 'Only This' })).required).toEqual(['Only This'])

    const { repo } = await gitRepo({ knowledge: false })
    const error = await refusal(runLocal({ source: repo }, { agentDir, env: {} }))
    expect(error.plan).toMatchObject({ root, required: ['Agent Instructions', 'Security Rules'], maxDepth: 3, maxPages: 80 })
    expect(JSON.stringify(error.plan)).not.toContain('secret')
    // A REQUIRED.md without a configured required page is refused too.
    await seedKnowledge(join(repo, '.work', 'x', 'pr-review.local', 'knowledge'))
    expect((await refusal(runLocal({ source: repo }, { agentDir, env: {} }))).message).toContain('Security Rules')
  })

  it('puts the knowledge section in every prompt, byte-equal to review.ts for a --knowledge folder', async () => {
    const { repo, dir } = await gitRepo({ knowledge: false })
    const folder = join(dir, 'rules')
    await seedKnowledge(folder)
    const first = pending(await runLocal({ source: repo, knowledge: folder }))
    const work = first.workDir
    const pr: PrContext = { label: `${repo} @ feat/x vs main`, repoPath: repo, knowledgePath: folder, knowledgeRequiredFile: join(folder, 'REQUIRED.md'), paths: workspacePaths(work), packet: await readFile(join(work, 'packet.md'), 'utf8'), target: first.target, maxSeatCalls: 8 }
    for (const task of first.tasks) {
      expect(await readFile(task.prompt, 'utf8')).toContain(`\n## Task\n\n${openingPrompt(task.agent === 'quinn' ? 'ava' : task.agent, pr)}\n\n## Output schema\n`)
    }
    for (const task of first.tasks) await answer(task, work)
    const quinn = pending(await runLocal({ source: repo, knowledge: folder }))
    expect(await readFile(quinn.tasks[0]!.prompt, 'utf8')).toContain(verifyPrompt(1, pr))
    // Later calls keep the folder the run started with; a different one is refused.
    expect(pending(await runLocal({ source: repo })).stage).toBe('verifier')
    await seedKnowledge(join(dir, 'other'))
    await expect(runLocal({ source: repo, knowledge: join(dir, 'other') })).rejects.toThrow('--knowledge')
  })

  it('refuses to continue when the guidelines change mid-run', async () => {
    const { repo, knowledge } = await gitRepo()
    await runLocal({ source: repo })
    await writeFile(join(knowledge, 'testing.md'), '# Testing\n\nTST-001 Tests last.\n')
    await expect(runLocal({ source: repo })).rejects.toThrow('guidelines')
  })
})

describe('runLocal, the agent\'s own sources', () => {
  it('reads each seat\'s instructions.md from the agent on every call', async () => {
    const agentDir = await realpath(await mkdtemp(join(tmpdir(), 'pr-review-agent-')))
    await cp(join(PACKAGE_DIR, 'agent'), join(agentDir, 'agent'), { recursive: true })
    const ava = join(agentDir, 'agent', 'subagents', 'ava', 'instructions.md')
    await writeFile(ava, '# Ava\n\nVersion one of the security seat.\n')
    const { repo } = await gitRepo()
    const first = pending(await runLocal({ source: repo }, { agentDir }))
    expect(await readFile(first.tasks[0]!.prompt, 'utf8')).toContain('## System\n\n# Ava\n\nVersion one of the security seat.\n\n## Task')
    await writeFile(ava, '# Ava\n\nVersion two.\n')
    const again = pending(await runLocal({ source: repo }, { agentDir }))
    const text = await readFile(again.tasks[0]!.prompt, 'utf8')
    expect(text).toContain('Version two.')
    expect(text).not.toContain('Version one')
    expect(again.orchestrator).toBe(join(agentDir, 'agent', 'instructions.md'))
  })
})

describe('runLocal, re-review with --since', () => {
  // A repo that already ignores .work/, as every Aspira project does, so the export changes nothing in the tree.
  async function ignoringRepo() {
    const fixture = await gitRepo()
    await writeFile(join(fixture.repo, '.gitignore'), '.work/\n')
    await fixture.git('add', '.gitignore')
    await fixture.git('commit', '-qm', 'chore: ignore .work')
    return fixture
  }

  it('diffs from the previous head, puts the previous findings in front of the seats, and stamps the shas in all three outputs', async () => {
    const { repo, git } = await ignoringRepo()
    const first = finished(await complete({ source: repo }))
    const previousHead = first.target.headSha
    expect(await readFile(join(first.dir, 'findings.md'), 'utf8')).toContain(`head \`${previousHead}\``)

    // The author pushes a fix: a.ts changes again, b.ts does not.
    await writeFile(join(repo, 'a.ts'), 'export const a = 3 // fixed\n')
    await git('commit', '-qam', 'fix: a')
    const newHead = await git('rev-parse', 'HEAD')
    await seedKnowledge(join(repo, '.work', 'x', 'pr-review.local', 'knowledge'))

    const again = pending(await runLocal({ source: repo, since: first.dir }))
    expect(again.target).toEqual({ baseSha: await git('rev-parse', 'main'), headSha: newHead, since: { sha: previousHead, dir: first.dir } })
    // The delta only: a.ts changed since the previous head, b.ts did not.
    expect(await readFile(join(again.workDir, 'changed_files.txt'), 'utf8')).toBe('a.ts\n')
    expect(await readFile(join(again.workDir, 'pr.patch'), 'utf8')).not.toContain('b.ts')
    expect(await readFile(join(again.workDir, 'previous-findings.md'), 'utf8')).toContain('[AVA1.1] Unchecked input')
    const prompt = await readFile(again.tasks[0]!.prompt, 'utf8')
    expect(prompt).toContain('## Previous findings')
    expect(prompt).toContain('[AVA1.1] Unchecked input')
    expect(prompt).toContain(`This is a re-review. The previous review of this change, in ${first.dir}, was of head \`${previousHead}\``)
    expect(prompt).toContain('raise new findings only on the delta')
    expect(prompt).toContain('### Previous findings\nOne line per finding in the previous fix list')
    // Quinn's and the writers' prompts carry the re-review rules and the stamp line.
    for (const task of again.tasks) await answer(task, again.workDir)
    const quinn = pending(await runLocal({ source: repo, since: first.dir }))
    expect(await readFile(quinn.tasks[0]!.prompt, 'utf8')).toContain(`This is a re-review of \`${previousHead}\`..\`${newHead}\`. Rule on each seat's answer to each previous finding too`)
    await answer(quinn.tasks[0]!, quinn.workDir)
    const docs = pending(await runLocal({ source: repo, since: first.dir }))
    const findingsPrompt = await readFile(docs.tasks[0]!.prompt, 'utf8')
    expect(findingsPrompt).toContain('`## Previous findings`: a table with one row per finding of the previous fix list')
    expect(findingsPrompt).toContain('`## New findings`')
    expect(findingsPrompt).toContain(`Re-review: \`${previousHead}\`..\`${newHead}\` (base \`${await git('rev-parse', 'main')}\`)`)
    expect(await readFile(docs.tasks[1]!.prompt, 'utf8')).toContain(`this was a re-review of \`${previousHead}\`..\`${newHead}\``)

    const done = finished(await complete({ source: repo, since: first.dir }))
    const stamp = `Re-review: \`${previousHead}\`..\`${newHead}\` (base \`${await git('rev-parse', 'main')}\`)`
    expect(await readFile(join(done.dir, 'findings.md'), 'utf8')).toContain(`# Findings: test\n\n${stamp}\n\n`)
    expect(await readFile(join(done.dir, 'review.md'), 'utf8')).toContain(`# Review: test\n\n${stamp}\n\n`)
    expect(await readFile(join(done.dir, 'pr.md'), 'utf8')).toContain(`- ${stamp}`)
    expect((await readdir(done.dir)).sort()).toContain('previous-findings.md')
  })

  it('refuses a previous review with no recorded head, and a branch that has not moved', async () => {
    const { repo, dir } = await ignoringRepo()
    const stale = join(dir, 'old-review')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'findings.md'), '# Findings: x\n\nTotals: 0\n')
    await expect(runLocal({ source: repo, since: stale })).rejects.toThrow('records no head sha')
    await expect(runLocal({ source: repo, since: join(dir, 'nowhere') })).rejects.toThrow('has no findings.md')
    const first = finished(await complete({ source: repo }))
    await seedKnowledge(join(repo, '.work', 'x', 'pr-review.local', 'knowledge'))
    await expect(runLocal({ source: repo, since: first.dir })).rejects.toThrow('has not changed since')
  })
})

describe('runLocal, budget and call cap', () => {
  it('records --max-cost and the call cap in the run, without enforcing a cost it cannot see', async () => {
    const { repo } = await gitRepo()
    const first = pending(await runLocal({ source: repo, maxCost: 3 }, { env: { MAX_SEAT_CALLS: '5' } }))
    expect(await readFile(first.tasks[0]!.prompt, 'utf8')).toContain('You have at most 5 tool calls this round')
    for (const task of first.tasks) await answer(task, first.workDir)
    const done = finished(await complete({ source: repo, maxCost: 3 }, { env: { MAX_SEAT_CALLS: '5' } }))
    expect(await readFile(join(done.dir, 'cost.md'), 'utf8')).toContain('Budget: $3.00 (--max-cost). Not enforced in --local, where no cost is itemized.')
    await expect(runLocal({ source: repo, maxCost: -1 })).rejects.toThrow('--max-cost')
  })
})
