// build-feature's own run status (F5, F20, KIT-2 P23): ready when the run ends finished (the PR is
// reviewed and waits for a human merge); the stopping step's own status when it stops on a step
// result; needs-author when it stops for an approval or a human gate; refused for a Status with no
// row, Dropped or nothing-to-do; blocked for a missing aspira.json, gh or worktree prerequisite;
// incomplete for a failed move, a failed worktree command, --finish before a merge-ready PR, or an
// unexpected error. The run-state words `stopped` and `finished` are internal (run()/stop()'s own
// bookkeeping) and are never themselves reported as the run status.

import type { RunStatus } from '@aspiralabs/agent-common/lib/run-status'

/** Every reason the driver's run()/stop()/finalize() and EndRoute can end on. */
export type BuildStop =
  | { kind: 'finished' }
  | { kind: 'step'; step: string; status: RunStatus }
  | { kind: 'approval' }
  | { kind: 'no-row' }
  | { kind: 'dropped' }
  | { kind: 'nothing-to-do' }
  | { kind: 'aspira-json' }
  | { kind: 'gh' }
  | { kind: 'worktree-prerequisite' }
  | { kind: 'move' }
  | { kind: 'worktree-command' }
  | { kind: 'finish-before-pr' }
  | { kind: 'unexpected-error' }

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
      return { status: 'needs-author' }
    case 'no-row':
    case 'dropped':
    case 'nothing-to-do':
      return { status: 'refused' }
    case 'aspira-json':
    case 'gh':
    case 'worktree-prerequisite':
      return { status: 'blocked' }
    case 'move':
    case 'worktree-command':
    case 'finish-before-pr':
    case 'unexpected-error':
      return { status: 'incomplete' }
    default:
      return assertNever(stop)
  }
}
