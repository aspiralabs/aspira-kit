import { describe, expect, it } from 'vitest'
import { headShaFromFindings, reviewedLine, stampReviewed, type ReviewTarget } from './target.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const PREV = 'c'.repeat(40)
const fresh: ReviewTarget = { baseSha: BASE, headSha: HEAD, since: null }
const again: ReviewTarget = { baseSha: BASE, headSha: HEAD, since: { sha: PREV, dir: '/r/.work/x/pr-review' } }

describe('reviewedLine', () => {
  it('names the base and head the verdict applies to', () => {
    expect(reviewedLine(fresh)).toBe(`Reviewed: base \`${BASE}\` → head \`${HEAD}\``)
  })
  it('says a re-review is of the previous head to the new one', () => {
    expect(reviewedLine(again)).toBe(`Re-review: \`${PREV}\`..\`${HEAD}\` (base \`${BASE}\`)`)
  })
  it('says when there is no head to record', () => {
    expect(reviewedLine({ baseSha: '', headSha: '', since: null })).toBe('Reviewed: a pasted diff, no base or head sha')
  })
})

describe('stampReviewed', () => {
  it('puts the line under the title once, and leaves a stamped document alone', () => {
    const stamped = stampReviewed('# Findings: o/n#1\n\nTotals: 0 critical\n', fresh)
    expect(stamped).toBe(`# Findings: o/n#1\n\n${reviewedLine(fresh)}\n\nTotals: 0 critical\n`)
    expect(stampReviewed(stamped, fresh)).toBe(stamped)
  })
  it('replaces a stale line the writer put there', () => {
    const stale = `# Review: o/n#1\n\nReviewed: base \`${BASE}\` → head \`${PREV}\`\n\n## What\n`
    expect(stampReviewed(stale, fresh)).toBe(`# Review: o/n#1\n\n${reviewedLine(fresh)}\n\n## What\n`)
  })
  it('prepends when there is no title', () => {
    expect(stampReviewed('Totals: 1 high\n', fresh)).toBe(`${reviewedLine(fresh)}\n\nTotals: 1 high\n`)
  })
})

describe('headShaFromFindings', () => {
  it('reads the head of a fresh review and of a re-review', () => {
    expect(headShaFromFindings(stampReviewed('# Findings: x\n', fresh))).toBe(HEAD)
    expect(headShaFromFindings(stampReviewed('# Findings: x\n', again))).toBe(HEAD)
  })
  it('is null for a findings file with no stamp', () => {
    expect(headShaFromFindings('# Findings: x\n\nTotals: 0\n')).toBeNull()
    expect(headShaFromFindings(stampReviewed('# Findings: x\n', { baseSha: '', headSha: '', since: null }))).toBeNull()
  })
})
