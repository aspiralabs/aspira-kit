// build-feature's own run status (F5, F20, KIT-2 P23): ready when the run ends finished (the PR is
// reviewed and waits for a human merge); the stopping step's own status when it stops on a step
// result; needs-author when it stops for an approval or a human gate; refused for a Status with no
// row, Dropped or nothing-to-do; blocked for a missing aspira.json, gh or worktree prerequisite;
// incomplete for a failed move, a failed worktree command, --finish before a merge-ready PR, or an
// unexpected error. run-state.ts's own two internal run-end words (its ended field: the run was cut
// short, or it ran to completion) are never themselves reported as this module's run status.

import { z } from 'zod'
import { RUN_STATUSES, type RunStatus } from '@aspiralabs/agent-common/lib/run-status'

/** The stop kinds that need nothing but their name. */
const BARE_STOPS = [
  'finished',
  // needs-author: the run-start approval, or a human gate (a backward move only a human makes).
  'approval',
  'human-gate',
  // refused: the card's Status or the ticket itself.
  'no-row',
  'dropped',
  'nothing-to-do',
  'not-found',
  // blocked: a prerequisite outside the ticket.
  'aspira-json',
  'gh',
  'worktree-prerequisite',
  'cloud-implementor',
  // incomplete.
  'move',
  'worktree-command',
  'finish-before-pr',
  'unsettled',
  'unexpected-error',
] as const

/**
 * Every reason the driver's stop()/finalize() and EndRoute can end on. `step` is the stopping
 * step's own status (an agent step, or Step 8's shared PR check).
 */
export type BuildStop = Bare<(typeof BARE_STOPS)[number]> | { kind: 'step'; step: string; status: RunStatus }
type Bare<Kind> = Kind extends string ? { kind: Kind } : never

/** BuildStop as the run state persists it (a run's end, the stop an ask queue ends on). */
export const buildStopSchema = z.union([z.object({ kind: z.literal('step'), step: z.string(), status: z.enum(RUN_STATUSES) }), z.object({ kind: z.enum(BARE_STOPS) })])

/** The end of an exhaustive switch over a union (TS-008). */
function assertNever(value: never): never {
  throw new Error(`unhandled build stop: ${JSON.stringify(value)}`)
}

/** build-feature's own run status for how the run ended (F5, F20). */
export function buildRunStatus(stop: BuildStop): { status: RunStatus } {
  switch (stop.kind) {
    case 'finished':
      return { status: 'ready' }
    case 'step':
      return { status: stop.status }
    case 'approval':
    case 'human-gate':
      return { status: 'needs-author' }
    case 'no-row':
    case 'dropped':
    case 'nothing-to-do':
    case 'not-found':
      return { status: 'refused' }
    case 'aspira-json':
    case 'gh':
    case 'worktree-prerequisite':
    case 'cloud-implementor':
      return { status: 'blocked' }
    case 'move':
    case 'worktree-command':
    case 'finish-before-pr':
    case 'unsettled':
    case 'unexpected-error':
      return { status: 'incomplete' }
    default:
      return assertNever(stop)
  }
}
