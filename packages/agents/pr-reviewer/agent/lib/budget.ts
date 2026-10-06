// The dollar budget. The usage hook adds every priced model call to the spend of its root
// session (a seat's session names its root through ctx.session.parent); the review loop asks,
// after every call, whether the spend has crossed the budget and stops there. Module state,
// like the call cap: the hook and the workflow steps run in one app process.

export const MAX_COST_ENV = 'MAX_COST_USD'

/** The budget from MAX_COST_USD: a positive number of dollars, else no cap. */
export function maxCostFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const value = Number.parseFloat(env[MAX_COST_ENV] ?? '')
  return Number.isFinite(value) && value > 0 ? value : null
}

const spend = new Map<string, { costUsd: number; calls: number; unpriced: number }>()

/** One model call's reported cost, added to its root session. A null cost is counted but adds nothing. */
export function recordSpend(rootSessionId: string, costUsd: number | null): void {
  const row = spend.get(rootSessionId) ?? { costUsd: 0, calls: 0, unpriced: 0 }
  row.calls += 1
  if (costUsd === null) row.unpriced += 1
  else row.costUsd += costUsd
  spend.set(rootSessionId, row)
}

export function spentSoFar(rootSessionId: string): { costUsd: number; calls: number; unpriced: number } {
  return { ...(spend.get(rootSessionId) ?? { costUsd: 0, calls: 0, unpriced: 0 }) }
}

export function forgetSpend(rootSessionId: string): void {
  spend.delete(rootSessionId)
}

/** True once the spend has reached the budget: the call that crossed it is the last one. */
export function budgetCrossed(costUsd: number, maxCostUsd: number | null): boolean {
  return maxCostUsd !== null && costUsd >= maxCostUsd
}

/** What the loop records when the budget stops it. */
export type BudgetStop = { reason: 'budget'; costUsd: number; maxCostUsd: number }
