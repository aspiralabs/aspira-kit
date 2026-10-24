import { describe, expect, it } from 'vitest'
import { budgetCrossed, maxCostFromEnv } from './budget.ts'
import { forgetSpend, recordSpend, spentSoFar } from './spend-ledger.ts'

describe('maxCostFromEnv', () => {
  it('is a positive number of dollars, else no cap', () => {
    expect(maxCostFromEnv({})).toBeNull()
    expect(maxCostFromEnv({ MAX_COST_USD: '4.5' })).toBe(4.5)
    expect(maxCostFromEnv({ MAX_COST_USD: '0' })).toBeNull()
    expect(maxCostFromEnv({ MAX_COST_USD: 'free' })).toBeNull()
  })
})

describe('the spend ledger', () => {
  it('adds priced calls per root session on disk, counts unpriced ones, and is crossed at the budget', async () => {
    const root = `test-${process.pid}-${Date.now()}`
    await forgetSpend(root)
    await recordSpend(root, 0.4)
    await recordSpend(root, 0.7)
    await recordSpend(root, null)
    await recordSpend(`${root}-other`, 9)
    expect(await spentSoFar(root)).toEqual({ costUsd: 1.1, calls: 3, unpriced: 1 })
    expect(budgetCrossed((await spentSoFar(root)).costUsd, 1.1)).toBe(true)
    expect(budgetCrossed((await spentSoFar(root)).costUsd, 2)).toBe(false)
    expect(budgetCrossed((await spentSoFar(root)).costUsd, null)).toBe(false)
    await forgetSpend(root)
    await forgetSpend(`${root}-other`)
    expect(await spentSoFar(root)).toEqual({ costUsd: 0, calls: 0, unpriced: 0 })
  })
})
