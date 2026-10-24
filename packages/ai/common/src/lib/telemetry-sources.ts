// KIT-19 telemetry sources: read-only readers for the usage records the agents already write
// (trace/usage.json, the code-analyzer ledger usage.json, the pr-reviewer usage.jsonl) and for the
// session usage report a --local session writes for its subagents. Each reader validates its file
// with zod and keeps only numbers, times, phase/agent names and model ids; message text, tool
// inputs and results, session and turn ids and everything else in the file are dropped by the
// schemas. Nothing here writes a file.

import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { modelValue, spanName, type Gap, type SpanAttributes, type SpanInput, type USAGE_SCOPE_VALUES } from './telemetry.ts'
import type { Skill } from './ticket.ts'

/** A group of a usage source as a span: one per phase/model, round or agent. */
export type PhaseUsage = SpanInput

/** The usage scope of each agent whose source leaves some model calls out; their spans are partial. */
export const USAGE_SCOPES: Readonly<Partial<Record<Skill, (typeof USAGE_SCOPE_VALUES)[number]>>> = {
  groomer: 'groomer-model-turns',
  'spec-writer': 'spec-writer-model-turns',
  planner: 'planner-model-turns',
}

/** Each skill's usage file, relative to its export dir; null when the skill records none. */
export const HAND_USAGE_SOURCE: Readonly<Record<Skill, { file: string; kind: SourceKind } | null>> = {
  groomer: { file: 'trace/usage.json', kind: 'usage.json' },
  'spec-writer': { file: 'trace/usage.json', kind: 'usage.json' },
  planner: { file: 'trace/usage.json', kind: 'usage.json' },
  'code-analyzer': { file: 'usage.json', kind: 'ledger' },
  'pr-reviewer': { file: 'usage.jsonl', kind: 'usage.jsonl' },
  implementor: null,
}

export type SourceKind = 'usage.json' | 'ledger' | 'usage.jsonl'

// ---------------------------------------------------------------------------------------------
// Schemas. z.object strips every key it does not name.
// ---------------------------------------------------------------------------------------------

const count = z.number().finite().nonnegative()
const tokensSchema = z.object({ inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional() })
/** gateway.cost as a number or a numeric string; anything else is not measured. */
const costSchema = z
  .unknown()
  .transform((value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : Number.NaN))
  .transform((value) => (Number.isFinite(value) && value >= 0 ? value : null))
const providerSchema = z.object({ gateway: z.object({ cost: costSchema }).optional() }).optional().catch(undefined)
const toolCallsSchema = z
  .array(z.unknown())
  .transform((calls) => calls.length)
  .optional()

const turnFields = {
  model: z.string(),
  startedMs: count,
  durationMs: count.optional(),
  status: z.string().optional(),
  usage: tokensSchema.optional(),
  providerMetadata: providerSchema,
  toolCalls: toolCallsSchema,
}

/** One trace/usage.json turn (run-analysis.ts UsageEntry), numbers only. */
const usageEntrySchema = z.object({ phase: z.string(), ...turnFields })
export const usageEntryFileSchema = z.object({ scope: z.string().optional(), turns: z.array(usageEntrySchema) })
export type UsageEntryTurn = z.infer<typeof usageEntrySchema>

/** One code-analyzer ledger turn (ledger.ts Turn), numbers only. */
const ledgerTurnSchema = z.object({ round: z.number().int().nonnegative(), ...turnFields, model: z.string().optional() })
export const ledgerFileSchema = z.object({ scope: z.string().optional(), model: z.string().optional(), turns: z.array(ledgerTurnSchema) })
export type LedgerTurn = z.infer<typeof ledgerTurnSchema>

/** One pr-reviewer usage.jsonl line (usage.ts UsageLine), numbers only. */
export const usageLineSchema = z.object({
  agent: z.string(),
  at: z.string(),
  startedAt: z.string().optional(),
  durationMs: count.optional(),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: count.nullable(),
})
export type UsageLine = z.infer<typeof usageLineSchema>

