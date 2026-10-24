// T1-T4 (plan.json P1): the new agent-common run-status module, which does not exist yet
// (packages/ai/common/src/lib/run-status.ts, added by the implementation wave P14). These
// tests pin down its contract from the spec (spec.reviewed/spec.reviewed.md Decisions Q3/Q3.1,
// Assumptions A1/A2, Acceptance Criteria F1-F7, F12, F53) before any of it exists, so they fail
// for that reason until P14 lands.
//
// Every expected value here is copied from the spec and from the plan's own task description for
// P14 (never recomputed the way the module would compute it, TEST-006):
// - readRunStatus/exitCodeFor table: Decisions Q3.1, Assumption A1 (old-word mapping) and A2
//   (exit codes).
// - boardEffects table: Acceptance Criterion F53 (the exact pushes and moves per skill, verbatim).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GATES, SKILLS, type Skill } from './ticket.ts'
import { MAX_COST_EXIT, NEEDS_AUTHOR_EXIT, RUNNING_EXIT, RUN_STATUSES, USAGE_EXIT, boardEffects, exitCodeFor, readRunStatus, reportHead } from './run-status.ts'

describe('readRunStatus (T1, F1, F2, F3, F7, A1)', () => {
  it('RUN_STATUSES is exactly the five new words, in order', () => {
    expect(RUN_STATUSES).toEqual(['ready', 'needs-author', 'incomplete', 'refused', 'blocked'])
  })

  it('reads each of the five new words as itself, with no reasonCode', () => {
    for (const status of RUN_STATUSES) expect(readRunStatus(status)).toEqual({ status, reasonCode: null })
  })

  it('reads complete, clean and confirmed as ready with no reasonCode (Decision Q3.1)', () => {
    for (const word of ['complete', 'clean', 'confirmed']) expect(readRunStatus(word)).toEqual({ status: 'ready', reasonCode: null })
  })

  it('reads nothing-detected as ready with reasonCode no-analyzers (Decision Q3.1, A1)', () => {
    expect(readRunStatus('nothing-detected')).toEqual({ status: 'ready', reasonCode: 'no-analyzers' })
  })

  it('reads failed and partial as incomplete (A1)', () => {
    for (const word of ['failed', 'partial']) expect(readRunStatus(word)).toEqual({ status: 'incomplete', reasonCode: null })
  })

  it('reads stopped as needs-author with reasonCode paused (A1)', () => {
    expect(readRunStatus('stopped')).toEqual({ status: 'needs-author', reasonCode: 'paused' })
  })

  it('returns null for a word outside both the new and the old statuses, so the caller treats it as incomplete (F6)', () => {
    expect(readRunStatus('finished')).toBeNull()
  })
})

describe('exitCodeFor and the reserved exit codes (T2, F5, A2)', () => {
  it('returns 0 only for ready', () => {
    expect(exitCodeFor('ready')).toBe(0)
    for (const status of RUN_STATUSES) if (status !== 'ready') expect(exitCodeFor(status)).not.toBe(0)
  })

  it('returns 1 for incomplete and blocked (a failure)', () => {
    expect(exitCodeFor('incomplete')).toBe(1)
    expect(exitCodeFor('blocked')).toBe(1)
  })

  it('returns 5 for needs-author: its own non-zero code, distinct from a failure (1), a usage error (2), a refusal (3), a max-cost stop (4) and running (75) (Decision Q4)', () => {
    expect(exitCodeFor('needs-author')).toBe(5)
    expect(NEEDS_AUTHOR_EXIT).toBe(5)
    for (const other of ['incomplete', 'blocked', 'refused', 'ready'] as const) expect(exitCodeFor('needs-author')).not.toBe(exitCodeFor(other))
    for (const reserved of [USAGE_EXIT, MAX_COST_EXIT, RUNNING_EXIT]) expect(exitCodeFor('needs-author')).not.toBe(reserved)
  })

  it('returns 3 for refused', () => {
    expect(exitCodeFor('refused')).toBe(3)
  })

  it('RUNNING_EXIT is 75, USAGE_EXIT is 2 and MAX_COST_EXIT is 4, and none of them is any exitCodeFor value', () => {
    expect(RUNNING_EXIT).toBe(75)
    expect(USAGE_EXIT).toBe(2)
    expect(MAX_COST_EXIT).toBe(4)
    for (const status of RUN_STATUSES) for (const reserved of [RUNNING_EXIT, USAGE_EXIT, MAX_COST_EXIT]) expect(exitCodeFor(status)).not.toBe(reserved)
  })
})

