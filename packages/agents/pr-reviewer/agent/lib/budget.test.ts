import { describe, expect, it } from 'vitest'
import { budgetCrossed, forgetSpend, maxCostFromEnv, recordSpend, spentSoFar } from './budget.ts'

describe('maxCostFromEnv', () => {
  it('is a positive number of dollars, else no cap', () => {
    expect(maxCostFromEnv({})).toBeNull()
    expect(maxCostFromEnv({ MAX_COST_USD: '4.5' })).toBe(4.5)
    expect(maxCostFromEnv({ MAX_COST_USD: '0' })).toBeNull()
    expect(maxCostFromEnv({ MAX_COST_USD: 'free' })).toBeNull()
  })
})

describe('the spend ledger', () => {
  it('adds priced calls per root session, counts unpriced ones, and is crossed at the budget', () => {
    recordSpend('root', 0.4)
    recordSpend('root', 0.7)
    recordSpend('root', null)
    recordSpend('other', 9)
    expect(spentSoFar('root')).toEqual({ costUsd: 1.1, calls: 3, unpriced: 1 })
    expect(budgetCrossed(spentSoFar('root').costUsd, 1.1)).toBe(true)
    expect(budgetCrossed(spentSoFar('root').costUsd, 2)).toBe(false)
    expect(budgetCrossed(spentSoFar('root').costUsd, null)).toBe(false)
    forgetSpend('root')
    expect(spentSoFar('root')).toEqual({ costUsd: 0, calls: 0, unpriced: 0 })
  })
})
