// The review plan, pure: what pr-debator does, over the outputs that already exist. One module
// with no Node.js builtin anywhere in its import graph, because pr-debator runs it inside the
// eve workflow body, and eve's workflow bundle refuses a builtin import reached from there.
// local.ts (the --local driver, all fs and git) imports this; never the other way round.

import { z } from 'zod'
import {
  OUTPUT_VALIDATORS,
  SANDBOX_PATHS,
  SEATS,
  checkFindingsPrompt,
  normalizeCounts,
  openingPrompt,
  reviewAgreed,
  reviewDocPrompt,
  roundSettled,
  turnPrompt,
  verdictFrom,
  verifyPrompt,
  writeFindingsPrompt,
  writeReviewPrompt,
  type Counts,
  type OutputKind,
  type PrContext,
  type Reviewer,
  type TurnOutput,
  type Verdict,
  type VerifyOutput,
} from './review.ts'

/** Where a review is: six seats in parallel, Quinn's ruling, the two documents, the two checks. */
export type Stage = 'seats' | 'verifier' | 'documents' | 'checks'

/** One turn the session has to run: who, with which prompt, returning which result. */
export type PlanTask = { id: string; agent: Reviewer; kind: OutputKind; stage: Stage; round: number; prompt: string; error?: string }

/** One turn as it went, for trace/calls.json. */
export type PlanCall = { id: string; agent: Reviewer; stage: Stage; round: number; prompt: string; output?: unknown; error?: string }

/** The stage the session runs next. */
export type PendingPlan = { done: false; stage: Stage; round: number; tasks: PlanTask[] }

/** Every stage has run (or, with finish, is recorded as missing): what pr-debator returns. */
export type DonePlan = {
  done: true
  agreed: boolean
  /** The loop ended because a round had no dispute and no new finding, not at the cap. */
  settled: boolean
  rounds: number
  /** Quinn's sign-off counts, else Nova's; null when neither exists. */
  counts: Counts | null
  /** Computed from the counts; null when there are none, so a missing fix list is never an approve. */
  verdict: Verdict | null
  openPoints: string[]
  rejected: string[]
  duplicates: string[]
  /** Turns that never produced a valid output (only with finish). */
  missing: { id: string; reason: string }[]
  calls: PlanCall[]
}

/** The inputs to one replay of the loop. */
export type PlanInput = {
  pr: PrContext
  maxRounds: number
  /** Record missing turns instead of asking for them. */
  finish: boolean
  /** The raw output of a turn, or undefined when it has none yet. */
  outputs: (id: string) => unknown
  /** A reason a turn's output is unusable before validation (it was not JSON). */
  invalid?: (id: string) => string | undefined
}

const NO_TURN: TurnOutput = { agreed: false, raised: [], disputed: [], openPoints: [], note: '' }
const NO_VERIFY: VerifyOutput = { agreed: false, openPoints: [], rejected: [], duplicates: [], note: '' }

