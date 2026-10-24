// The groomer's round: what one round file (`round-<n>.json`) must hold, the design tree it grows,
// and the frontier a round asks. Pure: no file system, no model. The driver (local.ts), the runner
// and the write-round tool all validate a round with `roundSchema`, so no model output reaches the
// Grooming Decisions renderer unvalidated (SEC-001, SEC-010).

import { z } from 'zod'
import { compareIds } from '@aspiralabs/ai/common/lib/decisions'
import { factSchema, GROOM_BRANCHES, groomDecisionSchema, type Fact, type GroomDecision, type GroomRecord } from '@aspiralabs/ai/common/lib/groom-record'

/** One seeded branch: a Grooming exit criterion, a spec template section or a spec-reviewer lens. */
export type GroomBranchId = (typeof GROOM_BRANCHES)[number]
export type Branch = GroomRecord['branches'][number]

const BRANCH_IDS: readonly string[] = GROOM_BRANCHES

/** The exit-criterion branches a title-only idea asks first (F43). */
export const EXIT_CRITERIA: readonly GroomBranchId[] = ['problem', 'who', 'done']

const oneLine = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), 'must be one line')

const roundBranchSchema = z
  .object({
    id: z.string().refine((id) => BRANCH_IDS.includes(id), 'not a seeded branch'),
    state: z.enum(['open', 'visited', 'closed']),
    reason: oneLine.optional(),
  })
  .refine((branch) => branch.state !== 'closed' || branch.reason !== undefined, { path: ['reason'], message: 'a closed branch states its reason in one line' })

/**
 * One round as the round model writes it: the concepts it searched (never empty, so "searched,
 * nothing found" differs from "not searched"), the facts it found, the questions it asks (the whole
 * frontier, each an open decision in the DECISION_RULE shape resting on at least one file:line fact,
 * author decision D1) and the branch states it changes.
 */
export const roundSchema = z
  .object({
    round: z.number().int().positive(),
    searched: z.array(oneLine).min(1, 'a round names the concepts it searched'),
    facts: z.array(factSchema),
    questions: z.array(groomDecisionSchema),
    branches: z.array(roundBranchSchema),
  })
  .superRefine((round, ctx) => {
    const seen = new Set<string>()
    for (const [index, question] of round.questions.entries()) {
      if (seen.has(question.id)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'id'], message: `${question.id} appears twice in the round` })
      seen.add(question.id)
      if (question.decidedBy !== 'open' || question.answer !== null) ctx.addIssue({ code: 'custom', path: ['questions', index], message: `${question.id}: a round asks open questions only (decidedBy "open", answer null)` })
      if (!BRANCH_IDS.includes(question.branch)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'branch'], message: `${question.id}: "${question.branch}" is not a seeded branch` })
      if (question.facts.length === 0) ctx.addIssue({ code: 'custom', path: ['questions', index, 'facts'], message: `${question.id}: every question names at least one file:line fact it rests on` })
    }
    const branches = new Set<string>()
    for (const [index, branch] of round.branches.entries()) {
      if (branches.has(branch.id)) ctx.addIssue({ code: 'custom', path: ['branches', index, 'id'], message: `branch ${branch.id} appears twice in the round` })
      branches.add(branch.id)
    }
  })
export type Round = z.infer<typeof roundSchema>

/** The seeded design tree: exit criteria, then spec sections, then the six review lenses, every branch open. */
export function seedBranches(): Branch[] {
  return GROOM_BRANCHES.map((id) => ({ id, state: 'open' as const }))
}

type FrontierInput = { decisions: readonly Pick<GroomDecision, 'id' | 'branch' | 'decidedBy' | 'prerequisites'>[] }

/**
 * The open questions whose prerequisites are all settled, in id order. On a title-only idea the
 * problem, who and done questions come before any other branch (F43).
 */
