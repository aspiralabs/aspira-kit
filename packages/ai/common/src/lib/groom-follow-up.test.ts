// The groomer's follow-up state (KIT-68, F15): under `statusFlow: false` a question can also be answered "needs
// follow-up, blocks the build" or "needs follow-up, build may go on". A follow-up is neither open nor decided: it is
// written with the question on the Grooming Decisions page, read back from it, kept by the record rebuild, left out
// of the open count (so Confirm is offered) and of the Idea summary's ### Decisions, and listed under the summary's
// ### Follow-ups with its kind. A record with no follow-up renders the page it renders today.
//
// Contract these tests pin for the implementation (named apart from the Q<n>.<m> follow-up *question*, REV-009):
//   GroomDecision   decidedBy 'follow-up' with followUp: 'blocks' | 'may-go-on' (answer null)
//   page            the question's block says "blocks the build" or "build may go on" on one line of its own
//   readGroomPage   the question's block carries followUp: 'blocks' | 'may-go-on'
//   Idea summary    `### Follow-ups` after ### Decisions and before ### Terms, one line per follow-up:
//                   `- **Q2 — <question>** Follow-up: blocks the build.` or `... Follow-up: build may go on.`
import { describe, expect, it } from 'vitest'
import { groomPageState, readGroomPage, renderGroomPage } from './decisions.ts'
import { rebuildGroomRecord, validateIdeaSummary, type GroomDecision, type GroomRecord } from './groom-record.ts'

const DATE = '2026-10-26'

const answered: GroomDecision = {
  id: 'Q1',
  question: 'Who owns the list?',
  options: ['The team', 'The user'],
  recommended: 'The team',
  reasoning: 'Shared editing is the norm',
  whyYours: 'it decides who can delete a list',
  branch: 'who',
  facts: [],
  decidedBy: 'author',
  answer: 'The team',
}
const blocking = {
  id: 'Q2',
  question: 'Do saved items expire?',
  options: ['Keep forever', 'Expire after 30 days'],
  recommended: 'Keep forever',
  reasoning: 'cookbooks already keep everything until removed',
  whyYours: 'it decides what members pay storage for',
  branch: 'data',
  facts: [],
  decidedBy: 'follow-up',
  followUp: 'blocks',
  answer: null,
} as unknown as GroomDecision
const goingOn = {
  id: 'Q3',
  question: 'Which locale ships first?',
  options: ['English', 'German'],
  recommended: 'English',
  reasoning: 'the first customers are English speaking',
  whyYours: 'it decides the launch scope',
  branch: 'tests',
  facts: [],
  decidedBy: 'follow-up',
  followUp: 'may-go-on',
  answer: null,
} as unknown as GroomDecision

const record = (decisions: GroomDecision[], status: GroomRecord['status'] = 'needs-author'): GroomRecord => ({
  decisions,
  branches: [
    { id: 'who', state: 'visited' },
    { id: 'data', state: 'visited' },
    { id: 'tests', state: 'visited' },
  ],
  round: 2,
  startedAt: '2026-10-26T09:00:00.000Z',
  open: 0,
  page: { id: 'page-1', url: 'https://www.notion.so/page-1' },
  status,
  reasonCode: null,
  reason: null,
})

const withFollowUps = record([answered, blocking, goingOn])
const page = () => renderGroomPage(withFollowUps, { date: DATE, notes: [] })

