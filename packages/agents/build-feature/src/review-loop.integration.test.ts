// Steps 9 and 10 in the build-feature run (seam S1 with real git and the fake gh): Step 10's repo
// work is committed and pushed before the first review, each review is one /aspira-pr-reviewer
// run whose findings.md the driver counts, a fix subagent may change only the files the findings
// cite and their tests, three reviews per ticket at most across runs, and the release row is
// drafted only when aspira.json names the releases. The findings.md files are literal fixtures.
// KIT-11 plan P5: T31-T33.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BOARD, BRANCH, PR_URL, RELEASES, REPOSITORY, cleanup, ofKind, project, writeStepExport, type Project, type Result } from './driver.test-helper.ts'

const exec = promisify(execFile)
afterAll(cleanup)

const SLOW = 180_000
const high = (n: number, file = 'src/a.ts') => [{ id: `H${n}`, severity: 'high' as const, title: `Review ${n} found the retry never stops`, file }]
const SOURCE = { 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "import { a } from './a.ts'\n", 'src/b.ts': 'export const b = 1\n' }

/** A ticket in In Review: Implementation with its PR open; the run does Step 10 and returns the first review stage. */
async function reviewing(options: { aspira?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const h = await project({ status: 'In Review: Implementation', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, ...options.files }, ...(options.aspira === undefined ? {} : { aspira: options.aspira }) })
  await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
  return { h, review: await toReview(h, await h.start()) }
}

/** Answer Step 10 when it is asked for and return the next review (or whatever stops the run). */
async function toReview(h: Project, from?: Result): Promise<Result> {
  let result = await h.advance({}, from)
  while (result.stage?.stage === 'step10') {
    await h.answer(result.stage, { docs: [], docsToPropagate: 'none' })
    result = await h.advance()
  }
  return result
}

/** A fix that changes the given files and reports no decisions. */
async function fix(h: Project, stage: Result, files: string[]) {
  for (const file of files) await h.write(file, `export const fixed = ${JSON.stringify(file)}\n`)
  await h.answer(stage.stage, { decisions: [], usage: { tokens: 400, wallMs: 15000 } })
}

const reviewSteps = (h: Project, from = 0) => ofKind(h.stages.slice(from), 'step').filter((stage) => stage.step === 'pr-reviewer')
const ghRan = async (h: Project, verb: string) => (await h.ghCalls()).filter(({ args }) => args[0] === 'pr' && args[1] === verb).length

describe('T31 F27 F29: the review loop', () => {
  it('copies pr-review/ to reviews/1/ and reruns the review with --since that copy', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: high(1) })
    const fixStage = await h.advance()
    await fix(h, fixStage, ['src/a.ts'])
    const second = await h.advance()
    const copy = join(h.stateDir, 'reviews', '1')
    const copied = await readFile(join(copy, 'findings.md'), 'utf8').catch(() => '')
    expect({ since: String(second.stage?.command ?? '').includes(`--since ${copy}`), copied: copied.includes('Review 1 found the retry never stops') }).toEqual({ since: true, copied: true })
  }, SLOW)

  it('stops after three reviews with a high left: no pr ready, no move, the finding first in build-summary.md', async () => {
    const { h, review } = await reviewing()
    let stage = review
    for (const n of [1, 2, 3]) {
      await h.report(stage.stage, 'complete', { findings: high(n) })
      stage = await h.advance()
      if (stage.stage?.stage !== 'fix') break
      await fix(h, stage, ['src/a.ts'])
      stage = await h.advance()
    }
    const summary = await h.summary()
    const remaining = summary.indexOf('Review 3 found the retry never stops')
    const secondSection = summary.indexOf('\n## ', summary.indexOf('## ') + 1)
    expect({ end: stage.stage?.stage, reviews: reviewSteps(h).length, ready: await ghRan(h, 'ready'), moves: ofKind(h.stages, 'move').length, first: remaining >= 0 && remaining < secondSection }).toEqual({ end: 'end', reviews: 3, ready: 0, moves: 0, first: true })
  }, SLOW)

  it('runs only two more reviews when an earlier run already recorded one', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: high(1) })
    await h.advance()
    await h.stop()
    const from = h.stages.length
    let stage = await toReview(h, await h.start())
    for (let turn = 0; turn < 8 && stage.stage !== null && stage.stage.stage !== 'end'; turn += 1) {
      if (stage.stage.stage === 'fix') await fix(h, stage, ['src/a.ts'])
      else if (stage.stage.stage === 'step') await h.report(stage.stage, 'complete', { findings: high(turn + 2) })
      else break
      stage = await toReview(h)
    }
    expect(reviewSteps(h, from).length).toBe(2)
  }, SLOW)

  it('marks the PR ready when the second review leaves no critical or high finding', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: high(1) })
    const fixStage = await h.advance()
    await fix(h, fixStage, ['src/a.ts'])
    const second = await h.advance()
    await h.report(second.stage, 'complete', { findings: [{ id: 'L1', severity: 'low', title: 'A name could be clearer', file: 'src/a.ts' }] })
    await h.advance()
    expect(await ghRan(h, 'ready')).toBe(1)
  }, SLOW)
})

describe('T32 F28: the fix subagent stays inside the findings', () => {
  it('pushes nothing and lists src/b.ts as outside the findings when the fix changes it', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: high(1, 'src/a.ts') })
    const fixStage = await h.advance()
    const before = await h.originHead()
    await fix(h, fixStage, ['src/a.ts', 'src/a.test.ts', 'src/b.ts'])
    const end = await h.advance()
    expect({ end: end.stage?.stage, origin: await h.originHead(), listed: (await h.summary()).includes('src/b.ts') }).toEqual({ end: 'end', origin: before, listed: true })
  }, SLOW)
})

