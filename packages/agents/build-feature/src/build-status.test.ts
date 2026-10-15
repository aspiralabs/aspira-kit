// build-status.ts does not exist yet (KIT-2, P23): this file is its contract, pinned from F20 of
// the reviewed spec before any of it exists (TEST-005: the seam is the pure buildRunStatus
// function), so it fails to import until P23 lands it.
//
// F20, quoted (spec.reviewed/spec.reviewed.md): "build-feature's own status is: ready when the run
// ends finished (the PR is reviewed and waits for a human merge); the stopping step's status when
// it stops on a step result; needs-author when it stops for an approval or a human gate; refused
// for a Status with no row, dropped or nothing-to-do; blocked for a missing aspira.json, gh or
// worktree prerequisite; incomplete for a failed move, a failed worktree command, --finish before
// a merge-ready PR, or an unexpected error." The same section: "Its run-state words stopped and
// finished are internal and are not written as a run status."
//
// Every expected status below is copied from that sentence, never recomputed the way the module
// would compute it (TEST-006). BuildStop below is the input shape this test assumes (a
// discriminated union over every reason the driver's stop()/finalize() and EndRoute carry today);
// the implementation task may reshape it, in which case this file is its first reader.

import { describe, expect, it } from 'vitest'
import { buildRunStatus, type BuildStop } from './build-status.ts'

describe('buildRunStatus (T31, F5, F20)', () => {
  it('a finished run (the reviewed PR waiting on a human merge) is ready', () => {
    expect(buildRunStatus({ kind: 'finished' }).status).toBe('ready')
  })

  it("a step stop carries that step's own status, here the planner's needs-author", () => {
    expect(buildRunStatus({ kind: 'step', step: 'planner', status: 'needs-author' }).status).toBe('needs-author')
  })

  it('a stop for an approval or a human gate is needs-author', () => {
    expect(buildRunStatus({ kind: 'approval' }).status).toBe('needs-author')
  })

  it('a Status with no row, Dropped and nothing-to-do are all refused', () => {
    const statuses = (['no-row', 'dropped', 'nothing-to-do'] as const).map((kind) => buildRunStatus({ kind }).status)
    expect(statuses).toEqual(['refused', 'refused', 'refused'])
  })

  it('a missing aspira.json, a missing gh and a missing worktree prerequisite are all blocked', () => {
    const statuses = (['aspira-json', 'gh', 'worktree-prerequisite'] as const).map((kind) => buildRunStatus({ kind }).status)
    expect(statuses).toEqual(['blocked', 'blocked', 'blocked'])
  })

  it('a failed move, a failed worktree command, --finish before a merge-ready PR and an unexpected error are all incomplete', () => {
    const statuses = (['move', 'worktree-command', 'finish-before-pr', 'unexpected-error'] as const).map((kind) => buildRunStatus({ kind }).status)
    expect(statuses).toEqual(['incomplete', 'incomplete', 'incomplete', 'incomplete'])
  })

  it('never reports the run-state words stopped or finished as the run status, across every stop reason', () => {
    const every: BuildStop[] = [
      { kind: 'finished' },
      { kind: 'step', step: 'planner', status: 'needs-author' },
      { kind: 'approval' },
      { kind: 'no-row' },
      { kind: 'dropped' },
      { kind: 'nothing-to-do' },
      { kind: 'aspira-json' },
      { kind: 'gh' },
      { kind: 'worktree-prerequisite' },
      { kind: 'move' },
      { kind: 'worktree-command' },
      { kind: 'finish-before-pr' },
      { kind: 'unexpected-error' },
    ]
    const words = every.map((stop) => buildRunStatus(stop).status)
    expect(words.filter((word) => word === 'stopped' || word === 'finished')).toEqual([])
  })
})
