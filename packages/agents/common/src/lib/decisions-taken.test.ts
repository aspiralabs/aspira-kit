// A decision the agent took to keep going, and the groomer's own Grooming Decisions page, should
// never read the agent's own tick as the author's (F10, F14, F19; KIT-11 plan P2 T4, T5).

import { describe, expect, it } from 'vitest'
import { applyAnswers, parseTickedDecisions, renderDecisions, renderGroomPage, takenDecision } from './decisions.ts'
import { rebuildGroomRecord, validateIdeaSummary, type GroomDecision, type GroomRecord } from './groom-record.ts'

/** Ticks the one unticked line that starts with `- [ ] <start>`; the start must be unique on the page. */
const tick = (markdown: string, start: string): string =>
  markdown
    .split('\n')
    .map((line) => (line.startsWith(`- [ ] ${start}`) ? `- [x] ${line.slice(6)}` : line))
    .join('\n')
const untick = (markdown: string, start: string): string =>
  markdown
    .split('\n')
    .map((line) => (line.startsWith(`- [x] ${start}`) ? `- [ ] ${line.slice(6)}` : line))
    .join('\n')

/** A `## <id> — ...` block of a rendered Grooming Decisions page, up to the next heading or the trailer. */
const blockOf = (markdown: string, id: string): string => {
  const start = markdown.indexOf(`## ${id} — `)
  const next = markdown.slice(start + 1).search(/\n## |\nRound \d/)
  return next === -1 ? markdown.slice(start) : markdown.slice(start, start + 1 + next)
}

describe('a decision the agent took to keep going (T4)', () => {
  const decision = {
    question: 'Do saved items expire?',
    options: ['Keep forever', 'Expire after 30 days'],
    recommended: 'Keep forever',
    reasoning: 'cookbooks already keep everything until removed',
    whyYours: 'it decides what members pay storage for',
  }

  it('renders the agent-taken line and never reads the agent\'s own tick as the author\'s', () => {
    const taken = takenDecision('D1', decision)
    const file = renderDecisions([taken])
    expect(file).toContain('Taken by the agent to keep going: Keep forever. Tick another option to reverse it.')
    const applied = applyAnswers([taken], parseTickedDecisions(file))
    expect(applied[0]).toMatchObject({ id: 'D1', decidedBy: 'agent', answer: 'Keep forever' })
  })

  it('becomes the author\'s decision when a different option is ticked instead', () => {
    const taken = takenDecision('D1', decision)
    const file = tick(untick(renderDecisions([taken]), 'Keep forever'), 'Expire after 30 days')
    const applied = applyAnswers([taken], parseTickedDecisions(file))
    expect(applied[0]).toMatchObject({ id: 'D1', decidedBy: 'author', answer: 'Expire after 30 days' })
  })
})

describe('a groomer decision the agent took to keep going (T5)', () => {
  const DATE = '2026-10-11'
  const q1: GroomDecision = {
    id: 'Q1',
    question: 'Who owns the list?',
    options: ['The team', 'The user'],
    recommended: 'The team',
    reasoning: 'Shared editing is the norm',
    whyYours: 'it decides who can delete a list',
    branch: 'problem',
    facts: [],
    decidedBy: 'author',
    answer: 'The team',
  }
  const q2: GroomDecision = {
    id: 'Q2',
    question: 'Does a re-import keep the existing data?',
    options: ['Keep it', 'Replace it'],
    recommended: 'Keep it',
    reasoning: 'nothing else reads the replaced copy',
    whyYours: 'it decides what a re-import does to existing data',
    branch: 'constraints',
    facts: [],
    decidedBy: 'agent',
    answer: 'Keep it',
  }
  const record: GroomRecord = {
    decisions: [q1, q2],
    branches: [
      { id: 'problem', state: 'visited' },
      { id: 'constraints', state: 'visited' },
    ],
    round: 2,
    startedAt: '2026-10-11T09:00:00.000Z',
    open: 0,
    page: {},
    status: 'ready',
    reasonCode: null,
    reason: null,
  }
  const summary = [
    'Groomed with /aspira-groomer on 2026-10-11',
    '',
    '### Decisions',
    '',
    '- **Q1 — Who owns the list?** Answer: The team. Why: Shared editing is the norm.',
    '- **Q2 — Does a re-import keep the existing data?** Answer: Keep it. Why: nothing else reads the replaced copy.',
    '',
    '### Terms',
    '',
    'None introduced.',
    '',
  ].join('\n')

  it('renders Q2 with the agent-taken line, its recommended option ticked, and no Decided-by-the-author line', () => {
    const block = blockOf(renderGroomPage(record, { date: DATE, notes: [] }), 'Q2')
    expect(block).toContain('Taken by the agent to keep going: Keep it. Tick another option to reverse it.')
    expect(block).toContain('- [x] Keep it')
    expect(block).not.toContain('Decided by the author')
  })

  it('rebuilds Q2 as the agent\'s and Q1 as the author\'s', () => {
    const rebuilt = rebuildGroomRecord(renderGroomPage(record, { date: DATE, notes: [] })).record
    expect(rebuilt.decisions.find((decision) => decision.id === 'Q1')?.decidedBy).toBe('author')
    expect(rebuilt.decisions.find((decision) => decision.id === 'Q2')?.decidedBy).toBe('agent')
  })

  it('accepts an Idea summary that lists the agent-taken Q2 beside the author\'s Q1: the Confirm confirmed both (KIT-25)', () => {
    expect(validateIdeaSummary(summary, record)).toEqual({ ok: true })
  })

  it('refuses an Idea summary that leaves the agent-taken Q2 out: it is a confirmed decision too (KIT-25)', () => {
    const withoutQ2 = summary.split('\n').filter((line) => !line.startsWith('- **Q2')).join('\n')
    expect(validateIdeaSummary(withoutQ2, record)).toEqual({ ok: false, reason: 'confirmed decisions missing from the summary: Q2' })
  })
})