describe('T33 F30 F31: Step 10 and the release row', () => {
  const kit = {
    '.changeset/config.json': JSON.stringify({ fixed: [['@aspiralabs/ui', '@aspiralabs/kit']] }),
    'packages/ui/package.json': JSON.stringify({ name: '@aspiralabs/ui', version: '0.6.1' }),
    'packages/ui/src/button.ts': 'export const button = 1\n',
  }
  const changesets = async (h: Project, ref: string, cwd = h.repo) => (await exec('git', ['-C', cwd, 'ls-tree', '-r', '--name-only', ref, '.changeset/'])).stdout.split('\n').filter((path) => path.endsWith('.md'))

  it('pushes one changeset at .changeset/kit-11-x.md before the first review, and still one after a rerun', async () => {
    const { h } = await reviewing({ files: kit })
    const beforeReview = await changesets(h, BRANCH, h.origin)
    await h.stop()
    await toReview(h, await h.start())
    expect({ beforeReview, origin: await changesets(h, BRANCH, h.origin), local: await changesets(h, 'HEAD') }).toEqual({ beforeReview: ['.changeset/kit-11-x.md'], origin: ['.changeset/kit-11-x.md'], local: ['.changeset/kit-11-x.md'] })
  }, SLOW)

  it('refuses a customer line naming the ticket ID and then asks to update the existing row', async () => {
    const { h, review } = await reviewing({ aspira: { board: BOARD, repository: REPOSITORY, releases: RELEASES } })
    await h.report(review.stage, 'complete', { findings: [] })
    const draft = await h.advance()
    await h.answer(draft.stage, { customerLine: 'KIT-11 adds a build summary to every run', existingRow: true })
    const refused = await h.next()
    await h.answer(refused.stage, { customerLine: 'Every build now ends with a summary you can read', existingRow: true })
    const write = await h.next()
    expect({ draft: draft.stage?.stage, refused: refused.stage?.stage === 'release-row' && String(refused.stage.error ?? '').includes('KIT-11'), action: (write.stage?.write as { action?: string } | undefined)?.action }).toEqual({ draft: 'release-row', refused: true, action: 'update' })
  }, SLOW)

  it('skips the release row without releases, says so, and never merges or moves to Ready: Implementation', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: [] })
    const end = await h.advance()
    const skipped = (await h.summary()).split('\n').some((line) => /release/i.test(line) && /skip/i.test(line))
    expect({
      end: end.stage?.stage,
      releaseRows: ofKind(h.stages, 'release-row').length,
      skipped,
      readyImplementation: h.stages.filter((stage) => stage.to === 'Ready: Implementation').length,
      merges: await ghRan(h, 'merge'),
    }).toEqual({ end: 'end', releaseRows: 0, skipped: true, readyImplementation: 0, merges: 0 })
  }, SLOW)
})

// KIT-19 plan P7: T32. The fix report's usage in the shape written before KIT-19, the richer shape
// (model, tool uses, start and end, one entry per subagent the fix launched), and a malformed one:
// each is accepted, the next review runs, and the fix is recorded as before.
describe('KIT-19 T32 F7 F22: fix report usage', () => {
  const SHAPES: { name: string; usage: unknown }[] = [
    { name: 'tokens and wallMs', usage: { tokens: 400, wallMs: 15000 } },
    {
      name: 'richer',
      usage: { tokens: 400, wallMs: 15000, model: 'anthropic/claude-opus-5.5', toolUses: 9, startedAt: '2026-10-12T09:00:00.000Z', endedAt: '2026-10-12T09:00:15.000Z', subagents: [{ label: 'subagent-1', startedAt: '2026-10-12T09:00:01.000Z', endedAt: '2026-10-12T09:00:06.000Z', totalTokens: 300, toolUses: 4, wallMs: 5000 }] },
    },
    { name: 'malformed', usage: { tokens: 'lots', subagents: 'none' } },
  ]
  /** The numbers a recorded usage carries; null for each one it does not. */
  const numbersOf = (usage: unknown) => {
    const parsed = z.looseObject({ tokens: z.unknown(), wallMs: z.unknown() }).safeParse(usage)
    return parsed.success ? { tokens: parsed.data.tokens ?? null, wallMs: parsed.data.wallMs ?? null } : { tokens: null, wallMs: null }
  }

  it('accepts every shape, runs the next review, and records the fix as complete with not-measured numbers for a malformed usage', async () => {
    const outcomes = []
    for (const shape of SHAPES) {
      const { h, review } = await reviewing()
      await h.report(review.stage, 'complete', { findings: high(1) })
      const fixStage = await h.advance()
      await h.write('src/a.ts', 'export const fixed = 1\n')
      await h.answer(fixStage.stage, { decisions: [], usage: shape.usage })
      const next = await h.advance()
      const record = ((await h.state()).steps ?? []).find((step) => step.step === 'fix')
      outcomes.push({ name: shape.name, next: next.stage?.stage === 'step' ? String(next.stage.step) : String(next.stage?.stage), step: record?.step, status: record?.status, ...numbersOf(record?.usage) })
    }
    expect(outcomes).toEqual([
      { name: 'tokens and wallMs', next: 'pr-reviewer', step: 'fix', status: 'complete', tokens: 400, wallMs: 15000 },
      { name: 'richer', next: 'pr-reviewer', step: 'fix', status: 'complete', tokens: 400, wallMs: 15000 },
      { name: 'malformed', next: 'pr-reviewer', step: 'fix', status: 'complete', tokens: null, wallMs: null },
    ])
  }, SLOW)
})
