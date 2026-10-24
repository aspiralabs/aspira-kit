// A correction pass answers with only what it changes (planPatchSchema); applyPlanPatch merges it.
import { describe, expect, it } from 'vitest'
import { applyPlanPatch, planPatchSchema, type Plan } from './plan.ts'

const plan: Plan = {
  summary: 'Persist a named item.',
  tasks: [
    { id: 'P1', title: 'Tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 't.test.ts', symbols: ['cases'], instructions: 'Add cases.', evidence: ['a.ts:1'] }], commands: ['pnpm test'], outcome: 'Fails first.' },
    { id: 'P2', title: 'Build', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'modify', path: 'a.ts', symbols: ['save'], instructions: 'Persist.', evidence: ['a.ts:1'] }], commands: [], outcome: 'Passes.' },
    { id: 'P3', title: 'Verify', kind: 'verification', featureIds: ['F1'], dependsOn: ['P2'], testIds: ['T1'], changes: [], commands: ['pnpm test'], outcome: 'Green.' },
  ],
  tests: [{ id: 'T1', kind: 'unit', path: 't.test.ts', featureIds: ['F1'], setup: 'none', action: 'save', assertions: ['saved'] }],
  checks: [{ rule: 'REV-001', evidence: 'a.ts:1' }],
  decisions: [],
  gaps: [],
}

describe('applyPlanPatch', () => {
  it('replaces a task by id, adds a new one, keeps the rest, and leaves an empty patch a no-op', () => {
    const patch = planPatchSchema.parse({ tasks: [{ ...plan.tasks[1]!, title: 'Build it' }, { ...plan.tasks[2]!, id: 'P4', title: 'Docs', kind: 'handoff', commands: [] }] })
    const merged = applyPlanPatch(plan, patch)
    expect(merged.tasks.map((task) => `${task.id} ${task.title}`)).toEqual(['P1 Tests', 'P2 Build it', 'P3 Verify', 'P4 Docs'])
    expect(applyPlanPatch(plan, planPatchSchema.parse({}))).toEqual(plan)
  })

  it('removes, reorders and replaces whole lists only when the patch names them', () => {
    const merged = applyPlanPatch(plan, planPatchSchema.parse({ removeTaskIds: ['P3'], taskOrder: ['P2', 'P1'], gaps: ['a fact'] }))
    expect({ order: merged.tasks.map((task) => task.id), gaps: merged.gaps, checks: merged.checks }).toEqual({ order: ['P2', 'P1'], gaps: ['a fact'], checks: plan.checks })
  })

  it('refuses a patch that leaves no task, so it is rejected rather than merged into a broken plan', () => {
    expect(() => applyPlanPatch(plan, planPatchSchema.parse({ removeTaskIds: ['P1', 'P2', 'P3'] }))).toThrow()
  })
})
