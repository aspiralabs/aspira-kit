// The review loop pr-debator runs, as one generator over plan.ts: the same stages, task ids,
// prompts and stopping rule as --local, with the model calls behind a callback. Pure, like
// plan.ts: it runs inside the eve workflow body, where no Node.js builtin may be imported. Between stages
// it asks what the run has cost and stops at the budget, exporting what exists as incomplete.

import { budgetCrossed, type BudgetStop } from './budget.ts'
import { planStep, type DonePlan, type PendingPlan, type PlanTask } from './plan.ts'
import type { PrContext } from './review.ts'

export type LoopInput = {
  pr: PrContext
  maxRounds: number
  /** Run one stage's tasks, in parallel, and return each task's raw output in order. */
  run: (tasks: PlanTask[]) => Promise<unknown[]>
  /** What the run has cost so far, in USD. Asked after every stage. */
  spent: () => Promise<number>
  maxCostUsd: number | null
  /**
   * Run once before the first seat stage: one call that writes the shared prefix to the provider's
   * cache, so the six parallel seats that follow read it instead of each writing its own copy.
   */
  warm?: () => Promise<void>
}

export type LoopProgress = { status: string; stage: PendingPlan['stage']; round: number; maxRounds: number }

export type LoopResult = DonePlan & { stopped: BudgetStop | null }

const STATUS: Record<PendingPlan['stage'], string> = {
  seats: 'reviewing',
  verifier: 'verifying',
  documents: 'writing documents',
  checks: 'checking documents',
}

/** Run the review to the end, or to the budget. Yields one progress line per stage. */
export async function* runReviewLoop(input: LoopInput): AsyncGenerator<LoopProgress, LoopResult> {
  const outputs = new Map<string, unknown>()
  const read = (id: string) => outputs.get(id)
  let stopped: BudgetStop | null = null
  let warmed = false
  for (;;) {
    const plan = planStep({ pr: input.pr, maxRounds: input.maxRounds, finish: false, outputs: read })
    if (plan.done) return { ...plan, stopped }
    if (!warmed && input.warm !== undefined) {
      yield { status: 'warming the cache', stage: plan.stage, round: plan.round, maxRounds: input.maxRounds }
      await input.warm()
      warmed = true
    }
    yield { status: STATUS[plan.stage], stage: plan.stage, round: plan.round, maxRounds: input.maxRounds }
    const results = await input.run(plan.tasks)
    plan.tasks.forEach((task, i) => outputs.set(task.id, results[i]))
    // The budget: the stage that crossed it is the last one. What exists is exported as incomplete.
    const costUsd = await input.spent()
    if (budgetCrossed(costUsd, input.maxCostUsd)) {
      stopped = { reason: 'budget', costUsd, maxCostUsd: input.maxCostUsd ?? 0 }
      break
    }
  }
  const plan = planStep({ pr: input.pr, maxRounds: input.maxRounds, finish: true, outputs: read })
  if (!plan.done) throw new Error('planStep with finish never returns a pending stage')
  return { ...plan, stopped }
}
