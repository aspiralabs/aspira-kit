import { describe, expect, it } from 'vitest'
import type { PlanTask } from './local.ts'
import { runReviewLoop, type LoopProgress, type LoopResult } from './loop.ts'
import { SEATS, type PrContext } from './review.ts'

const pr: PrContext = { label: 'o/n#1', repoPath: '/workspace/repo' }
const turn = (agreed: boolean, raised: string[] = []) => ({ agreed, raised, disputed: [], openPoints: [], note: 'n' })
const verify = { agreed: true, openPoints: [], rejected: [], duplicates: [], note: 'n' }
const counts = { critical: 0, high: 1, medium: 0, low: 0, info: 0 }

/** A fake model: answers every task, charging `price` per call. */
function fakeSeats(options: { price: number; raiseInRound1?: boolean }) {
  let costUsd = 0
  const ran: string[] = []
  const run = async (tasks: PlanTask[]) =>
    tasks.map((task) => {
      ran.push(task.id)
      costUsd += options.price
      if (task.kind === 'turn') return turn(!(options.raiseInRound1 === true && task.round === 1), options.raiseInRound1 === true && task.round === 1 ? [`${task.agent.toUpperCase()}1.1`] : [])
      if (task.kind === 'verify') return verify
      if (task.kind === 'findings') return { path: '/workspace/findings.md', changed: true, note: 'n', counts }
      return { path: '/workspace/review.md', changed: true, note: 'n' }
    })
  return { run, ran, spent: async () => costUsd }
}

async function drive(loop: AsyncGenerator<LoopProgress, LoopResult>): Promise<{ progress: LoopProgress[]; result: LoopResult }> {
  const progress: LoopProgress[] = []
  for (;;) {
    const next = await loop.next()
    if (next.done) return { progress, result: next.value }
    progress.push(next.value)
  }
}

describe('runReviewLoop', () => {
  it('runs the stages planStep names and ends in one round when nothing is raised or disputed', async () => {
    const seats = fakeSeats({ price: 0.1 })
    const { progress, result } = await drive(runReviewLoop({ pr, maxRounds: 4, run: seats.run, spent: seats.spent, maxCostUsd: null }))
    expect(progress.map((p) => [p.status, p.round])).toEqual([
      ['reviewing', 1],
      ['verifying', 1],
      ['writing documents', 1],
      ['checking documents', 1],
    ])
    expect(seats.ran).toHaveLength(SEATS.length + 1 + 4)
    expect(result).toMatchObject({ done: true, settled: true, agreed: true, rounds: 1, verdict: 'block', stopped: null, missing: [] })
  })

  it('runs a second round when round one raised findings, then settles', async () => {
    const seats = fakeSeats({ price: 0.1, raiseInRound1: true })
    const { result } = await drive(runReviewLoop({ pr, maxRounds: 4, run: seats.run, spent: seats.spent, maxCostUsd: null }))
    expect(result).toMatchObject({ rounds: 2, settled: true, agreed: true })
    expect(seats.ran.filter((id) => id.startsWith('round-2-'))).toHaveLength(SEATS.length + 1)
  })

  it('stops after the stage that crosses the budget and records the rest as missing', async () => {
    // Six seats at $0.3 each: $1.80 after round 1's seats, which crosses a $1.50 budget. Quinn never runs.
    const seats = fakeSeats({ price: 0.3, raiseInRound1: true })
    const { progress, result } = await drive(runReviewLoop({ pr, maxRounds: 4, run: seats.run, spent: seats.spent, maxCostUsd: 1.5 }))
    expect(progress).toHaveLength(1)
    expect(seats.ran).toEqual(SEATS.map((seat) => `round-1-${seat}`))
    expect(result.stopped).toEqual({ reason: 'budget', costUsd: 1.8, maxCostUsd: 1.5 })
    expect(result).toMatchObject({ done: true, agreed: false, rounds: 1, counts: null, verdict: null })
    expect(result.missing.map((m) => m.id)).toEqual(['round-1-quinn', 'findings', 'review', 'check-findings', 'check-review'])
    expect(result.calls.filter((c) => c.error === undefined)).toHaveLength(SEATS.length)
  })
})
