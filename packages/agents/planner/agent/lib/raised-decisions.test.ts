// KIT-34: planning never raises a decision research already raised under other words, and plans the
// recommended option, so --take-recommended cannot take opposite answers to one question.
import { expect, it } from 'vitest'
import { planningPrompt, raisedDecisionsSection, repairPrompt } from './runner.ts'
import { validPlan } from './fixtures.test-helper.ts'

const decision = { question: 'Should the retry endpoint start a fresh execution for a file that can no longer be redriven?', options: ['Yes', 'No'], recommended: 'Yes', reasoning: 'the files keep their ids', whyYours: 'it changes what Retry means' }
const research = { facts: [], checks: [], gaps: [], decisions: [decision] }

it('lists the decisions research raised, with the recommended option, and forbids raising them again', () => {
  const section = raisedDecisionsSection(research)
  expect(section).toContain(`- ${decision.question} (recommended: Yes)`)
  expect(section).toContain('Do not raise any of these again')
  expect(raisedDecisionsSection({ decisions: [] })).toBe('')
})

it('puts the section in the planning prompt and the repair prompt, after the research and before the instructions', () => {
  const planning = planningPrompt('CONTEXT', research, 'INSTRUCTIONS')
  const repair = repairPrompt('CONTEXT', research, validPlan(), ['P1: x'], 'REPAIR')
  for (const prompt of [planning, repair]) {
    expect(prompt.indexOf('DECISIONS RESEARCH ALREADY RAISED')).toBeGreaterThan(prompt.indexOf('RESEARCH:'))
  }
  expect(planning.indexOf('DECISIONS RESEARCH ALREADY RAISED')).toBeLessThan(planning.indexOf('INSTRUCTIONS'))
})
