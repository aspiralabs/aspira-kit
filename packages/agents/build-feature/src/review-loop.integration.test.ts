// Steps 9 and 10 in the build-feature run (seam S1 with real git and the fake gh): Step 10's repo
// work is committed and pushed before the first review, each review is one /aspira-pr-reviewer
// run whose findings.md the driver counts, a fix subagent may change only the files the findings
// cite and their tests, three reviews per ticket at most across runs, and the release row is
// drafted only when aspira.json names the releases. The findings.md files are literal fixtures.
// KIT-11 plan P5: T31-T33.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, ofKind } from './driver.test-helper.ts'
import { SLOW, high, reviewing, toReview, fix, reviewSteps, ghRan } from './review-loop.integration.shared.ts'

afterAll(cleanup)

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