export function frontier<R extends FrontierInput>(record: R, idea: string): R['decisions'][number][] {
  const byId = new Map(record.decisions.map((decision) => [decision.id, decision]))
  const settled = (id: string) => {
    const found = byId.get(id)
    return found === undefined || found.decidedBy !== 'open'
  }
  const ready = record.decisions.filter((decision) => decision.decidedBy === 'open' && (decision.prerequisites ?? []).every(settled)).sort((a, b) => compareIds(a.id, b.id))
  if (idea.trim() !== '') return ready
  const first = (decision: (typeof ready)[number]) => EXIT_CRITERIA.some((branch) => branch === decision.branch)
  return [...ready.filter(first), ...ready.filter((decision) => !first(decision))]
}

/**
 * The record after a validated round: its questions added (an open question asked again keeps its
 * id and takes the round's wording), the branch of every question visited, the round's branch states
 * applied, its facts and concepts kept, its round number taken. Throws when the round re-asks a
 * decided question or waits on an id neither the record nor the round has.
 */
export function applyRound(record: GroomRecord, round: Round): GroomRecord {
  const decisions = new Map(record.decisions.map((decision) => [decision.id, decision]))
  for (const question of round.questions) {
    const previous = decisions.get(question.id)
    if (previous !== undefined && previous.decidedBy !== 'open') throw new Error(`${question.id} is already decided; a round never re-asks it`)
    decisions.set(question.id, question)
  }
  for (const question of round.questions) {
    for (const prerequisite of question.prerequisites ?? []) {
      if (!decisions.has(prerequisite)) throw new Error(`${question.id} waits on ${prerequisite}, which is not a question of this card`)
    }
  }
  const seeded = record.branches.length > 0 ? record.branches : seedBranches()
  const tagged = new Set(round.questions.map((question) => question.branch))
  const changes = new Map(round.branches.map((branch) => [branch.id, branch]))
  const branches: Branch[] = seeded.map((branch) => {
    const change = changes.get(branch.id)
    if (change !== undefined) return change.state === 'closed' ? { id: branch.id, state: 'closed', reason: change.reason ?? '' } : { id: branch.id, state: change.state }
    return tagged.has(branch.id) && branch.state === 'open' ? { id: branch.id, state: 'visited' } : branch
  })
  for (const change of round.branches) if (!seeded.some((branch) => branch.id === change.id)) branches.push(change.state === 'closed' ? { id: change.id, state: 'closed', reason: change.reason ?? '' } : { id: change.id, state: change.state })
  const sorted = [...decisions.values()].sort((a, b) => compareIds(a.id, b.id))
  return {
    ...record,
    decisions: sorted,
    branches,
    round: round.round,
    open: sorted.filter((decision) => decision.decidedBy === 'open').length,
    facts: mergeFacts(record.facts ?? [], round.facts),
    searched: [...new Set([...(record.searched ?? []), ...round.searched])],
  }
}

function mergeFacts(kept: readonly Fact[], found: readonly Fact[]): Fact[] {
  const out: Fact[] = []
  const seen = new Set<string>()
  for (const fact of [...kept, ...found]) {
    const key = `${fact.path}:${fact.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}

/** The codebase report that opens the first round (F8): every fact with its citation, or the nothing-found line. */
export function roundZeroReport(round: Pick<Round, 'searched' | 'facts'>): string {
  const concepts = round.searched.join(', ')
  if (round.facts.length === 0) return `Round zero: nothing found for ${concepts}; no term collides`
  const lines = round.facts.map((fact) => `- ${fact.path}:${fact.line}${fact.quote === undefined ? '' : ` — \`${fact.quote}\``}`)
  return [`Round zero: searched ${concepts}; found ${round.facts.length} fact(s)`, ...lines].join('\n')
}

/** The next unused top-level id: the highest `Q<n>` in the record plus one. */
export function nextQuestionId(record: Pick<GroomRecord, 'decisions'>): string {
  const top = Math.max(0, ...record.decisions.map((decision) => Number(decision.id.slice(1).split('.')[0])))
  return `Q${top + 1}`
}

/** Whether every seeded branch has been visited (a question tagged with it, or closed with a reason). */
export const allBranchesVisited = (record: Pick<GroomRecord, 'branches'>): boolean => record.branches.every((branch) => branch.state !== 'open')
