// The review loop down to medium and the merge after it (2026-10-23, from the NOM-38 run): a medium
// finding gets a fix like a high one, the project gate runs again on each fix before the next
// review, a fix that would contradict a ticket decision is asked in chat and handed to the next
// fix, and a review with nothing medium or above left ends in the run's own merge and the move to
// Ready: Implementation. A refused merge stops the run with the PR open and the card where it was.

import { afterAll, describe, expect, it } from 'vitest'
import { BOARD, RELEASES, REPOSITORY, cleanup, ofKind } from './driver.test-helper.ts'
import { SLOW, high, reviewing, fix, reviewSteps, ghRan } from './review-loop.integration.shared.ts'

afterAll(cleanup)

const medium = (n: number) => [{ id: `M${n}`, severity: 'medium' as const, title: `Review ${n} found the counter has no fail-closed test`, file: 'src/a.ts' }]
const GATED = { 'AGENTS.md': '# Project\n\nBefore every pull request, run `pnpm check`.\n' }

describe('the review loop fixes medium findings and gates each fix', () => {
  it('prints a fix for a review that leaves only a medium, and does not mark the PR ready', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: medium(1) })
    const next = await h.advance()
    const findings = (next.stage?.findings ?? []) as { id: string; severity: string }[]
    expect({ stage: next.stage?.stage, findings: findings.map((finding) => `${finding.id}:${finding.severity}`), ready: await ghRan(h, 'ready') }).toEqual({ stage: 'fix', findings: ['M1:medium'], ready: 0 })
  }, SLOW)

  it('runs the project gate on the fix before the next review', async () => {
    const { h, review } = await reviewing({ files: GATED })
    await h.report(review.stage, 'complete', { findings: high(1) })
    await fix(h, await h.advance(), ['src/a.ts'])
    const gate = await h.advance()
    await h.answer(gate.stage!, { results: [{ command: 'pnpm check', exitCode: 0, output: 'ok' }] })
    const second = await h.advance()
    expect({ gate: gate.stage?.stage, commands: gate.stage?.commands, next: second.stage?.step }).toEqual({ gate: 'gate', commands: ['pnpm check'], next: 'pr-reviewer' })
  }, SLOW)

  it('stops on a failing gate after a fix, before the next review', async () => {
    const { h, review } = await reviewing({ files: GATED })
    await h.report(review.stage, 'complete', { findings: high(1) })
    await fix(h, await h.advance(), ['src/a.ts'])
    const gate = await h.advance()
    await h.answer(gate.stage!, { results: [{ command: 'pnpm check', exitCode: 1, output: 'FIX-BROKE-THE-GATE' }] })
    const end = await h.advance()
    expect({ end: end.stage?.stage, reviews: reviewSteps(h).length, tail: (await h.summary()).includes('FIX-BROKE-THE-GATE'), merges: await ghRan(h, 'merge') }).toEqual({ end: 'end', reviews: 1, tail: true, merges: 0 })
  }, SLOW)

  it('asks about a fix that contradicts a ticket decision and hands the answer to the next fix', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: high(1) })
    const first = await h.advance()
    await h.answer(first.stage!, { decisions: [], conflicts: [{ finding: 'H1', decision: 'Q19', why: 'Q19 keeps one 403 message for every token failure.' }], usage: {} })
    const ask = await h.advance()
    await h.answer(ask.stage!, { answer: 'Keep Q19.' })
    const second = await h.advance()
    await h.report(second.stage, 'complete', { findings: high(2) })
    const again = await h.advance()
    expect({
      ask: ask.stage?.stage,
      names: String(ask.stage?.question ?? '').includes('Q19'),
      fix: again.stage?.stage,
      answered: again.stage?.answered,
    }).toEqual({ ask: 'ask', names: true, fix: 'fix', answered: [{ question: ask.stage?.question, answer: 'Keep Q19.' }] })
  }, SLOW)
})

describe('the merge after a clean review', () => {
  it('merges once with a merge commit, moves the card to Ready: Implementation and ends finished', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: [{ id: 'L1', severity: 'low', title: 'A name could be clearer', file: 'src/a.ts' }] })
    const end = await h.advance()
    const merge = ofKind(h.stages, 'merge')[0]
    expect({
      end: end.stage?.stage,
      merges: await ghRan(h, 'merge'),
      run: merge?.run,
      moves: ofKind(h.stages, 'move').map((stage) => `${String(stage.from)} -> ${String(stage.to)}`),
      merged: String(end.stage?.message ?? '').includes('merged the PR'),
    }).toEqual({ end: 'end', merges: 1, run: [`gh pr checks ${String(merge?.pr)} --watch --fail-fast`, `gh pr merge ${String(merge?.pr)} --merge`], moves: ['In Review: Implementation -> Ready: Implementation'], merged: true })
  }, SLOW)

  it('updates the release page entry after the merge, before the move, when aspira.json names releases', async () => {
    const { h, review } = await reviewing({ aspira: { board: BOARD, repository: REPOSITORY, releases: RELEASES } })
    await h.report(review.stage, 'complete', { findings: [{ id: 'L1', severity: 'low', title: 'A name could be clearer', file: 'src/a.ts' }] })
    let stage = await h.advance()
    const order: string[] = []
    for (let turn = 0; turn < 6 && stage.stage?.stage === 'release-row'; turn += 1) {
      const part = String(stage.stage.part)
      order.push(part)
      if (part === 'draft') await h.answer(stage.stage, { customerLine: 'You can now save a recipe for later.', existingRow: false })
      else await h.answer(stage.stage, { done: true })
      stage = await h.advance()
    }
    const merged = ofKind(h.stages, 'release-row').find((candidate) => candidate.part === 'merged')
    expect({
      order,
      end: stage.stage?.stage,
      writes: merged?.notion,
      checklist: String(merged?.instructions ?? '').includes('checked on dev'),
      afterMerge: h.stages.indexOf(merged!) > h.stages.indexOf(ofKind(h.stages, 'merge')[0]!),
      moves: ofKind(h.stages, 'move').map((candidate) => String(candidate.to)),
    }).toEqual({ order: ['draft', 'write', 'merged'], end: 'end', writes: [{ op: 'write', target: 'release-page' }], checklist: true, afterMerge: true, moves: ['Ready: Implementation'] })
  }, SLOW)

  it('stops with the PR open and no move when the merge is refused', async () => {
    const { h, review } = await reviewing()
    await h.report(review.stage, 'complete', { findings: [] })
    const end = await h.advance({ merge: async (stage) => (await h.answer(stage, { error: 'gh pr checks: 1 failing check' }), undefined) })
    expect({ end: end.stage?.stage, moves: ofKind(h.stages, 'move').length, said: (await h.summary()).includes('1 failing check') }).toEqual({ end: 'end', moves: 0, said: true })
  }, SLOW)
})