/** One subagent of the session usage report; labels never reach the file. */
const subagentEntrySchema = z.object({
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  totalTokens: count.optional(),
  toolUses: count.optional(),
  wallMs: count.optional(),
  model: z.string().transform(modelValue).optional(),
})
type SubagentEntry = z.infer<typeof subagentEntrySchema>

/** The session usage report: the run id and the subagents, each entry checked on its own. */
export const sessionUsageSchema = z.object({
  runId: z.string(),
  subagents: z.array(z.unknown().transform((value) => {
    const parsed = subagentEntrySchema.safeParse(value)
    return parsed.success ? { valid: true as const, entry: parsed.data } : { valid: false as const }
  })),
})
export type SessionUsage = z.infer<typeof sessionUsageSchema>

// ---------------------------------------------------------------------------------------------
// Reducers.
// ---------------------------------------------------------------------------------------------

/** The parent interval a group is anchored to and clamped within (ISO or epoch ms). */
export type Interval = { start: string | number; end: string | number }

const toMs = (value: string | number): number => (typeof value === 'number' ? value : Date.parse(value))

/** A sum over values where null is not measured: null when none is measured, and whether any is missing. */
function sumOf(values: (number | null | undefined)[]): { value: number | null; missing: boolean } {
  const known = values.filter((value): value is number => typeof value === 'number')
  return { value: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0), missing: known.length < values.length }
}

/** The total of one turn: its totalTokens, else input plus output when both are present. */
const turnTotal = (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): number | null =>
  usage?.totalTokens ?? (usage?.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : null)

/** The status word of a group of turns: failed, running or completed. */
const groupStatus = (statuses: (string | undefined)[]): string => (statuses.includes('failed') ? 'failed' : statuses.includes('running') ? 'running' : 'completed')

const clampTo = (interval: Interval, start: number, end: number): { start: number; end: number } => {
  const low = toMs(interval.start)
  const high = Math.max(low, toMs(interval.end))
  const from = Math.min(Math.max(start, low), high)
  return { start: from, end: Math.min(Math.max(end, from), high) }
}

type Turnish = { startedMs: number; durationMs?: number; status?: string; usage?: z.infer<typeof tokensSchema>; providerMetadata?: { gateway?: { cost: number | null } }; toolCalls?: number }

/** One group of offset-timed turns (UsageEntry or ledger Turn) as a span anchored at the interval start. */
function turnGroup(name: string, model: string | null, turns: Turnish[], interval: Interval, scope: SpanAttributes['aspira.usage_scope']): PhaseUsage {
  const anchor = toMs(interval.start)
  const input = sumOf(turns.map((turn) => turn.usage?.inputTokens))
  const output = sumOf(turns.map((turn) => turn.usage?.outputTokens))
  const total = sumOf(turns.map((turn) => turnTotal(turn.usage)))
  const cost = sumOf(turns.map((turn) => turn.providerMetadata?.gateway?.cost))
  const tools = sumOf(turns.map((turn) => turn.toolCalls))
  const first = Math.min(...turns.map((turn) => turn.startedMs))
  const last = Math.max(...turns.map((turn) => turn.startedMs + (turn.durationMs ?? 0)))
  const time = clampTo(interval, anchor + first, anchor + last)
  const partial = scope !== undefined || [input, output, total, cost, tools].some((sum) => sum.missing)
  return {
    name: spanName(name),
    kind: 'phase',
    start: time.start,
    end: time.end,
    status: groupStatus(turns.map((turn) => turn.status)),
    usage: { model: model === null ? null : modelValue(model), inputTokens: input.value, outputTokens: output.value, totalTokens: total.value, cacheRead: null, cacheWrite: null, toolCalls: tools.value, costUsd: cost.value },
    attributes: {
      'aspira.time.anchored': true,
      'aspira.time_basis': 'model+tools',
      ...(tools.value === null ? {} : { 'aspira.tool_count_basis': 'turn toolCalls entries' as const }),
      ...(scope === undefined ? {} : { 'aspira.usage_scope': scope }),
      ...(partial ? { 'aspira.partial': true } : {}),
    },
  }
}

