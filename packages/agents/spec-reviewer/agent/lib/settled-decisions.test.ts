// KIT-36: the reviewed spec carries every decided author decision under ## Decisions, in the form the
// planner's settled-decisions rule reads, so the next step never raises them again.
import { describe, expect, it } from 'vitest'
import { parseDecisionsList } from '@aspiralabs/agent-common/lib/decisions'
import { withSettledDecisions } from './report.ts'

const SPEC = '# Feature\n\n## Intent\n\nPersist a named item.\n\n## Acceptance criteria\n\n### Features\n\n- [ ] F1: Save an item once.\n'
const base = { options: ['API only', 'Console too'], recommended: 'API only', reasoning: 'nothing in the console retries today', whyYours: 'it changes what Retry means' }
const taken = { ...base, id: 'R3', question: 'Should the console offer Retry for shardless files?', decidedBy: 'agent' as const, answer: 'API only' }
const answered = { ...base, id: 'R1', question: 'Where is the AnalyzeID flag computed?', decidedBy: 'author' as const, answer: 'TypeScript routing', reasoning: 'no Data API grant needed.' }
const open = { ...base, id: 'R5', question: 'Keep saved items forever?', decidedBy: 'open' as const, answer: null }

describe('withSettledDecisions', () => {
  it('appends a ## Decisions section with the decided decisions, taken ones marked, in the form the planner reads, and leaves open ones out', () => {
    const out = withSettledDecisions(SPEC, [taken, answered, open])
    const { items, unparsed } = parseDecisionsList(out.slice(out.indexOf('## Decisions')))
    expect({ unparsed, items: items.map((item) => [item.id, item.question, item.answer]) }).toEqual({
      unparsed: [],
      items: [['Q1', 'Should the console offer Retry for shardless files?', 'API only'], ['Q2', 'Where is the AnalyzeID flag computed?', 'TypeScript routing']],
    })
    expect(out).toContain('(taken as recommended).')
    expect(withSettledDecisions(SPEC, [open])).toBe(SPEC)
  })

  it('adds to an existing ## Decisions section instead of starting a second one', () => {
    const groomed = `${SPEC}\n## Decisions\n\n- **Q1 — Should saving be idempotent?** Answer: Yes. Why: double clicks happen.\n\n## Out of scope\n\nNothing.\n`
    const out = withSettledDecisions(groomed, [taken])
    expect(out.match(/^## Decisions/gm)).toHaveLength(1)
    const section = out.slice(out.indexOf('## Decisions'), out.indexOf('## Out of scope'))
    expect(parseDecisionsList(section).items.map((item) => item.question)).toEqual(['Should saving be idempotent?', 'Should the console offer Retry for shardless files?'])
  })
})
