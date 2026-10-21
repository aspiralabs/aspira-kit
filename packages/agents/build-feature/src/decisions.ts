// The decisions an agent took to keep the run going (F11-F14). Each step records them in its own
// export; the driver only reads them, validates each one with the shared schema, keys it
// '<step>:<runId>:<id>' and lists it once. An item that fails the schema is never listed as taken:
// it becomes a question asked in chat (F13). The driver never writes a step's decisions file (F14).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { compareIds, decisionSchema, takenDecision, type DecisionRecord } from '@aspiralabs/agent-common/lib/decisions'
import { groomDecisionSchema } from '@aspiralabs/agent-common/lib/groom-record'
import { STEPS } from '#src/route.ts'
import type { QueuedAsk, RunState, TakenKey } from '#src/run-state.ts'

/** The steps (and the Step 9 fix subagent) whose decisions the run lists. */
export type DecisionStep = 'groomer' | 'spec-writer' | 'planner' | 'implementor' | 'fix'

type Source = {
  /** The export file, relative to the ticket folder. */
  file: string
  /** The list of decisions in that file, or a reason it is not one. */
  list: (json: unknown) => { ok: true; items: unknown[] } | { ok: false; reason: string }
  /** One item: a taken decision, an ask, or nothing (an open or author decision). */
  item: (raw: unknown, index: number) => { kind: 'taken'; decision: DecisionRecord } | { kind: 'ask'; id?: string; question: string; recommended?: string } | { kind: 'skip' }
}

const field =
  (path: readonly string[], required: boolean) =>
  (json: unknown): { ok: true; items: unknown[] } | { ok: false; reason: string } => {
    let value: unknown = json
    for (const key of path) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
    if (value === undefined && !required) return { ok: true, items: [] }
    if (!Array.isArray(value)) return { ok: false, reason: `${path.join('.')} is not a list of decisions` }
    return { ok: true, items: value }
  }

const recordMeta = z.object({ id: z.string().min(1), decidedBy: z.enum(['open', 'author', 'agent']), answer: z.string().nullable() })

/** A quoted, one-line rendering of an item that failed the schema, for the ask stage; `recommended` is what --autonomous answers it with (KIT-24). */
function quote(raw: unknown, reason: string): { id?: string; question: string; recommended?: string } {
  const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const id = typeof value.id === 'string' ? value.id : undefined
  const question = typeof value.question === 'string' ? value.question : JSON.stringify(raw)
  const options = Array.isArray(value.options) ? value.options.filter((option): option is string => typeof option === 'string') : []
  const recommended = typeof value.recommended === 'string' ? value.recommended : null
  const parts = [`${id === undefined ? '' : `${id}: `}${question}`]
  if (options.length > 0) parts.push(`Options: ${options.join(' | ')}`)
  if (recommended !== null) parts.push(`Recommended: ${recommended}`)
  parts.push(`(The agent's decision did not meet the decision rule: ${reason}. Answer it here.)`)
  return { ...(id === undefined ? {} : { id }), question: parts.join('\n'), ...(recommended === null ? {} : { recommended }) }
}