/** Replay pr-debator over the outputs that exist and say what runs next, or what it returned. */
export function planStep(input: PlanInput): PendingPlan | DonePlan {
  const { pr, maxRounds, finish } = input
  const calls: PlanCall[] = []
  const missing: { id: string; reason: string }[] = []

  const resolveTurn = <T>(task: Omit<PlanTask, 'error'>, validator: z.ZodType<T>): { value?: T; task?: PlanTask } => {
    const call = { id: task.id, agent: task.agent, stage: task.stage, round: task.round, prompt: task.prompt }
    let error = input.invalid?.(task.id)
    const raw = input.outputs(task.id)
    if (error === undefined && raw !== undefined) {
      const parsed = validator.safeParse(raw)
      if (parsed.success) {
        calls.push({ ...call, output: parsed.data })
        return { value: parsed.data }
      }
      error = z.prettifyError(parsed.error).slice(0, 2000)
    }
    if (finish) {
      const reason = error === undefined ? 'no output was produced in the session' : `invalid output: ${error}`
      calls.push({ ...call, error: reason })
      missing.push({ id: task.id, reason })
      return {}
    }
    return { task: { ...task, ...(error === undefined ? {} : { error }) } }
  }
  const pendingOf = (results: { task?: PlanTask }[]) => results.flatMap((r) => (r.task === undefined ? [] : [r.task]))

  let round = 0
  let seats: TurnOutput[] = SEATS.map(() => NO_TURN)
  let quinn: VerifyOutput = NO_VERIFY
  let settled = false

  while (round < maxRounds) {
    round += 1
    const turns = SEATS.map((seat) =>
      resolveTurn(
        { id: `round-${round}-${seat}`, agent: seat, kind: 'turn', stage: 'seats', round, prompt: round === 1 ? openingPrompt(seat, pr) : turnPrompt(seat, round, pr) },
        OUTPUT_VALIDATORS.turn,
      ),
    )
    const seatTasks = pendingOf(turns)
    if (seatTasks.length > 0) return { done: false, stage: 'seats', round, tasks: seatTasks }
    seats = turns.map((turn) => turn.value ?? NO_TURN)

    const ruling = resolveTurn({ id: `round-${round}-quinn`, agent: 'quinn', kind: 'verify', stage: 'verifier', round, prompt: verifyPrompt(round, pr) }, OUTPUT_VALIDATORS.verify)
    if (ruling.task !== undefined) return { done: false, stage: 'verifier', round, tasks: [ruling.task] }
    quinn = ruling.value ?? NO_VERIFY

    // Only with finish: a round with a turn missing is the last one. A round where nothing ran never happened.
    if (turns.some((turn) => turn.value === undefined) || ruling.value === undefined) {
      if (turns.every((turn) => turn.value === undefined) && ruling.value === undefined) round -= 1
      break
    }
    // The stopping rule, shared with pr-debator: no dispute and no new finding this round.
    if (roundSettled(seats)) {
      settled = true
      break
    }
  }

  const agreed = reviewAgreed(seats, quinn, settled)
  const last = Math.max(round, 1)
  const findingsDoc = resolveTurn({ id: 'findings', agent: 'nova', kind: 'findings', stage: 'documents', round: last, prompt: writeFindingsPrompt(pr, agreed) }, OUTPUT_VALIDATORS.findings)
  const reviewDoc = resolveTurn({ id: 'review', agent: 'dex', kind: 'doc', stage: 'documents', round: last, prompt: writeReviewPrompt(pr, agreed) }, OUTPUT_VALIDATORS.doc)
  const docTasks = pendingOf([findingsDoc, reviewDoc])
  if (docTasks.length > 0) return { done: false, stage: 'documents', round: last, tasks: docTasks }

  // Quinn signs off the fix list, Nova checks the summary. Quinn's counts win.
  const reviewPath = (pr.paths ?? SANDBOX_PATHS).files.review
  const findingsCheck = resolveTurn({ id: 'check-findings', agent: 'quinn', kind: 'findings', stage: 'checks', round: last, prompt: checkFindingsPrompt(pr) }, OUTPUT_VALIDATORS.findings)
  const reviewCheck = resolveTurn({ id: 'check-review', agent: 'nova', kind: 'doc', stage: 'checks', round: last, prompt: reviewDocPrompt('nova', reviewPath, pr) }, OUTPUT_VALIDATORS.doc)
  const checkTasks = pendingOf([findingsCheck, reviewCheck])
  if (checkTasks.length > 0) return { done: false, stage: 'checks', round: last, tasks: checkTasks }

  const raw = findingsCheck.value?.counts ?? findingsDoc.value?.counts
  const counts = raw === undefined ? null : normalizeCounts(raw)
  return {
    done: true,
    agreed,
    settled,
    rounds: round,
    counts,
    verdict: counts === null ? null : verdictFrom(counts),
    openPoints: agreed ? [] : [...new Set([...seats.flatMap((seat) => seat.openPoints), ...quinn.openPoints])],
    rejected: quinn.rejected,
    duplicates: quinn.duplicates,
    missing,
    calls,
  }
}
