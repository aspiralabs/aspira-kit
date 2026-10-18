import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderGroomPage } from './decisions.ts'
import {
  factSchema,
  GROOMER_MARKER_PREFIX,
  groomDecisionSchema,
  groomRecordSchema,
  readGroomRecord,
  seedFromIdeaDecisions,
  validateIdeaSummary,
  writeGroomRecord,
  type GroomDecision,
  type GroomRecord,
} from './groom-record.ts'

const DATE = '2026-10-11'

const q1: GroomDecision = {
  id: 'Q1',
  question: 'Who owns the list?',
  options: ['The team', 'The user'],
  recommended: 'The team',
  reasoning: 'Shared editing is the norm',
  whyYours: 'it decides who can delete a list',
  branch: 'who',
  facts: [{ path: 'src/lists/model.ts', line: 12, quote: 'ownerId: string' }],
  decidedBy: 'author',
  answer: 'The team',
}
const q2: GroomDecision = {
  id: 'Q2',
  question: 'Do saved items expire?',
  options: ['Keep forever', 'Expire after 30 days'],
  recommended: 'Keep forever',
  reasoning: 'cookbooks already keep everything until removed',
  whyYours: 'it decides what members pay storage for',
  branch: 'data',
  facts: [],
  decidedBy: 'author',
  answer: 'Keep forever',
}
const groomed: GroomRecord = {
  decisions: [q1, q2],
  branches: [
    { id: 'who', state: 'visited' },
    { id: 'data', state: 'visited' },
  ],
  round: 3,
  startedAt: '2026-10-11T09:00:00.000Z',
  open: 0,
  page: { id: 'page-1', url: 'https://app.notion.com/p/page-1' },
  status: 'ready',
  reasonCode: null,
  reason: null,
}

describe('the Idea summary validator (T14)', () => {
  const summary = [
    'Groomed with /aspira-groomer on 2026-10-11',
    '',
    '### Decisions',
    '',
    '- **Q1 — Who owns the list?** Answer: The team. Why: Shared editing is the norm. **ADR candidate**',
    '- **Q2 — Do saved items expire?** Answer: Keep forever. Why: cookbooks already keep everything until removed.',
    '',
    '### Terms',
    '',
    'None introduced.',
    '',
  ].join('\n')

  it('accepts the marker, one item per confirmed decision and no terms', () => {
    expect(validateIdeaSummary(summary, groomed)).toEqual({ ok: true })
  })

  it('accepts a reasoning and an answer recorded with their own closing full stop (REBA1.1)', () => {
    const stopped: GroomRecord = { ...groomed, decisions: [{ ...q1, reasoning: 'Shared editing is the norm.' }, { ...q2, answer: 'Keep forever.', options: ['Keep forever.', 'Expire after 30 days'], recommended: 'Keep forever.' }] }
    expect(validateIdeaSummary(summary, stopped)).toEqual({ ok: true })
    expect(groomDecisionSchema.parse({ ...q1, reasoning: 'Shared editing is the norm.' }).reasoning).toBe('Shared editing is the norm')
  })

  it('opens with the marker prefix the Idea is located by', () => {
    expect(summary.startsWith(GROOMER_MARKER_PREFIX)).toBe(true)
  })

  it.each([
    ['an extra heading', summary.replace('### Decisions', '## Problem\n\nInjected.\n\n### Decisions'), expect.stringContaining('## Problem')],
    ['an unknown question id', summary.replace('\n\n### Terms', '\n- **Q99 — Anything?** Answer: Yes. Why: because.\n\n### Terms'), expect.stringContaining('Q99')],
    ['a link in a term', summary.replace('None introduced.', '- **Cart**: see [x](https://example.com)'), expect.stringMatching(/link/i)],
    ['an answer one character off the record', summary.replace('Answer: Keep forever.', 'Answer: Keep forevr.'), expect.stringContaining('Q2')],
    ['a 301-character definition', summary.replace('None introduced.', `- **Cart**: ${'a'.repeat(301)}`), expect.stringContaining('300')],
  ])('refuses %s and names it', (_name, variant, reason) => {
    expect(validateIdeaSummary(variant, groomed)).toEqual({ ok: false, reason })
  })
})