/** Group items by a key, keeping first-seen order; each group carries its first item. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): { head: T; group: T[] }[] {
  const groups = new Map<string, { head: T; group: T[] }>()
  for (const item of items) {
    const found = groups.get(key(item))
    groups.set(key(item), found === undefined ? { head: item, group: [item] } : { head: found.head, group: [...found.group, item] })
  }
  return [...groups.values()]
}

/** trace/usage.json turns as one group per phase/model. */
export function reduceUsageEntries(turns: readonly UsageEntryTurn[], options: Interval & { skill: Skill }): PhaseUsage[] {
  return groupBy(turns, (turn) => JSON.stringify([turn.phase, turn.model])).map(({ head, group }) => turnGroup(head.phase, head.model, group, options, USAGE_SCOPES[options.skill]))
}

/** The code-analyzer ledger turns as one group per round, with the turn's model or the ledger's. */
export function reduceLedgerTurns(file: z.infer<typeof ledgerFileSchema>, options: Interval & { skill: Skill }): PhaseUsage[] {
  return groupBy(file.turns, (turn) => String(turn.round)).map(({ head, group }) => turnGroup(`round-${head.round}`, head.model ?? file.model ?? null, group, options, USAGE_SCOPES[options.skill]))
}

/** pr-reviewer usage lines as one group per agent; the model comes from the caller's map. */
export function reduceUsageLines(lines: readonly UsageLine[], options: Interval & { models?: Readonly<Record<string, string>> }): PhaseUsage[] {
  const anchor = toMs(options.start)
  return groupBy(lines, (line) => line.agent).map(({ head, group }) => {
    const times = group.map((line) => {
      const end = Date.parse(line.at)
      const start = line.startedAt !== undefined ? Date.parse(line.startedAt) : line.durationMs !== undefined && Number.isFinite(end) ? end - line.durationMs : Number.NaN
      const anchored = !Number.isFinite(start)
      return { start: anchored ? anchor : start, end: Number.isFinite(end) ? end : anchor, anchored }
    })
    const time = clampTo(options, Math.min(...times.map((item) => item.start)), Math.max(...times.map((item) => item.end)))
    const input = sumOf(group.map((line) => line.inputTokens))
    const output = sumOf(group.map((line) => line.outputTokens))
    const cost = sumOf(group.map((line) => line.costUsd))
    const model = options.models?.[head.agent]
    const anchored = times.some((item) => item.anchored)
    return {
      name: spanName(head.agent),
      kind: 'phase',
      start: time.start,
      end: time.end,
      usage: {
        model: model === undefined ? null : modelValue(model),
        inputTokens: input.value,
        outputTokens: output.value,
        totalTokens: input.value !== null && output.value !== null ? input.value + output.value : null,
        cacheRead: sumOf(group.map((line) => line.cacheReadTokens)).value,
        cacheWrite: sumOf(group.map((line) => line.cacheWriteTokens)).value,
        toolCalls: null,
        costUsd: cost.value,
      },
      attributes: { 'aspira.time_basis': 'model-only', ...(anchored ? { 'aspira.time.anchored': true } : {}), ...(cost.missing ? { 'aspira.partial': true } : {}) },
    } satisfies PhaseUsage
  })
}

// ---------------------------------------------------------------------------------------------
// File readers.
// ---------------------------------------------------------------------------------------------

export type SourceResult = { groups: PhaseUsage[] } | { gap: Gap }

const errorCode = (error: unknown): string | undefined => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined)

/** JSON.parse without throwing. */
const parseJson = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

/**
 * Read one usage file into span groups, or the gap that kept it out: missing, invalid, empty (no
 * turns), or stale (its mtime lies outside the run's interval, so it is another run's file).
 */
export async function readUsageSource(file: string, options: Interval & { kind: SourceKind; skill: Skill; models?: Readonly<Record<string, string>> }): Promise<SourceResult> {
  let raw: string
  let mtime: number
  try {
    mtime = (await stat(file)).mtimeMs
    raw = await readFile(file, 'utf8')
  } catch (error) {
    return { gap: errorCode(error) === 'ENOENT' ? 'missing' : 'invalid' }
  }
  if (mtime < toMs(options.start) || mtime > toMs(options.end)) return { gap: 'stale' }
  const groups = parseSource(raw, options)
  if (groups === null) return { gap: 'invalid' }
  return groups.length === 0 ? { gap: 'empty' } : { groups }
}