// The exact table of F53, written out literally (never derived from GATES or boardEffects
// itself, TEST-006): every push and move the seven skills make on needs-author and on ready.
// `current` is each skill's own In Progress status (or, for a skill with none, its first accepted
// Status), read from GATES so the test does not hand-copy a value GATES already owns.
type Expected = { pushes: string[]; move: { from: string; to: string } | null }
const current = (skill: Skill): string => GATES[skill].inProgress ?? GATES[skill].accepts[0]!

const needsAuthorTable: Record<Skill, Expected> = {
  groomer: { pushes: ['Grooming Decisions'], move: null },
  'spec-writer': { pushes: ['Spec', 'Spec Reviewed', 'Spec Review Decisions'], move: { from: 'In Progress: Spec', to: 'In Review: Spec' } },
  planner: { pushes: ['Plan'], move: { from: 'In Progress: Plan', to: 'In Review: Plan' } },
  implementor: { pushes: [], move: null },
  'code-analyzer': { pushes: [], move: null },
  'pr-reviewer': { pushes: [], move: null },
}

const readyTable: Record<Skill, Expected> = {
  groomer: { pushes: ['Grooming Decisions'], move: { from: 'Grooming', to: 'Shortlist' } },
  'spec-writer': { pushes: ['Spec', 'Spec Reviewed'], move: { from: 'In Progress: Spec', to: 'In Review: Spec' } },
  planner: { pushes: ['Plan'], move: { from: 'In Progress: Plan', to: 'In Review: Plan' } },
  implementor: { pushes: ['Implementation'], move: { from: 'In Progress: Implementation', to: 'In Review: Implementation' } },
  'code-analyzer': { pushes: [], move: null },
  'pr-reviewer': { pushes: ['PR Review'], move: null },
}

const pushTitles = (effects: { pushes: { title: string }[] }): string[] => effects.pushes.map((push) => push.title).toSorted()

describe('boardEffects (T3, F12, F53)', () => {
  it('on needs-author, every skill makes exactly the F53 pushes and move', () => {
    for (const skill of SKILLS) {
      const effects = boardEffects(skill, 'needs-author', null, current(skill), false)
      const expected = needsAuthorTable[skill]
      expect(pushTitles(effects)).toEqual(expected.pushes.toSorted())
      expect(effects.move).toEqual(expected.move)
    }
  })

  it("the groomer's needs-author round still pushes Grooming Decisions with reasonCode paused, and still makes no move", () => {
    const effects = boardEffects('groomer', 'needs-author', 'paused', current('groomer'), false)
    expect(pushTitles(effects)).toEqual(['Grooming Decisions'])
    expect(effects.move).toBeNull()
  })

  it('on incomplete, refused and blocked, every skill makes no push and no move, including code-analyzer incomplete (formerly partial)', () => {
    for (const skill of SKILLS) {
      for (const status of ['incomplete', 'refused', 'blocked'] as const) {
        const effects = boardEffects(skill, status, null, current(skill), true)
        expect(pushTitles(effects)).toEqual([])
        expect(effects.move).toBeNull()
      }
    }
  })

  it('on ready, every skill makes exactly its success pushes; the implementor moves only when the PR opened; the groomer moves to Shortlist only on ready', () => {
    for (const skill of SKILLS) {
      const expected = readyTable[skill]
      const withoutPr = boardEffects(skill, 'ready', null, current(skill), false)
      expect(pushTitles(withoutPr)).toEqual(expected.pushes.toSorted())
      if (skill === 'implementor') expect(withoutPr.move).toBeNull()
      else expect(withoutPr.move).toEqual(expected.move)
    }
    const implementorWithPr = boardEffects('implementor', 'ready', null, current('implementor'), true)
    expect(implementorWithPr.move).toEqual({ from: 'In Progress: Implementation', to: 'In Review: Implementation' })
  })
})

describe('reportHead (T4, F4, F18)', () => {
  let repo: string
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'reportHead-'))
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, '.env.local'), 'NOTION_TOKEN=ntn_testtoken123\nAPI_SECRET=plainvalue99\n')
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it("a ready record's report is one line, \"Run status: ready\", with no reason line", async () => {
    const report = await reportHead({ status: 'ready', reason: null }, repo)
    expect(report[0]).toBe('Run status: ready')
    expect(report).toHaveLength(1)
  })

  it('a non-ready record reports the status and one reason sentence, with any repository secret redacted', async () => {
    const report = await reportHead({ status: 'blocked', reason: 'NOTION_TOKEN plainvalue99 is not set in apps/web/.env.local' }, repo)
    expect(report[0]).toBe('Run status: blocked')
    expect(report).toHaveLength(2)
    expect(report[1]).toContain('[redacted]')
    expect(report[1]).not.toContain('plainvalue99')
  })
})