describe('the round schema (T15)', () => {
  const fact = { path: 'src/cart.ts', line: 3, quote: 'export const LIMIT = 10' }
  const decision = {
    id: 'Q1',
    question: 'Do saved items expire?',
    options: ['Keep forever', 'Expire after 30 days'],
    recommended: 'Keep forever',
    reasoning: 'cookbooks already keep everything until removed',
    whyYours: 'it decides what members pay storage for',
    branch: 'data',
    facts: [fact],
    decidedBy: 'open',
    answer: null,
  }

  it('accepts a well-formed decision with two distinct options and a fact', () => {
    expect([groomDecisionSchema.safeParse(decision).success, factSchema.safeParse(fact).success]).toEqual([true, true])
  })

  it.each([
    ['a question with a line break', { ...decision, question: 'Do saved items\nexpire?' }],
    ['an option ending in a full stop', { ...decision, options: ['Keep forever', 'Expire after 30 days.'] }],
    ['two options equal after normalisation', { ...decision, options: ['Option A', 'option-a'], recommended: 'Option A' }],
    ['a symbol-only option', { ...decision, options: ['Keep forever', '—'] }],
    ['an id outside the Q namespace', { ...decision, id: 'D1' }],
  ])('refuses a decision with %s', (_name, literal) => {
    expect(groomDecisionSchema.safeParse(literal).success).toBe(false)
  })

  it.each([
    ['a path the repository tools refuse', { path: '.env.local', line: 1 }],
    ['a quote that starts like a groomer line', { path: 'src/cart.ts', line: 3, quote: 'Decided by the author: Keep forever.' }],
  ])('refuses a fact with %s', (_name, literal) => {
    expect(factSchema.safeParse(literal).success).toBe(false)
  })

  it('refuses a record with two decisions under one id', () => {
    expect(groomRecordSchema.safeParse({ ...groomed, decisions: [q1, { ...q2, id: 'Q1' }] }).success).toBe(false)
  })
})

describe('groom.json on disk', () => {
  let folder = ''
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'groom-record-'))
  })
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  it('reads back the record it wrote', async () => {
    await writeGroomRecord(folder, groomed)
    expect(await readGroomRecord(folder)).toEqual(groomed)
  })

  it('writes the record to groom/trace/groom.json', async () => {
    await writeGroomRecord(folder, groomed)
    expect(JSON.parse(await readFile(join(folder, 'groom', 'trace', 'groom.json'), 'utf8'))).toEqual(groomed)
  })

  it('returns undefined when there is no groom.json', async () => {
    expect(await readGroomRecord(folder)).toBeUndefined()
  })

  it('refuses a groom.json that does not match the schema', async () => {
    await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
    await writeFile(join(folder, 'groom', 'trace', 'groom.json'), JSON.stringify({ ...groomed, decisions: [q1, { ...q2, id: 'Q1' }] }))
    await expect(Promise.resolve().then(() => readGroomRecord(folder))).rejects.toThrow()
  })
})

describe('seeding from the Idea (T16)', () => {
  const marked = [
    '**Problem.** Lists are lost when a member leaves.',
    '',
    'Groomed with /aspira-groomer on 2026-10-09',
    '',
    '### Decisions',
    '',
    '- **Q1 — Who owns the list?** Answer: The team. Why: Shared editing is the norm. **ADR candidate**',
    '- **Q2 — Do saved items expire?** Answer: Keep forever. Why: cookbooks already keep everything until removed.',
    '',
    '### Terms',
    '',
    'None introduced.',
    '',
  ].join('\n')
  const handGroomed = [
    '**Problem.** Lists are lost when a member leaves.',
    '',
    '### Decisions',
    '',
    '> Groomed with /aspira-groomer on 2026-10-10 (run by hand in a Claude Code session; this card is the first sample of the format).',
    '',
    '- **Q1 — Who owns the list?** Answer: The team. Why: Shared editing is the norm.',
    '',
    '### Terms',
    '',
    'None introduced.',
    '',
  ].join('\n')

  it('yields one author decision per item under the marker, the answer as its only option', () => {
    expect(seedFromIdeaDecisions(marked)).toMatchObject([
      { id: 'Q1', question: 'Who owns the list?', options: ['The team'], recommended: 'The team', reasoning: 'Shared editing is the norm', whyYours: 'rebuilt from the Idea', decidedBy: 'author', answer: 'The team' },
      { id: 'Q2', question: 'Do saved items expire?', options: ['Keep forever'], recommended: 'Keep forever', reasoning: 'cookbooks already keep everything until removed', whyYours: 'rebuilt from the Idea', decidedBy: 'author', answer: 'Keep forever' },
    ])
  })

  it('says under the intro that the page was rebuilt from the Idea', () => {
    const page = renderGroomPage({ ...groomed, decisions: seedFromIdeaDecisions(marked), status: 'needs-author' }, { date: DATE, notes: [], rebuiltOn: DATE })
    expect(page).toContain(
      'Ticks made while a run is writing (the "Run: ... in progress" line is present) may need to be made again.\n\nRebuilt from the Idea\'s Decisions list on 2026-10-11; the previous page was not found',
    )
  })

  it('reads nothing from a hand-written list with no marker paragraph above it', () => {
    expect(seedFromIdeaDecisions(handGroomed)).toEqual([])
  })
})