/** The lines of one question's block on the page: from its heading to the next heading. */
function blockOf(markdown: string, id: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${id} — `))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('the Grooming Decisions page with follow-ups', () => {
  it('T29 writes each follow-up as a line of its question block with its kind', () => {
    const text = page()
    expect([blockOf(text, 'Q2').includes('blocks the build'), blockOf(text, 'Q2').includes('build may go on')]).toEqual([true, false])
    expect([blockOf(text, 'Q3').includes('build may go on'), blockOf(text, 'Q3').includes('blocks the build')]).toEqual([true, false])
    expect([blockOf(text, 'Q1').includes('blocks the build'), blockOf(text, 'Q1').includes('build may go on')]).toEqual([false, false])
  })

  it('T29 reads each follow-up back from the page with its kind', () => {
    const read = readGroomPage(page())
    expect(read.questions.map((block) => [block.id, (block as { followUp?: string }).followUp])).toEqual([['Q1', undefined], ['Q2', 'blocks'], ['Q3', 'may-go-on']])
  })

  it('T29 keeps both kinds when the record is rebuilt from the page', () => {
    const rebuilt = rebuildGroomRecord(page()).record
    expect(rebuilt.decisions.map((decision) => [decision.id, decision.decidedBy, (decision as { followUp?: string }).followUp])).toEqual([
      ['Q1', 'author', undefined],
      ['Q2', 'follow-up', 'blocks'],
      ['Q3', 'follow-up', 'may-go-on'],
    ])
  })

  it('T29 leaves follow-ups out of the open count, so Confirm is offered and Stop is not', () => {
    const text = page()
    expect([rebuildGroomRecord(text).record.open, groomPageState(text).open]).toEqual([0, 0])
    expect([text.includes('## CONFIRM — Grooming is complete'), text.includes('## STOP'), text.includes(' · 0 open')]).toEqual([true, false, true])
  })

  it('T29 renders a record with no follow-up as the page it renders today', () => {
    const open = { ...blocking, decidedBy: 'open', followUp: undefined } as unknown as GroomDecision
    const today =
      '# Grooming Decisions\n\nTick one option per question. Only ticks are read as answers: anything else you write on this page is kept under the Notes block at the end and never read as an answer. Ticks made while a run is writing (the "Run: ... in progress" line is present) may need to be made again.\n\n## Q1 — Who owns the list?\n\nBranch: who\n\nDecided by the author: The team.\n\n- [x] The team _(recommended: Shared editing is the norm)_\n- [ ] The user\n\nWhy it is yours to decide: it decides who can delete a list\n\n## Q2 — Do saved items expire?\n\nBranch: data\n\n- [ ] Keep forever _(recommended: cookbooks already keep everything until removed)_\n- [ ] Expire after 30 days\n\nWhy it is yours to decide: it decides what members pay storage for\n\n## STOP — Stop grooming\n\n- [ ] Stop grooming\n\nRound 2 · written 2026-10-26 · 1 open · branches: who=visited, data=visited, tests=visited · options: Q1=2, Q2=2\n'
    expect(renderGroomPage(record([answered, open]), { date: DATE, notes: [] })).toBe(today)
  })
})

describe('the Idea summary with follow-ups', () => {
  const lines = (...extra: string[]) => ['Groomed with /aspira-groomer on 2026-10-26', '', ...extra, ''].join('\n')
  const decisions = ['### Decisions', '', '- **Q1 — Who owns the list?** Answer: The team. Why: Shared editing is the norm.']
  const followUps = ['### Follow-ups', '', '- **Q2 — Do saved items expire?** Follow-up: blocks the build.', '- **Q3 — Which locale ships first?** Follow-up: build may go on.']
  const terms = ['### Terms', '', 'None introduced.']
  const ready = record([answered, blocking, goingOn], 'ready')

  it('T29 accepts ### Decisions with only the answered question and ### Follow-ups with both follow-ups and their kinds', () => {
    expect(validateIdeaSummary(lines(...decisions, '', ...followUps, '', ...terms), ready)).toEqual({ ok: true })
  })

  it('T29 refuses a follow-up listed as a decision', () => {
    const listed = [...decisions, '- **Q2 — Do saved items expire?** Answer: Keep forever. Why: cookbooks already keep everything until removed.']
    expect(validateIdeaSummary(lines(...listed, '', ...followUps, '', ...terms), ready)).toEqual({ ok: false, reason: expect.stringContaining('Q2') })
  })

  it('T29 refuses a summary that leaves the ### Follow-ups heading out', () => {
    expect(validateIdeaSummary(lines(...decisions, '', ...terms), ready)).toEqual({ ok: false, reason: expect.stringContaining('Follow-ups') })
  })

  it('T29 refuses a follow-up listed with the wrong kind', () => {
    const wrong = ['### Follow-ups', '', '- **Q2 — Do saved items expire?** Follow-up: build may go on.', '- **Q3 — Which locale ships first?** Follow-up: build may go on.']
    expect(validateIdeaSummary(lines(...decisions, '', ...wrong, '', ...terms), ready)).toEqual({ ok: false, reason: expect.stringContaining('Q2') })
  })

  it('T29 still accepts a summary with no ### Follow-ups heading for a record with no follow-up', () => {
    expect(validateIdeaSummary(lines(...decisions, '', ...terms), record([answered], 'ready'))).toEqual({ ok: true })
  })
})
