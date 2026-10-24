// KIT-29: a repository file left out of the index for size is a note in the evidence packet, never a
// problem. assessPlan (runner.ts) used to copy every snapshot gap into problems, so a project with
// one tracked file over 256 KB ended every planner run incomplete whatever the plan said.
import { expect, it } from 'vitest'
import { spec } from './fixtures.test-helper.ts'
import { assessPlan } from './runner.ts'

it('does not turn a size-budget snapshot gap into a problem', () => {
  const repo = { gaps: ['Not indexed (size budget): instances/battalion/app/lib/font-config.ts'], files: new Map<string, string>(), tracked: new Set<string>() }
  const assessed = assessPlan({ spec, guidelines: '', repo, research: null, plan: null, phaseErrors: [], uiRequired: false, reads: [], cancelled: false })
  expect(assessed.problems.filter((problem) => problem.includes('size budget'))).toEqual([])
})
