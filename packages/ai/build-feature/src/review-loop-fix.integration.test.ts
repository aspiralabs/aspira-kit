// Steps 9 and 10 in the build-feature run (seam S1 with real git and the fake gh): Step 10's repo
// work is committed and pushed before the first review, each review is one /aspira-pr-reviewer
// run whose findings.md the driver counts, a fix subagent may change only the files the findings
// cite and their tests, three reviews per ticket at most across runs, and the release row is
// drafted only when aspira.json names the releases. The findings.md files are literal fixtures.
// KIT-11 plan P5: T31-T33.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BOARD, BRANCH, RELEASES, REPOSITORY, cleanup, ofKind, type Project } from './driver.test-helper.ts'
import { exec, SLOW, high, reviewing, toReview, fix, ghRan } from './review-loop.integration.shared.ts'

afterAll(cleanup)

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

  it('KIT-73: names the test files the branch already changed in the fix stage and pushes a fix that adds a case to one', async () => {
    const suite = 'tests/integration/visibility.test.ts'
    const { h, review } = await reviewing({ files: { [suite]: "import { a } from '../../src/a.ts'\n" } })
    await h.report(review.stage, 'complete', { findings: high(1, 'src/a.ts:27,31') })
    const fixStage = await h.advance()
    const before = await h.originHead()
    await fix(h, fixStage, ['src/a.ts', suite])
    await h.advance()
    const tests = (fixStage.stage?.tests ?? []) as string[]
    expect({ named: tests.includes(suite), told: String(fixStage.stage?.instructions ?? '').includes(suite), pushed: (await h.originHead()) !== before }).toEqual({ named: true, told: true, pushed: true })
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

  it('KIT-52: the write stage carries the log’s What it fixed section under the feature’s heading, and tells the session to put it under the Features table', async () => {
    const { h, review } = await reviewing({ aspira: { board: BOARD, repository: REPOSITORY, releases: RELEASES } })
    const summary = 'Scope: web.\nRuns left no summary.\n\n1. Nobody could read what a build did.\n   - Before: the card went quiet.\n   - Now: every build ends with a summary.\n\nSupporting changes: none\nStill to do: none\nLoose ends: none'
    await mkdir(join(h.folder, 'plan.review'), { recursive: true })
    await writeFile(join(h.folder, 'plan.review/implementation.md'), `# Implementation\n\n## What it fixed\n\n${summary}\n\n## Tasks\n`)
    await h.report(review.stage, 'complete', { findings: [] })
    const draft = await h.advance()
    await h.answer(draft.stage, { customerLine: 'Every build now ends with a summary you can read', existingRow: false })
    const write = await h.next()
    const body = write.stage?.write as { whatItFixed?: string } | undefined
    expect({ section: body?.whatItFixed, instructs: String(write.stage?.instructions ?? '').includes('under the Features table') }).toEqual({ section: `### KIT-11 — what it fixed\n\n${summary}`, instructs: true })
  }, SLOW)

  it('KIT-52: a log without the section carries no whatItFixed and says so', async () => {
    const { h, review } = await reviewing({ aspira: { board: BOARD, repository: REPOSITORY, releases: RELEASES } })
    await h.report(review.stage, 'complete', { findings: [] })
    const draft = await h.advance()
    await h.answer(draft.stage, { customerLine: 'Every build now ends with a summary you can read', existingRow: false })
    const write = await h.next()
    expect({ section: (write.stage?.write as { whatItFixed?: string } | undefined)?.whatItFixed, says: String(write.stage?.instructions ?? '').includes('no `## What it fixed` section') }).toEqual({ section: undefined, says: true })
  }, SLOW)

  it('skips the release row without releases, says so, then merges once and moves the card to Ready: Implementation', async () => {
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
    }).toEqual({ end: 'end', releaseRows: 0, skipped: true, readyImplementation: 1, merges: 1 })
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