function parseSource(raw: string, options: Interval & { kind: SourceKind; skill: Skill; models?: Readonly<Record<string, string>> }): PhaseUsage[] | null {
  switch (options.kind) {
    case 'usage.json': {
      const json = parseJson(raw)
      const parsed = json.ok ? usageEntryFileSchema.safeParse(json.value) : null
      return parsed?.success === true ? reduceUsageEntries(parsed.data.turns, options) : null
    }
    case 'ledger': {
      const json = parseJson(raw)
      const parsed = json.ok ? ledgerFileSchema.safeParse(json.value) : null
      return parsed?.success === true ? reduceLedgerTurns(parsed.data, options) : null
    }
    case 'usage.jsonl': {
      const lines: UsageLine[] = []
      for (const text of raw.split('\n')) {
        if (text.trim() === '') continue
        const json = parseJson(text)
        const parsed = json.ok ? usageLineSchema.safeParse(json.value) : null
        if (parsed?.success !== true) return null
        lines.push(parsed.data)
      }
      return reduceUsageLines(lines, options)
    }
    default: {
      const never: never = options.kind
      return never
    }
  }
}

/** Read the session usage report a --local session wrote for its subagents. */
export async function readSessionUsage(file: string): Promise<{ usage: SessionUsage } | { gap: 'missing' | 'invalid' }> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    return { gap: errorCode(error) === 'ENOENT' ? 'missing' : 'invalid' }
  }
  const json = parseJson(raw)
  const parsed = json.ok ? sessionUsageSchema.safeParse(json.value) : null
  return parsed?.success === true ? { usage: parsed.data } : { gap: 'invalid' }
}

/** One subagent's span from a valid entry: total tokens only (input/output not measured), tool uses and the reported wall time. */
function subagentSpan(name: string, entry: SubagentEntry, parent: Interval): SpanInput {
  const parentStart = toMs(parent.start)
  const startedAt = entry.startedAt === undefined ? Number.NaN : Date.parse(entry.startedAt)
  const endedAt = entry.endedAt === undefined ? Number.NaN : Date.parse(entry.endedAt)
  const wall = entry.wallMs
  const start = Number.isFinite(startedAt) ? startedAt : Number.isFinite(endedAt) && wall !== undefined ? endedAt - wall : null
  const anchored = start === null
  const from = start ?? parentStart
  const end = Number.isFinite(endedAt) ? endedAt : from + (wall ?? 0)
  const time = clampTo(parent, from, end)
  return {
    name,
    kind: 'subagent',
    start: time.start,
    end: time.end,
    usage: { model: entry.model ?? null, inputTokens: null, outputTokens: null, totalTokens: entry.totalTokens ?? null, cacheRead: null, cacheWrite: null, toolCalls: entry.toolUses ?? null, costUsd: null },
    attributes: {
      ...(entry.toolUses === undefined ? {} : { 'aspira.tool_count_basis': 'agent tool uses' as const }),
      ...(wall === undefined ? {} : { 'aspira.reported_wall_ms': wall }),
      ...(anchored ? { 'aspira.time.anchored': true } : {}),
    },
  }
}

/** One span per subagent of the report, named subagent-1..n; an entry that failed its schema keeps a span with every number not measured and gap invalid. */
export function subagentSpans(usage: SessionUsage, parent: Interval): SpanInput[] {
  const parentStart = toMs(parent.start)
  return usage.subagents.map((item, index) => {
    const name = `subagent-${index + 1}`
    if (item.valid) return subagentSpan(name, item.entry, parent)
    return {
      name,
      kind: 'subagent',
      start: parentStart,
      end: parentStart,
      usage: { model: null, inputTokens: null, outputTokens: null, totalTokens: null, cacheRead: null, cacheWrite: null, toolCalls: null, costUsd: null },
      attributes: { 'aspira.gap': 'invalid', 'aspira.time.anchored': true },
    }
  })
}
