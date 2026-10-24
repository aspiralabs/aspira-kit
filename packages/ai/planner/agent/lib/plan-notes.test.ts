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

it('turns a plan gap about the UI catalog into a note once the listing succeeded, and keeps it a gap when it did not (KIT-37)', () => {
  const gap = 'The aspiralabs-ui MCP server (@aspiralabs/ui 0.6.1) returned "(no docs yet)" from list_components and get_component(button) failed, so no component docs could be read'
  const research = { facts: [], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [] }
  const assess = (reads: { tool: string; ok: boolean }[]) => {
    // The plan writes a UI file, so the catalog check applies and turns on the reads.
    const ui = validPlan()
    ui.tasks[1]!.changes[0]!.path = 'app/items/page.tsx'
    const plan = planSchema.parse({ ...ui, gaps: [gap, 'src/other.ts could not be read'] })
    const assessed = assessPlan({ spec, guidelines: '', repo: { gaps: [], files: new Map(), tracked: new Set() }, research, plan, phaseErrors: [], uiRequired: true, reads, cancelled: false })
    return { gaps: assessed.problems.filter((problem) => problem.startsWith('Plan gap:')), notes: plan.notes ?? [], open: assessed.openGaps }
  }
  // KIT-54: every plan gap is a note for the approver; only the catalog's own gap stays a problem, and only while the listing failed.
  const listed = assess([{ tool: 'mcp__aspiralabs-ui__list_components', ok: true }])
  expect(listed).toEqual({ gaps: [], notes: [gap, 'src/other.ts could not be read'], open: [`Plan gap: ${gap}`, 'Plan gap: src/other.ts could not be read'] })
  const unlisted = assess([])
  expect(unlisted).toEqual({ gaps: [`Plan gap: ${gap}`], notes: ['src/other.ts could not be read'], open: ['Plan gap: src/other.ts could not be read'] })
})
