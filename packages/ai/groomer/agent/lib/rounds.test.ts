// The groomer's round schema and design tree (agent/lib/rounds.ts), at the module seam:
// - `roundSchema`: what one round file (`round-<n>.json`) must hold; the driver and write-round both apply it.
// - `seedBranches()`: the seeded design tree, `{ id, state: 'open' }[]`, exit criteria, then spec sections, then LENSES.
// - `frontier(record, idea)`: the open questions whose prerequisites are settled, in compareIds order;
//   on an empty (title-only) idea the problem, who and done questions come first. A decision in the
//   record may carry `prerequisites?: string[]` (the ids it waits on), as the round that proposed it did.
// - `applyRound(record, round)`: the record after a validated round (its questions added, its branch
//   states applied, its round number taken).
// - `roundZeroReport(round)`: the codebase report that opens the first round.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { renderGroomPage } from '@aspiralabs/ai/common/lib/decisions'
import { applyRound, frontier, roundSchema, roundZeroReport, seedBranches } from './rounds.ts'

/** The seeded branch ids, written out: the Grooming exit criteria, the spec template sections, then the six review lenses. */
const SEEDED = ['problem', 'who', 'done', 'intent', 'f-list', 'tests', 'constraints', 'out-of-scope', 'blast-radius', 'security', 'architecture', 'data', 'behavior', 'ui', 'acceptance']

const question = (id: string, branch: string, prerequisites: string[] = []) => ({
  id,
  branch,
  question: `Which ${branch} choice applies to the cart limit (${id})?`,
  options: ['Keep it', 'Change it'],
  recommended: 'Keep it',
  reasoning: 'it matches what the cart does today',
  whyYours: 'it is a product call',
  facts: [{ path: 'src/cart.ts', line: 1 }],
  decidedBy: 'open' as const,
  answer: null,
  ...(prerequisites.length > 0 ? { prerequisites } : {}),
})
const answered = (id: string, branch: string) => ({ ...question(id, branch), decidedBy: 'author' as const, answer: 'Keep it' })

const openBranches = () => SEEDED.map((id) => ({ id, state: 'open' as const }))
const record = <D extends { decidedBy: 'open' | 'author' }, B extends { id: string; state: 'open' | 'visited' | 'closed'; reason?: string }>(decisions: D[], branches: B[]) => ({
  decisions,
  branches,
  round: 1,
  startedAt: '2026-10-11T09:00:00.000Z',
  open: decisions.filter((decision) => decision.decidedBy === 'open').length,
  page: { url: 'https://www.notion.so/gd' },
  status: 'needs-author' as const,
  reasonCode: null,
  reason: null,
})

describe('the design tree', () => {
  it('seeds one branch per Grooming exit criterion, spec template section and review lens, in that order', () => {
    expect(seedBranches().map((branch) => branch.id)).toEqual(SEEDED)
  })

  it('on a title-only idea asks the problem, who and done questions before any other branch', () => {
    const proposed = record([question('Q1', 'security'), question('Q2', 'problem'), question('Q3', 'who'), question('Q4', 'done')], openBranches())
    expect(frontier(proposed, '').map((decision) => decision.id)).toEqual(['Q2', 'Q3', 'Q4', 'Q1'])
  })

  it('holds a question back while its prerequisite is open and asks it once that is answered', () => {
    const idea = 'Let shoppers see why the cart stops at ten items.'
    const before = frontier(record([question('Q1', 'problem'), question('Q2', 'who', ['Q1'])], openBranches()), idea).map((decision) => decision.id)
    const after = frontier(record([answered('Q1', 'problem'), question('Q2', 'who', ['Q1'])], openBranches()), idea).map((decision) => decision.id)
    expect({ before, after }).toEqual({ before: ['Q1'], after: ['Q2'] })
  })

  it('closes a branch with nothing to decide, counts it as visited and offers Confirm, with the reason in the trailer', () => {
    const branches = SEEDED.map((id) => ({ id, state: id === 'ui' ? ('open' as const) : ('visited' as const) }))
    const round = roundSchema.parse({ round: 2, searched: ['cart output'], facts: [], questions: [], branches: [{ id: 'ui', state: 'closed', reason: 'nothing to decide: CLI only' }] })
    const applied = applyRound(record([answered('Q1', 'problem')], branches), round)
    const page = renderGroomPage(applied, { date: '2026-10-11', notes: [] })
    expect({ ui: applied.branches.find((branch) => branch.id === 'ui'), confirm: page.includes('## CONFIRM — Grooming is complete'), trailer: page.includes('ui=closed (nothing to decide: CLI only)') }).toEqual({
      ui: { id: 'ui', state: 'closed', reason: 'nothing to decide: CLI only' },
      confirm: true,
      trailer: true,
    })
  })
})

describe('the round schema and round zero', () => {
  // A repository that tracks a secret file, a source file and a spec whose lines read like ticks: the
  // read filter, not the file's absence, is what keeps `.env.local` out of a round.
  beforeAll(() => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'groomer-rounds-')))
    execFileSync('git', ['init', '-q', repo])
    mkdirSync(join(repo, 'src'))
    mkdirSync(join(repo, 'specs'))
    writeFileSync(join(repo, '.env.local'), 'STRIPE_SECRET_KEY=sk_live_example\n')
    writeFileSync(join(repo, 'src', 'cart.ts'), 'export const LIMIT = 10\n')
    writeFileSync(join(repo, 'specs', 'x.md'), '- [x] F1: done\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: repo })
    const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n')
    if (!tracked.includes('.env.local')) throw new Error('the fixture must track .env.local')
  })

  const nothingFound = { round: 1, searched: ['cart limit'], facts: [], questions: [], branches: [] }

  it('refuses a round citing .env.local, a round that searched nothing, and a question with one option', () => {
    const citingSecret = { ...nothingFound, facts: [{ path: '.env.local', line: 1 }] }
    const searchedNothing = { ...nothingFound, searched: [] }
    const oneOption = { ...nothingFound, questions: [{ ...question('Q1', 'problem'), options: ['Keep it'] }] }
    expect([citingSecret, searchedNothing, oneOption].map((round) => roundSchema.safeParse(round).success)).toEqual([false, false, false])
  })

  it('keeps a question\'s reasoning without the full stop the model closed it with, so the summary reads it back the same (REBA1.1)', () => {
    const closed = { ...nothingFound, questions: [{ ...question('Q1', 'problem'), reasoning: 'Shared editing is the norm.' }] }
    const parsed = roundSchema.parse(closed)
    expect(parsed.questions[0]!.reasoning).toBe('Shared editing is the norm')
  })

  it('accepts a round that searched and found nothing, and its report says so', () => {
    const parsed = roundSchema.safeParse(nothingFound)
    expect(parsed.success ? roundZeroReport(parsed.data) : parsed.error.message).toBe('Round zero: nothing found for cart limit; no term collides')
  })
})