const issues = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join('.') || 'decision'}: ${issue.message}`).join('; ')

/** review.json and plan.json items: the shared decision fields plus id, decidedBy and answer. */
const recordItem: Source['item'] = (raw) => {
  const decision = decisionSchema.safeParse(raw)
  const meta = recordMeta.safeParse(raw)
  if (!decision.success) return { kind: 'ask', ...quote(raw, issues(decision.error)) }
  if (!meta.success) return { kind: 'ask', ...quote(raw, issues(meta.error)) }
  if (meta.data.decidedBy !== 'agent') return { kind: 'skip' }
  return { kind: 'taken', decision: { ...decision.data, ...meta.data } }
}

/** Per step: where its taken decisions are read (F11). */
export const DECISION_SOURCES: Readonly<Record<Exclude<DecisionStep, 'fix'>, Source>> = {
  groomer: {
    file: 'groom/trace/groom.json',
    list: field(['decisions'], true),
    item: (raw) => {
      const parsed = groomDecisionSchema.safeParse(raw)
      if (!parsed.success) return { kind: 'ask', ...quote(raw, issues(parsed.error)) }
      if (parsed.data.decidedBy !== 'agent') return { kind: 'skip' }
      const { id, question, options, recommended, reasoning, whyYours, decidedBy, answer } = parsed.data
      return { kind: 'taken', decision: { id, question, options, recommended, reasoning, whyYours, decidedBy, answer } }
    },
  },
  'spec-writer': { file: 'spec.reviewed/trace/review.json', list: field(['authorDecisions'], false), item: recordItem },
  planner: { file: 'plan.review/trace/plan.json', list: field(['decisions'], true), item: recordItem },
  implementor: {
    file: 'plan.review/trace/implementation-local.json',
    list: field(['verification', 'assumptions'], false),
    item: (raw, index) => {
      const parsed = decisionSchema.safeParse(raw)
      if (!parsed.success) return { kind: 'ask', ...quote(raw, issues(parsed.error)) }
      return { kind: 'taken', decision: takenDecision(`A${index + 1}`, parsed.data) }
    },
  },
}

export const isDecisionStep = (step: string): step is Exclude<DecisionStep, 'fix'> => step in DECISION_SOURCES

export const takenKeyOf = (step: string, runId: string, id: string): string => `${step}:${runId}:${id}`

export type Collected = { ok: true; taken: TakenKey[]; asks: QueuedAsk[] } | { ok: false; message: string }

/** Turn validated items into taken keys and asks. Used for the steps' exports and the fix subagent's decisions. */
export function takeDecisions(step: DecisionStep, runId: string, items: readonly unknown[], item: Source['item'] = recordItem): { taken: TakenKey[]; asks: QueuedAsk[] } {
  const taken: TakenKey[] = []
  const asks: QueuedAsk[] = []
  items.forEach((raw, index) => {
    const outcome = item(raw, index)
    if (outcome.kind === 'taken') taken.push({ key: takenKeyOf(step, runId, outcome.decision.id), step, runId, decision: outcome.decision })
    else if (outcome.kind === 'ask') asks.push({ step, runId, ...(outcome.id === undefined ? {} : { id: outcome.id }), question: outcome.question, ...(outcome.recommended === undefined ? {} : { recommended: outcome.recommended }) })
  })
  return { taken, asks }
}

/** Read a step's taken decisions from its export. A missing or invalid source stops the run naming the step and the file. */
export async function collectTakenDecisions(step: Exclude<DecisionStep, 'fix'>, context: { folder: string; runId: string }): Promise<Collected> {
  const source = DECISION_SOURCES[step]
  const file = join(context.folder, source.file)
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return { ok: false, message: `${step}: its decisions output ${source.file} is missing` }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, message: `${step}: its decisions output ${source.file} is not valid JSON` }
  }
  const list = source.list(json)
  if (!list.ok) return { ok: false, message: `${step}: its decisions output ${source.file} is invalid: ${list.reason}` }
  return { ok: true, ...takeDecisions(step, context.runId, list.items, source.item) }
}

const openItem = z.looseObject({ id: z.string().min(1), question: z.string().min(1), decidedBy: z.literal('open') })

/** The decisions a step left open (`decidedBy: 'open'`), for the stop message of a needs-author result; empty when its export has none or cannot be read. */
export async function openDecisions(step: Exclude<DecisionStep, 'fix'>, folder: string): Promise<{ id: string; question: string }[]> {
  const source = DECISION_SOURCES[step]
  const raw = await readFile(join(folder, source.file), 'utf8').catch(() => null)
  if (raw === null) return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  const list = source.list(json)
  if (!list.ok) return []
  return list.items.flatMap((item) => {
    const parsed = openItem.safeParse(item)
    return parsed.success ? [{ id: parsed.data.id, question: parsed.data.question }] : []
  })
}

/** The state with each taken key added once (F12). */
export function addTaken(state: RunState, taken: readonly TakenKey[]): RunState {
  const known = new Set(state.takenKeys.map((entry) => entry.key))
  const fresh = taken.filter((entry) => {
    if (known.has(entry.key)) return false
    known.add(entry.key)
    return true
  })
  return fresh.length === 0 ? state : { ...state, takenKeys: [...state.takenKeys, ...fresh] }
}

/** Steps after Ready: Plan come first, then the Playbook order, then the id by number. */
const POST_PLAN = ['implementor', 'fix', 'code-analyzer', 'pr-reviewer']
const rank = (step: string): number => {
  const post = POST_PLAN.indexOf(step)
  if (post >= 0) return post
  const order = (STEPS as readonly string[]).indexOf(step)
  return POST_PLAN.length + (order >= 0 ? order : STEPS.length)
}

/** The taken decisions in the order the summary and the PR body list them. */
export function orderedTaken(taken: readonly TakenKey[]): TakenKey[] {
  return [...taken].sort((a, b) => rank(a.step) - rank(b.step) || a.runId.localeCompare(b.runId) || compareIds(a.decision.id, b.decision.id))
}
