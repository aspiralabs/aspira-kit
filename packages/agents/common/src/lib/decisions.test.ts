import { describe, expect, it } from 'vitest'
import { applyAnswers, decisionSchema, openDecisions, parseTickedDecisions, renderDecision, renderDecisions, takenDecision, type DecisionRecord } from './decisions.ts'

const decision = { question: 'Do saved items expire?', options: ['Keep forever', 'Expire after 30 days'], recommended: 'Keep forever', reasoning: 'cookbooks already keep everything until removed', whyYours: 'it decides what members pay storage for' }
const record: DecisionRecord = { ...decision, id: 'R3', decidedBy: 'open', answer: null }

describe('decisionSchema', () => {
  it('requires at least two options, a recommended option among them, reasoning and whyYours', () => {
    expect(decisionSchema.safeParse(decision).success).toBe(true)
    expect(decisionSchema.safeParse({ ...decision, options: ['Keep forever'] }).success).toBe(false)
    expect(decisionSchema.safeParse({ ...decision, recommended: 'Delete everything' }).success).toBe(false)
    for (const field of ['question', 'reasoning', 'whyYours'] as const) expect(decisionSchema.safeParse({ ...decision, [field]: '' }).success, field).toBe(false)
  })
})

describe('rendering', () => {
  it('writes a checkbox per option with the recommended one first, its reasoning, and why it is the author\'s', () => {
    const text = renderDecision({ ...record, options: ['Expire after 30 days', 'Keep forever'] })
    expect(text).toBe([
      '## R3 — Do saved items expire?',
      '',
      '- [ ] Keep forever _(recommended: cookbooks already keep everything until removed)_',
      '- [ ] Expire after 30 days',
      '',
      'Why it is yours to decide: it decides what members pay storage for',
    ].join('\n'))
  })

  it('shows an answered decision with its tick, and a taken one as the recommended option already taken', () => {
    expect(renderDecision({ ...record, decidedBy: 'author', answer: 'Expire after 30 days' })).toContain('Decided by the author: Expire after 30 days.\n\n- [ ] Keep forever _(recommended: cookbooks already keep everything until removed)_\n- [x] Expire after 30 days')
    const taken = renderDecision(takenDecision('A1', decision))
    expect(taken).toContain('Taken by the agent to keep going: Keep forever. Tick another option to reverse it.')
    expect(taken).toContain('- [x] Keep forever _(recommended, taken by the agent: cookbooks already keep everything until removed)_')
  })

  it('heads the file with a count that equals the decisions rendered', () => {
    const text = renderDecisions([record, { ...record, id: 'S2-1', question: 'Which list is "mine"?', decidedBy: 'author', answer: 'Keep forever' }], { status: 'needs-author' })
    expect(text).toContain('Status: needs-author')
    expect(text).toContain('2 decisions: 1 open · 1 answered')
    expect(text.match(/^## /gm)).toHaveLength(2)
    expect(renderDecisions([])).toContain('0 decisions: 0 open · 0 answered')
  })
})

describe('reading the ticks back', () => {
  it('reads a ticked option and records the decision as the author\'s', () => {
    const file = renderDecisions([record]).replace('- [ ] Expire after 30 days', '- [x] Expire after 30 days')
    expect(parseTickedDecisions(file)).toEqual([{ id: 'R3', question: 'Do saved items expire?', answer: 'Expire after 30 days' }])
    const applied = applyAnswers([record], parseTickedDecisions(file))
    expect(applied[0]).toMatchObject({ decidedBy: 'author', answer: 'Expire after 30 days' })
    expect(openDecisions(applied)).toEqual([])
  })

  it('strips the recommendation note from a ticked recommended option', () => {
    const file = renderDecisions([record]).replace('- [ ] Keep forever', '- [x] Keep forever')
    expect(parseTickedDecisions(file)).toEqual([{ id: 'R3', question: 'Do saved items expire?', answer: 'Keep forever' }])
  })

  it('ignores an unticked decision and one with two ticks, and matches questions by their words on the next run', () => {
    const untouched = renderDecisions([record])
    expect(parseTickedDecisions(untouched)).toEqual([])
    const two = untouched.replace('- [ ] Keep forever', '- [x] Keep forever').replace('- [ ] Expire after 30 days', '- [x] Expire after 30 days')
    expect(parseTickedDecisions(two)).toEqual([])
    const rerun = { ...record, id: 'S4-2', question: 'Do saved items expire' }
    expect(applyAnswers([rerun], [{ id: 'R3', question: 'Do saved items expire?', answer: 'Keep forever' }])[0]).toMatchObject({ id: 'S4-2', decidedBy: 'author', answer: 'Keep forever' })
    expect(applyAnswers([{ ...record, question: 'Something else?' }], [{ id: 'R3', question: 'Do saved items expire?', answer: 'Keep forever' }])[0]!.decidedBy).toBe('open')
  })
})
