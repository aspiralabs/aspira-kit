// KIT-36: a plan's notes are rendered for the implementer and are never a readiness problem; the
// schema accepts a plan or a research output without them.
import { expect, it } from 'vitest'
import { planSchema, renderPlan, researchSchema } from './plan.ts'
import { spec, validPlan } from './fixtures.test-helper.ts'
import { assessPlan } from './runner.ts'

it('accepts notes on the plan and on research, and a plan without them', () => {
  expect(planSchema.parse(validPlan()).notes).toBeUndefined()
  expect(researchSchema.parse({ facts: [], checks: [], gaps: [], decisions: [] }).notes).toBeUndefined()
  expect(planSchema.parse({ ...validPlan(), notes: ['Python tests are not in CI'] }).notes).toEqual(['Python tests are not in CI'])
})

it('renders notes under ## Notes and does not count them against readiness', () => {
  const plan = planSchema.parse({ ...validPlan(), notes: ['src/big.ts was read only at lines 10-40', 'the aspiralabs-ui catalog lists no components'] })
  const rendered = renderPlan(plan, 'ready', { specPath: 'spec.md', commit: 'abc', dirty: false }, [])
  expect(rendered).toContain('## Notes\n\n- src/big.ts was read only at lines 10-40\n- the aspiralabs-ui catalog lists no components')
  const research = { facts: [], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [], notes: ['research note'] }
  const assessed = assessPlan({ spec, guidelines: '', repo: { gaps: [], files: new Map(), tracked: new Set() }, research, plan, phaseErrors: [], uiRequired: false, reads: [], cancelled: false })
  expect(assessed.problems.filter((problem) => /note/i.test(problem))).toEqual([])
})
