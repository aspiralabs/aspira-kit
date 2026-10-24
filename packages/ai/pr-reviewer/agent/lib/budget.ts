// The dollar budget, pure: what the budget is and when it is crossed. lib/loop.ts asks after every
// stage, inside the eve workflow body, so nothing here may import a Node.js builtin. The spend
// itself is kept by spend-ledger.ts, on the host, which only the usage hook and a "use step" touch.

export const MAX_COST_ENV = 'MAX_COST_USD'

/** The budget from MAX_COST_USD: a positive number of dollars, else no cap. */
export function maxCostFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const value = Number.parseFloat(env[MAX_COST_ENV] ?? '')
  return Number.isFinite(value) && value > 0 ? value : null
}

/** True once the spend has reached the budget: the call that crossed it is the last one. */
export function budgetCrossed(costUsd: number, maxCostUsd: number | null): boolean {
  return maxCostUsd !== null && costUsd >= maxCostUsd
}

/** What the loop records when the budget stops it. */
export type BudgetStop = { reason: 'budget'; costUsd: number; maxCostUsd: number }
