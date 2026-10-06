import { describe, expect, it } from 'vitest'
import { NOM4_SEED, estimateCost, oneRoundCheck, parseCostSample, renderEstimate } from './estimate.ts'
import { renderCostMarkdown, summarizeUsage, type UsageLine } from './usage.ts'

const line = (i: number, costUsd: number): UsageLine => ({ agent: 'ava', sessionId: `s${i}`, turnId: 't', stepIndex: 0, at: new Date(1_700_000_000_000 + i * 1000).toISOString(), inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd })

// A cost.md as export-review writes it: the fixture for the history.
const costMd = (rounds: number, changedLines: number, calls: number, each: number) =>
  renderCostMarkdown('o/n#1', summarizeUsage(Array.from({ length: calls }, (_, i) => line(i, each))), {}, { rounds, changedLines, packet: null, budget: null })

describe('parseCostSample', () => {
  it('reads the total cost, the calls, the rounds and the changed lines back out of cost.md', () => {
    expect(parseCostSample(costMd(2, 1234, 20, 0.25), 'r1')).toEqual({ label: 'r1', costUsd: 5, rounds: 2, calls: 20, changedLines: 1234 })
  })
  it('is null for a --local cost.md or an older one without a rounds line', () => {
    expect(parseCostSample('# Cost: x\n\nThis review ran with `--local`', 'l')).toBeNull()
    expect(parseCostSample(costMd(0, 1, 2, 0.1), 'old')).toBeNull()
  })
})

describe('estimateCost', () => {
  it('ranges from one round at the cheapest per-round cost to the cap at the dearest, scaled by diff size', () => {
    const samples = [
      { label: 'a', costUsd: 4, rounds: 2, calls: 40, changedLines: 1000 },
      { label: 'b', costUsd: 9, rounds: 3, calls: 90, changedLines: null },
    ]
    const estimate = estimateCost({ changedLines: 2000, maxRounds: 4, seats: 6, samples })
    // a: $2 a round, doubled for a diff twice the size; b: $3 a round, unscaled.
    expect(estimate.perRound).toEqual({ low: 3, high: 4 })
    expect(estimate.low).toBe(3)
    expect(estimate.high).toBe(16)
    expect(estimate.seeded).toBe(false)
    // The scaling is bounded: a tiny diff is not free.
    expect(estimateCost({ changedLines: 1, maxRounds: 1, seats: 6, samples: [samples[0]!] }).perRound.low).toBe(0.5)
  })
  it('seeds from the NOM-4 numbers when the package has no history', () => {
    const estimate = estimateCost({ changedLines: 500, maxRounds: 4, seats: 6, samples: [] })
    expect(estimate.seeded).toBe(true)
    expect(estimate.samples).toEqual([NOM4_SEED])
    expect(estimate.perRound.low).toBeCloseTo(12.57 / 4)
    expect(estimate.high).toBeCloseTo(12.57)
  })
})

describe('renderEstimate', () => {
  it('prints the diff size, the seats and cap, the range, its basis, and the --local line', () => {
    const text = renderEstimate(estimateCost({ changedLines: 500, maxRounds: 4, seats: 6, samples: [] }), 'acme/app#7')
    expect(text).toContain('Estimate for acme/app#7:')
    expect(text).toContain('diff: 500 changed lines')
    expect(text).toContain('seats: 6 reviewers plus Quinn, up to 4 rounds')
    expect(text).toContain('cost: $3.14 to $12.57 ($3.14 to $3.14 a round; a review that settles in two rounds is around $6.29)')
    expect(text).toContain('seeded from nomnomzz PR #2')
    expect(text).toContain("--local costs this session's usage instead of the Gateway")
  })
})

describe('oneRoundCheck', () => {
  const samples = [{ label: 'a', costUsd: 12, rounds: 2, calls: 40, changedLines: 1000 }]
  it('refuses before any model call when one round is estimated above the budget, naming both numbers', () => {
    const check = oneRoundCheck({ changedLines: 1000, seats: 6, samples, maxCostUsd: 1 })
    expect(check).toMatchObject({ exceeds: true, oneRoundUsd: 6, maxCostUsd: 1 })
    expect(check.message).toBe('Refusing to start: one round is estimated at $6.00 for 1,000 changed lines (from 1 previous review), above the --max-cost budget of $1.00. Raise the budget to at least $6.00, or review a smaller diff. No model call was made.')
  })
  it('lets a budget that covers one round through, and says so', () => {
    expect(oneRoundCheck({ changedLines: 1000, seats: 6, samples, maxCostUsd: 10 })).toMatchObject({ exceeds: false, message: 'One round is estimated at $6.00, within the --max-cost budget of $10.00.' })
    expect(oneRoundCheck({ changedLines: 1000, seats: 6, samples, maxCostUsd: null })).toMatchObject({ exceeds: false, message: 'No budget; one round is estimated at $6.00.' })
  })
  it('seeds from NOM-4 when there is no history', () => {
    const check = oneRoundCheck({ changedLines: 500, seats: 6, samples: [], maxCostUsd: 1 })
    expect(check.exceeds).toBe(true)
    expect(check.oneRoundUsd).toBeCloseTo(12.57 / 4)
    expect(check.message).toContain('seeded from the NOM-4 review')
  })
})
