import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyAnswers,
  applyAnswersById,
  classifyRenderings,
  compareIds,
  decisionSchema,
  groomPageState,
  openDecisions,
  parseDecisionsList,
  parseGroomPage,
  parseTickedDecisions,
  renderDecision,
  renderDecisions,
  renderGroomPage,
  reviseAnswers,
  takenDecision,
  type DecisionRecord,
} from './decisions.ts'
import type { GroomDecision, GroomRecord } from './groom-record.ts'
import { blocksToMarkdown, markdownToBlocks, notionToMarkdown } from './notion-markdown.ts'

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

describe('Grooming Decisions page', () => {
  const DATE = '2026-10-11'
  const INTRO =
    'Tick one option per question. Only ticks are read as answers: anything else you write on this page is kept under the Notes block at the end and never read as an answer. Ticks made while a run is writing (the "Run: ... in progress" line is present) may need to be made again.'

  /** Builds a group's fixtures on first use, so a missing export fails its tests and not the whole file. */
  function once<T>(make: () => T): () => T {
    const cache: { value?: { made: T } } = {}
    return () => (cache.value ??= { made: make() }).made
  }

  /** The page as `pullPage` hands it back after a push: blocks through the API and the markdown export. */
  const throughNotion = (markdown: string): string => notionToMarkdown(blocksToMarkdown(markdownToBlocks(markdown)))

  /** Ticks the one to-do line that starts with `- [ ] <start>`; the start must be unique on the page. */
  const tick = (markdown: string, start: string): string => {
    const lines = markdown.split('\n')
    const hits = lines.filter((line) => line.startsWith(`- [ ] ${start}`))
    if (hits.length !== 1) throw new Error(`expected one unticked line starting with ${start}, found ${hits.length}`)
    return lines.map((line) => (line.startsWith(`- [ ] ${start}`) ? `- [x] ${line.slice(6)}` : line)).join('\n')
  }
  const untick = (markdown: string, start: string): string => markdown.split('\n').map((line) => (line.startsWith(`- [x] ${start}`) ? `- [ ] ${line.slice(6)}` : line)).join('\n')

  /** The `## Notes` block of a rendered page, without the trailer that follows it. */
  const notesOf = (markdown: string): string => {
    const start = markdown.indexOf('## Notes')
    if (start === -1) return ''
    const trailer = markdown.indexOf('\nRound ', start)
    return markdown.slice(start, trailer === -1 ? undefined : trailer).trim()
  }
  const blockOf = (markdown: string, id: string): string => {
    const start = markdown.indexOf(`## ${id} — `)
    const next = markdown.slice(start + 1).search(/\n## |\nRound \d/)
    return next === -1 ? markdown.slice(start) : markdown.slice(start, start + 1 + next)
  }
  const headingsOf = (markdown: string): string[] => markdown.split('\n').filter((line) => /^#{1,6} /.test(line))

  const record = (fields: Partial<GroomRecord>): GroomRecord => ({
    decisions: [],
    branches: [{ id: 'problem', state: 'visited' }, { id: 'who', state: 'visited' }, { id: 'data', state: 'visited' }],
    round: 1,
    startedAt: '2026-10-11T09:00:00.000Z',
    open: 0,
    page: {},
    status: 'needs-author',
    ...fields,
  })

  const q1: GroomDecision = {
    id: 'Q1',
    question: 'Who owns a saved list?',
    options: ['The member who made it', 'Everyone in the household'],
    recommended: 'The member who made it',
    reasoning: 'lists are created from a personal account today',
    whyYours: 'it decides who can delete a list',
    branch: 'who',
    facts: [{ path: 'src/lists/model.ts', line: 12, quote: 'ownerId: string' }],
    decidedBy: 'open',
    answer: null,
  }
  const q11: GroomDecision = {
    id: 'Q1.1',
    question: 'May a household member rename a list they do not own?',
    options: ['Only the owner renames', 'Any member renames'],
    recommended: 'Only the owner renames',
    reasoning: 'a rename by someone else surprises the owner',
    whyYours: 'it is a household policy, not a technical limit',
    branch: 'who',
    facts: [],
    decidedBy: 'open',
    answer: null,
  }
  const q2: GroomDecision = {
    id: 'Q2',
    question: 'Who can see a saved list?',
    options: ['Share with the team', 'Keep it private'],
    recommended: 'Share with the team',
    reasoning: 'shared editing is the norm',
    whyYours: 'it changes what members expect to be private',
    branch: 'problem',
    facts: [],
    decidedBy: 'open',
    answer: null,
  }
  const q3: GroomDecision = {
    id: 'Q3',
    question: 'Which list does the import fill?',
    options: ['Keep the _old_ list (v1, v2)', 'Start a new list'],
    recommended: 'Keep the _old_ list (v1, v2)',
    reasoning: 'it is the list members already know',
    whyYours: 'it decides what members see after an import',
    branch: 'data',
    facts: [{ path: 'src/import/run.ts', line: 40, quote: 'const target = lists.default' }],
    decidedBy: 'author',
    answer: 'Keep the _old_ list (v1, v2)',
  }
  const q4base: GroomDecision = {
    id: 'Q4',
    question: 'Do saved items expire?',
    options: ['Keep forever', 'Expire after 30 days'],
    recommended: 'Keep forever',
    reasoning: 'cookbooks already keep everything until removed',
    whyYours: 'it decides what members pay storage for',
    branch: 'data',
    facts: [],
    decidedBy: 'author',
    answer: 'Expire after 30 days',
  }
  const q4: GroomDecision = { ...q4base, revisedAt: '2026-10-11' }

  describe('round trip through Notion (T1)', () => {
    const given = once(() => {
      const open = record({ decisions: [q1, q11, q2, q3, q4], open: 3, branches: [{ id: 'problem', state: 'visited' }, { id: 'who', state: 'visited' }, { id: 'data', state: 'visited' }, { id: 'tests', state: 'open' }] })
      const rendered = renderGroomPage(open, { date: DATE, notes: [] })
      const answered = tick(tick(rendered, 'Share with the team'), 'Only the owner renames')
      const pulled = throughNotion(answered)
      const parsed = parseGroomPage(pulled, ['Q1', 'Q1.1', 'Q2', 'Q3', 'Q4'])

      const confirmed = record({ decisions: [{ ...q1, decidedBy: 'author', answer: 'The member who made it' }, { ...q2, decidedBy: 'author', answer: 'Keep it private' }, q3, q4], status: 'confirmed' })
      const confirmedPulled = throughNotion(renderGroomPage(confirmed, { date: DATE, notes: [] }))
      return { open, rendered, answered, pulled, parsed, confirmedPulled }
    })

    it('reads every heading back unchanged', () => {
      const { answered, pulled } = given()
      expect(headingsOf(pulled)).toEqual(headingsOf(answered))
    })

    it('writes no heading deeper than level 3', () => {
      const { rendered } = given()
      expect(headingsOf(rendered).every((line) => /^#{1,3} /.test(line))).toBe(true)
    })

    it('reads a ticked recommended option back as the bare option text, with no recommended residue', () => {
      const { parsed } = given()
      expect(parsed.answers.find((answer) => answer.id === 'Q2')?.answer).toBe('Share with the team')
    })

    it('attributes a tick under a follow-up to the follow-up, not its parent', () => {
      const { parsed } = given()
      expect(parsed.answers.filter((answer) => answer.id === 'Q1' || answer.id === 'Q1.1').map((answer) => [answer.id, answer.answer])).toEqual([['Q1.1', 'Only the owner renames']])
    })

    it('detects no revision when a confirmed tick on an italic, parenthesised option is unchanged', () => {
      const { open, parsed } = given()
      expect(reviseAnswers(open.decisions, parsed.ticks, DATE).find((decision) => decision.id === 'Q3')).toEqual(q3)
    })

    it('reads a ticked CONFIRM block and its Confirmed line back unchanged', () => {
      const { confirmedPulled } = given()
      expect(confirmedPulled).toContain('## CONFIRM — Grooming is complete\n\n- [x] Confirm\n\nConfirmed 2026-10-11\n')
    })

    it('reads the ticked CONFIRM box after the trip', () => {
      const { confirmedPulled } = given()
      expect(parseGroomPage(confirmedPulled, ['Q1', 'Q2', 'Q3', 'Q4']).confirmTicked).toBe(true)
    })
  })

  describe('a hostile Notes region (T2)', () => {
    const given = once(() => {
      const page = [
        '# Grooming Decisions',
        '',
        INTRO,
        '',
        '## Q1 — Who owns a saved list?',
        '',
        'Branch: who',
        '',
        '- [ ] The member who made it _(recommended: lists are created from a personal account today)_',
        '- [ ] Everyone in the household',
        '',
        'Why it is yours to decide: it decides who can delete a list',
        '',
        '## STOP — Stop grooming',
        '',
        '- [ ] Stop grooming',
        '',
        '## Notes',
        '',
        '## Q2 — x',
        '',
        '- [x] y',
        '',
        '## CONFIRM — Grooming is complete',
        '',
        '- [x] Confirm',
        '',
        'A paragraph a person wrote.',
        '',
        '- a list item',
        '',
        '![sketch](https://example.com/sketch.png)',
        '',
        'Round 2 · written 2026-10-11 · 1 open · branches: problem=visited, who=visited, data=visited',
        '',
      ].join('\n')
      const withQ1 = record({ decisions: [{ ...q1, facts: [] }], open: 1, round: 2 })
      const parsed = parseGroomPage(page, ['Q1'])
      return { withQ1, parsed }
    })

    it('reads no answer from a question block typed under Notes', () => {
      const { parsed } = given()
      expect(parsed.answers).toEqual([])
    })

    it('reads no revision from the Notes region', () => {
      const { withQ1, parsed } = given()
      expect(reviseAnswers(withQ1.decisions, parsed.ticks, DATE)).toEqual(withQ1.decisions)
    })

    it('reads no Confirm or Stop from the Notes region', () => {
      const { parsed } = given()
      expect([parsed.confirmTicked, parsed.stopTicked]).toEqual([false, false])
    })

    it('carries every Notes block, demoted, in page order with its text unchanged', () => {
      const { withQ1, parsed } = given()
      expect(notesOf(renderGroomPage(withQ1, { date: DATE, notes: parsed.carried }))).toBe(
        [
          '## Notes',
          '',
          '**Q2 — x**',
          '',
          '[x] y',
          '',
          '**CONFIRM — Grooming is complete**',
          '',
          '[x] Confirm',
          '',
          'A paragraph a person wrote.',
          '',
          '- a list item',
          '',
          '![sketch](https://example.com/sketch.png)',
        ].join('\n'),
      )
    })
  })

  describe('a block whose boxes do not match its options (T3)', () => {
    const given = once(() => {
      const three: GroomDecision = { ...q4base, id: 'Q1', options: ['Keep forever', 'Expire after 30 days', 'Expire after a year'], answer: 'Keep forever' }
      const allConfirmed = record({ decisions: [three] })
      const rendered = renderGroomPage(allConfirmed, { date: DATE, notes: [] })
      const withExtraBox = rendered.replace('- [ ] Expire after a year', '- [ ] Expire after a year\n- [x] A fourth option')
      const withConfirmNote = withExtraBox.replace('- [ ] Confirm', '- [ ] Confirm\n\n- a note on confirm')
      const trailerAt = withConfirmNote.lastIndexOf('\nRound ')
      const page = `${withConfirmNote.slice(0, trailerAt)}\n## Notes\n\n- [x] a ticked note\n${withConfirmNote.slice(trailerAt)}`
      const parsed = parseGroomPage(page, ['Q1'])
      const notes = notesOf(renderGroomPage(allConfirmed, { date: DATE, notes: parsed.carried }))
      return { parsed, notes }
    })

    it('reports the block as unread with both counts', () => {
      const { parsed } = given()
      expect(parsed.unread).toEqual(['Q1: 4 boxes on the page, 3 options recorded; ticks under it were not read'])
    })

    it('reads CONFIRM and STOP unticked', () => {
      const { parsed } = given()
      expect([parsed.confirmTicked, parsed.stopTicked]).toEqual([false, false])
    })

    it('carries the extra box, the CONFIRM note and the Notes to-do to Notes in page order', () => {
      const { notes } = given()
      const at = ['(under Q1) [x] A fourth option', 'a note on confirm', '[x] a ticked note'].map((text) => notes.indexOf(text))
      expect(at.every((index, i) => index > 0 && (i === 0 || index > at[i - 1]!))).toBe(true)
    })
  })

  describe('two ticks on an open question (T4)', () => {
    const given = once(() => {
      const openQ1 = record({ decisions: [{ ...q1, facts: [], options: ['The member who made it', 'Everyone in the household', 'Nobody, lists are global'] }], open: 1 })
      const rendered = renderGroomPage(openQ1, { date: DATE, notes: [] })
      const page = tick(tick(rendered, 'The member who made it'), 'Everyone in the household').replace(
        'Why it is yours to decide: it decides who can delete a list',
        'Why it is yours to decide: it decides who can delete a list\n\nneither, see note',
      )
      const parsed = parseGroomPage(page, ['Q1'])
      const applied = applyAnswersById(openQ1.decisions, parsed.answers, parsed.twoTicks)
      const next = renderGroomPage({ ...openQ1, decisions: applied }, { date: DATE, notes: parsed.carried })
      return { applied, next }
    })

    it('leaves the question open', () => {
      const { applied } = given()
      expect(applied[0]?.decidedBy).toBe('open')
    })

    it('re-renders the options unticked with the two-ticks line under the Branch line', () => {
      const { next } = given()
      const block = blockOf(next, 'Q1')
      expect([block.includes('Branch: who\n\nTwo ticks on 2026-10-11; tick one to answer'), block.includes('- [x]')]).toEqual([true, false])
    })

    it('carries the free text to Notes under the question it sat under', () => {
      const { next } = given()
      expect(notesOf(next)).toContain('(under Q1) neither, see note')
    })
  })

  describe('revising a confirmed question (T5)', () => {
    const given = once(() => {
      const confirmedQ3: GroomDecision = {
        ...q4base,
        id: 'Q3',
        options: ['Keep forever', 'Expire after 30 days', 'Expire after a year'],
        answer: 'Keep forever',
      }
      const confirmedRecord = record({ decisions: [confirmedQ3] })
      const rendered = renderGroomPage(confirmedRecord, { date: DATE, notes: [] })
      const read = (page: string) => parseGroomPage(page, ['Q3'])
      const moved = read(tick(untick(rendered, 'Keep forever'), 'Expire after 30 days'))
      const twoNew = read(tick(tick(rendered, 'Expire after 30 days'), 'Expire after a year'))
      const none = read(untick(rendered, 'Keep forever'))
      return { confirmedRecord, moved, twoNew, none }
    })

    it('revises in place when the tick moved to another option', () => {
      const { confirmedRecord, moved } = given()
      const revised = reviseAnswers(confirmedRecord.decisions, moved.ticks, DATE)
      expect([revised.filter((decision) => decision.id === 'Q3').length, renderGroomPage({ ...confirmedRecord, decisions: revised }, { date: DATE, notes: [] }).includes('Decided by the author: Expire after 30 days (revised 2026-10-11).')]).toEqual([1, true])
    })

    it('keeps the answer and asks for one tick when two new options are ticked', () => {
      const { confirmedRecord, twoNew } = given()
      const revised = reviseAnswers(confirmedRecord.decisions, twoNew.ticks, DATE)
      const block = blockOf(renderGroomPage({ ...confirmedRecord, decisions: revised }, { date: DATE, notes: [] }), 'Q3')
      expect([revised[0]?.answer, block.match(/^- \[x\] .*$/gm), block.includes('Two new ticks on 2026-10-11; tick one to revise')]).toEqual([
        'Keep forever',
        ['- [x] Keep forever _(recommended: cookbooks already keep everything until removed)_'],
        true,
      ])
    })

    it('stays confirmed with its answer when no option is ticked', () => {
      const { confirmedRecord, none } = given()
      expect(reviseAnswers(confirmedRecord.decisions, none.ticks, DATE)).toEqual(confirmedRecord.decisions)
    })

    it('leaves applyAnswers ignoring a confirmed record', () => {
      const { confirmedRecord, moved } = given()
      expect(applyAnswers(confirmedRecord.decisions, moved.answers)).toEqual(confirmedRecord.decisions)
    })
  })

  describe('applying ticks by id (T6)', () => {
    const q5: GroomDecision = { ...q2, id: 'Q5', question: 'Who may see a list someone saved?' }

    it('answers an open question whose wording changed since the tick', () => {
      expect(applyAnswersById([q5], [{ id: 'Q5', question: 'Who can see a saved list?', answer: 'Keep it private' }])[0]).toMatchObject({ id: 'Q5', decidedBy: 'author', answer: 'Keep it private' })
    })

    it('leaves a confirmed record with a matching id unchanged', () => {
      expect(applyAnswersById([q3], [{ id: 'Q3', question: q3.question, answer: 'Start a new list' }])).toEqual([q3])
    })
  })

  describe('rebuilding groom.json from the page (T7)', () => {
    let groom: typeof import('./groom-record.ts')
    beforeAll(async () => {
      groom = await import('./groom-record.ts')
    })

    it('gets the same branches, decisions, next id and round back', () => {
      const branches = groom.GROOM_BRANCHES.map((id): GroomRecord['branches'][number] =>
        id === 'ui' ? { id, state: 'closed', reason: 'nothing to decide: CLI only' } : ['who', 'problem', 'data'].includes(id) ? { id, state: 'visited' } : { id, state: 'open' },
      )
      const q21: GroomDecision = { ...q11, id: 'Q2.1', branch: 'problem' }
      const original = record({ decisions: [q1, q2, q21, q3, q4], branches, round: 4, open: 3 })
      const rebuilt = groom.rebuildGroomRecord(renderGroomPage(original, { date: DATE, notes: [] }))
      expect(rebuilt).toMatchObject({ record: { decisions: [q1, q2, q21, q3, q4], branches, round: 4, open: 3 }, nextId: 'Q5' })
    })

    it('reseeds a page with no branch list in its trailer, marking a branch with a tagged question visited', () => {
      const older = [
        '# Grooming Decisions',
        '',
        INTRO,
        '',
        '## Q1 — Who owns a saved list?',
        '',
        'Branch: who',
        '',
        '- [ ] The member who made it _(recommended: lists are created from a personal account today)_',
        '- [ ] Everyone in the household',
        '',
        'Why it is yours to decide: it decides who can delete a list',
        '',
        '## STOP — Stop grooming',
        '',
        '- [ ] Stop grooming',
        '',
        'Round 2 · written 2026-10-01 · 1 open',
        '',
      ].join('\n')
      const { branches } = groom.rebuildGroomRecord(older).record
      expect([branches.map((branch) => branch.id), branches.find((branch) => branch.id === 'who')?.state]).toEqual([[...groom.GROOM_BRANCHES], 'visited'])
    })
  })

  describe('id order (T8)', () => {
    const ids = ['Q10', 'Q2', 'Q1.10', 'Q1', 'Q1.2']

    it('sorts numerically on each dotted segment, a parent before its follow-ups', () => {
      expect([...ids].sort(compareIds)).toEqual(['Q1', 'Q1.2', 'Q1.10', 'Q2', 'Q10'])
    })

    it('renders the blocks in that order', () => {
      const scrambled = record({ decisions: ids.map((id) => ({ ...q2, id, options: [`${id} yes`, `${id} no`], recommended: `${id} yes` })), open: ids.length })
      const rendered = renderGroomPage(scrambled, { date: DATE, notes: [] })
      expect([...rendered.matchAll(/^## (Q[\d.]+) — /gm)].map((match) => match[1])).toEqual(['Q1', 'Q1.2', 'Q1.10', 'Q2', 'Q10'])
    })
  })

  describe('STOP and CONFIRM (T9)', () => {
    const confirmedQ = { ...q2, decidedBy: 'author' as const, answer: 'Share with the team' }

    it('offers STOP and no CONFIRM while a question is open', () => {
      const rendered = renderGroomPage(record({ decisions: [q2], open: 1 }), { date: DATE, notes: [] })
      expect([rendered.includes('## STOP — Stop grooming\n\n- [ ] Stop grooming'), rendered.includes('## CONFIRM')]).toEqual([true, false])
    })

    it('offers no CONFIRM while a branch is open', () => {
      const rendered = renderGroomPage(record({ decisions: [confirmedQ], branches: [{ id: 'problem', state: 'visited' }, { id: 'tests', state: 'open' }] }), { date: DATE, notes: [] })
      expect(rendered).not.toContain('## CONFIRM')
    })

    it('shows the ticked box and its date after a confirmed run', () => {
      const rendered = renderGroomPage(record({ decisions: [confirmedQ], status: 'confirmed' }), { date: DATE, notes: [] })
      expect(rendered).toContain('## CONFIRM — Grooming is complete\n\n- [x] Confirm\n\nConfirmed 2026-10-11')
    })

    it('shows the box unticked with the re-confirm line after a person unticked it', () => {
      const rendered = renderGroomPage(record({ decisions: [confirmedQ] }), { date: DATE, notes: [], confirmUnticked: true })
      expect(rendered).toContain('## CONFIRM — Grooming is complete\n\n- [ ] Confirm\n\nConfirm was unticked on 2026-10-11; tick it again to re-confirm')
    })
  })

  describe('a fact quoting a to-do line (T10)', () => {
    const given = once(() => {
      const quoting = record({ decisions: [{ ...q1, facts: [{ path: 'specs/agents-runtime.md', line: 11, quote: '- [x] F1: anything' }] }], open: 1 })
      const pulled = throughNotion(renderGroomPage(quoting, { date: DATE, notes: [] }))
      const parsed = parseGroomPage(pulled, ['Q1'])
      return { quoting, pulled, parsed }
    })

    it('reads no tick for the question', () => {
      const { parsed } = given()
      expect(parsed.ticks.find((entry) => entry.id === 'Q1')?.indexes).toEqual([])
    })

    it('round-trips the Fact line unchanged', () => {
      const { pulled } = given()
      expect(pulled.split('\n')).toContain('Fact: specs/agents-runtime.md:11 — `- [x] F1: anything`')
    })

    it('does not carry the Fact line to Notes', () => {
      const { quoting, parsed } = given()
      expect(renderGroomPage(quoting, { date: DATE, notes: parsed.carried })).not.toContain('## Notes')
    })
  })

  describe('parsing a Decisions list (T11)', () => {
    const given = once(() => {
      const list = [
        '- **Q1 — Who owns the list — the user or the team?** Answer: The team. Why: Shared editing is the norm. **ADR candidate**',
        '- **D1 — Name.** `/aspira-groomer` and `@aspiralabs/groomer`. Why: skill name equals package name, as for the other six agents.',
        '- **D2 — Moves.** The groomer moves cards like every other skill. Overrules point 3 above. **ADR candidate** (changes BOARD-001 and the "Backlog: humans only" rule).',
        '- free text',
      ].join('\n')
      const parsed = parseDecisionsList(list)
      return { parsed }
    })

    it('reads a Q item with a dash in its question, its answer, reasoning and ADR tag', () => {
      const { parsed } = given()
      expect(parsed.items.find((item) => item.id === 'Q1')).toMatchObject({ id: 'Q1', question: 'Who owns the list — the user or the team?', answer: 'The team', reasoning: 'Shared editing is the norm', adr: true })
    })

    it('reads the hand-groomed D items by title, with the ADR tag', () => {
      const { parsed } = given()
      expect(parsed.items.filter((item) => item.id.startsWith('D')).map((item) => [item.id, item.title, item.adr])).toEqual([
        ['D1', 'Name', false],
        ['D2', 'Moves', true],
      ])
    })

    it('lists an item matching neither form as unparsed', () => {
      const { parsed } = given()
      expect(parsed.unparsed).toContain('- free text')
    })
  })

  describe('the page state (T12)', () => {
    const given = once(() => {
      const q10: GroomDecision = { ...q1, id: 'Q10', facts: [] }
      const confirmedQ3 = q3
      const page = tick(renderGroomPage(record({ decisions: [q10, q2, confirmedQ3], open: 2 }), { date: DATE, notes: [] }), 'Stop grooming')
      return { page }
    })

    it('counts the open questions, reads STOP and CONFIRM, and lists the open ids in id order', () => {
      const { page } = given()
      expect(groomPageState(page)).toEqual({ open: 2, confirmTicked: false, stopTicked: true, ids: ['Q2', 'Q10'] })
    })
  })

  describe('several renderings on one page (T13)', () => {
    const given = once(() => {
      const q4open: GroomDecision = { ...q4base, decidedBy: 'open', answer: null }
      const q5: GroomDecision = { ...q2, id: 'Q5', question: 'Is a list visible to guests?', options: ['Hide from guests', 'Show to guests'], recommended: 'Hide from guests' }
      const round2 = renderGroomPage(record({ decisions: [q4open], open: 1, round: 2 }), { date: DATE, notes: [] })
      const round3 = tick(renderGroomPage(record({ decisions: [q4open], open: 1, round: 3 }), { date: DATE, notes: [] }), 'Expire after 30 days').replace(
        'Why it is yours to decide: it decides what members pay storage for',
        'Why it is yours to decide: it decides what members pay storage for\n\nI ticked this after talking to Sam.',
      )
      const round4 = renderGroomPage(record({ decisions: [q4open, q5], open: 2, round: 4 }), { date: DATE, notes: [] })
      const halfWritten = round4.slice(0, round4.lastIndexOf('\nRound '))
      const result = classifyRenderings(`${round2}\n${round3}\n${halfWritten}\n`)
      return { result }
    })

    it('keeps the highest complete rendering', () => {
      const { result } = given()
      expect(result.round).toBe(3)
    })

    it('returns the kept rendering with its tick for merging', () => {
      const { result } = given()
      expect(parseGroomPage(result.kept, ['Q4']).answers.map((answer) => [answer.id, answer.answer])).toEqual([['Q4', 'Expire after 30 days']])
    })

    it('lists the older rendering and the half-written copy for deletion, not the kept one', () => {
      const { result } = given()
      const deleted = result.deleted
      expect([deleted.some((block) => block.startsWith('Round 2 · ')), deleted.includes('## Q5 — Is a list visible to guests?'), deleted.some((block) => block.startsWith('Round 3 · '))]).toEqual([true, true, false])
    })

    it('lists the human paragraph as carried', () => {
      const { result } = given()
      expect(result.carried).toContain('I ticked this after talking to Sam.')
    })
  })
})
