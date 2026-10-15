// KIT-19 run telemetry: one OTLP/JSON trace file per run, written by hand (no OpenTelemetry
// dependency). The span tree comes in as plain values; every string that reaches the file is
// drawn from a closed set here, so no prompt or response text, tool input or output, file path,
// error message, session id or nonce can be written. The file is created once and never replaced,
// and every failure to write it is returned, never thrown (OBS-002): telemetry never changes a
// run's status or exit code.

import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { GROOM_RUN_STATUSES } from './groom-record.ts'
import { LENSES } from './lenses.ts'
import { RUN_STATUSES, SKILLS } from './ticket.ts'
import { FlowRefused } from './ticket-flow.ts'

/** The value of the resource attribute `aspira.telemetry.schema`. */
export const TELEMETRY_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------------------------
// The span tree a caller hands in.
// ---------------------------------------------------------------------------------------------

/** What a span stands for; it picks the status-code rule. */
export const SPAN_KINDS = ['hand-run', 'build-feature', 'step', 'phase', 'turn', 'subagent', 'fix', 'orchestration', 'segment'] as const
export type SpanKind = (typeof SPAN_KINDS)[number]

/** Why a source gave no usage. */
export const GAPS = ['missing', 'empty', 'invalid', 'stale'] as const
export type Gap = (typeof GAPS)[number]

/** How a span's time was measured. */
export const TIME_BASES = ['model+tools', 'model-only'] as const
/** What a tool-call count counts. */
export const TOOL_COUNT_BASES = ['turn toolCalls entries', 'agent tool uses'] as const
/** The one usage-scope value per agent whose usage source leaves some model calls out (telemetry-sources.ts USAGE_SCOPES). */
export const USAGE_SCOPE_VALUES = ['groomer-model-turns', 'spec-writer-model-turns', 'spec-reviewer-model-turns', 'planner-model-turns'] as const
/** The run modes the resource names. */
export const MODES = ['local', 'default', 'cloud'] as const

/**
 * A span's own usage: what its own model calls used, children not included. A `null` or absent
 * value is not measured; 0 is a measured 0.
 */
export type SpanUsage = {
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  toolCalls?: number | null
  costUsd?: number | null
}

/** The extra keys a span may carry, each from its closed set. */
export type SpanAttributes = {
  'aspira.segment'?: boolean
  'aspira.gap'?: Gap
  'aspira.time.anchored'?: boolean
  'aspira.reported_wall_ms'?: number
  'aspira.time_basis'?: (typeof TIME_BASES)[number]
  'aspira.tool_count_basis'?: (typeof TOOL_COUNT_BASES)[number]
  'aspira.usage_scope'?: (typeof USAGE_SCOPE_VALUES)[number]
  'aspira.partial'?: boolean
  'aspira.orchestration.duration_ms'?: number
}

/**
 * One span of the tree. `start`/`end` are ISO strings or epoch ms. `usage` absent means the span
 * makes no model calls of its own (a container); present, each unmeasured value is listed in
 * `aspira.not_measured`.
 */
export type SpanInput = {
  name: string
  kind: SpanKind
  start: string | number
  end: string | number
  status?: string
  verdict?: 'continue' | 'stop'
  usage?: SpanUsage
  attributes?: SpanAttributes
  children?: SpanInput[]
}

/** The resource of a trace: who wrote it and for which run. */
export type TelemetryResource = { kitVersion: string; ticketId: string; runId: string; mode: string }

// ---------------------------------------------------------------------------------------------
// Closed sets.
// ---------------------------------------------------------------------------------------------

/** Each agent's phase and agent names, as their usage records name them. */
export const PHASE_NAMES = [
  // groomer
  'facts', 'round', 'summary',
  // spec-writer
  'explore', 'draft', 'review',
  // spec-reviewer
  'research', 'synthesis', ...LENSES,
  // planner
  'planning',
  // pr-reviewer seats
  'ava', 'cole', 'dex', 'iris', 'nova', 'quinn', 'reba',
] as const

/** The build-feature driver's stage kinds (build-feature driver.ts STAGE_KINDS; agent-common cannot import build-feature), plus the telemetry stage and the orchestration labels. */
export const STAGE_NAMES = ['resolve', 'approval', 'overrides', 'worktree', 'step', 'ask', 'move', 'set-pr', 'gate', 'step10', 'fix', 'release-row', 'summary', 'end', 'telemetry', 'orchestration', 'segment'] as const

/** Every fixed span name. Numbered labels (subagent-<n>, round-<n>, repair-<n>, segment-<n>) are matched by NUMBERED_NAME. */
export const SPAN_NAMES: readonly string[] = [...new Set<string>([...SKILLS, 'build-feature', ...PHASE_NAMES, ...STAGE_NAMES])]
const NUMBERED_NAME = /^(subagent|round|repair|segment)-[1-9]\d{0,5}$/

/** The step result words of build-feature's stepResultTable (agent-common cannot import build-feature). */
const STEP_RESULT_WORDS = ['confirmed', 'needs-author', 'stopped', 'incomplete', 'ready', 'complete', 'refused', 'blocked', 'clean'] as const

/** Every status word the file may carry. */
export const STATUS_WORDS: readonly string[] = [
  ...new Set<string>([...RUN_STATUSES, ...GROOM_RUN_STATUSES, ...STEP_RESULT_WORDS, 'refused', 'blocked', 'nothing-detected', 'failed', 'running', 'completed', 'stopped', 'finished', 'replaced', 'moved', 'complete', 'not measured']),
]

/** A model id as the gateway names it: provider/model, lowercase. */
export const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.:-]*)?$/
const MODEL_MAX = 100
const RUN_ID_PATTERN = /^run-\d{8}T\d{6}Z(-\d+)?$/
const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,40})?$/
const OTHER = 'other'

const spanNames: ReadonlySet<string> = new Set(SPAN_NAMES)
const statusWords: ReadonlySet<string> = new Set(STATUS_WORDS)

/** A span name from the closed set, or 'other'. */
export const spanName = (name: string): string => (spanNames.has(name) || NUMBERED_NAME.test(name) ? name : OTHER)

/** A status word from the closed set, or 'other'. */
export const statusWord = (word: string): string => (statusWords.has(word) ? word : OTHER)

/** A model id matching MODEL_PATTERN and at most 100 characters, or 'other'. */
export const modelValue = (model: string): string => (model.length <= MODEL_MAX && MODEL_PATTERN.test(model) ? model : OTHER)

const inSet = <T extends string>(set: readonly T[], value: string): T | null => set.find((item) => item === value) ?? null

// ---------------------------------------------------------------------------------------------
// Status codes.
// ---------------------------------------------------------------------------------------------

export type StatusCode = 'UNSET' | 'OK' | 'ERROR'
const STATUS_CODE_NUMBER: Readonly<Record<StatusCode, number>> = { UNSET: 0, OK: 1, ERROR: 2 }

/** The OTLP status code of a span from its kind, its status word and (for a step) the stored verdict. */
export function statusCode(kind: SpanKind, word: string | undefined, verdict?: 'continue' | 'stop'): StatusCode {
  switch (kind) {
    case 'step':
      return verdict === 'continue' ? 'OK' : verdict === 'stop' ? 'ERROR' : 'UNSET'
    case 'hand-run':
      if (word === 'ready' || word === 'complete' || word === 'clean' || word === 'confirmed') return 'OK'
      if (word === 'incomplete' || word === 'refused') return 'ERROR'
      return 'UNSET'
    case 'build-feature':
      return word === 'finished' ? 'OK' : word === 'stopped' ? 'ERROR' : 'UNSET'
    case 'turn':
      return word === 'completed' ? 'OK' : word === 'failed' ? 'ERROR' : 'UNSET'
    case 'fix':
      return 'OK'
    case 'phase':
    case 'subagent':
    case 'orchestration':
    case 'segment':
      return 'UNSET'
    default: {
      const never: never = kind
      return never
    }
  }
}

// ---------------------------------------------------------------------------------------------
// OTLP/JSON encoding.
// ---------------------------------------------------------------------------------------------

export type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: { stringValue: string }[] } }
export type OtlpAttribute = { key: string; value: OtlpValue }
export type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  status: { code: number }
}
export type OtlpTrace = { resourceSpans: { resource: { attributes: OtlpAttribute[] }; scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[] }[] }

const str = (key: string, value: string): OtlpAttribute => ({ key, value: { stringValue: value } })
const int = (key: string, value: number): OtlpAttribute => ({ key, value: { intValue: String(Math.max(0, Math.round(value))) } })
const dbl = (key: string, value: number): OtlpAttribute => ({ key, value: { doubleValue: value } })
const bool = (key: string, value: boolean): OtlpAttribute => ({ key, value: { boolValue: value } })

/** Epoch ms from an ISO string or epoch ms; 0 when it does not parse. */
const toMs = (value: string | number): number => {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
}
const nanos = (ms: number): string => (BigInt(ms) * 1_000_000n).toString()
const hex = (bytes: number): string => randomBytes(bytes).toString('hex')

/** The numeric usage keys, in the order they are written, with their attribute key and encoding. */
const NUMBER_KEYS = [
  { field: 'inputTokens', key: 'aspira.tokens.input', double: false },
  { field: 'outputTokens', key: 'aspira.tokens.output', double: false },
  { field: 'totalTokens', key: 'aspira.tokens.total', double: false },
  { field: 'cacheRead', key: 'aspira.tokens.cache_read', double: false },
  { field: 'cacheWrite', key: 'aspira.tokens.cache_write', double: false },
  { field: 'toolCalls', key: 'aspira.tool_calls', double: false },
  { field: 'costUsd', key: 'aspira.cost_usd', double: true },
] as const satisfies readonly { field: keyof SpanUsage; key: string; double: boolean }[]

const measured = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const numberAttribute = (key: string, value: number, double: boolean): OtlpAttribute => (double ? dbl(key, value) : int(key, value))

/** Every span of a subtree, the span first. */
const subtree = (span: SpanInput): SpanInput[] => [span, ...(span.children ?? []).flatMap(subtree)]

/** Self usage attributes and the keys not measured. A span without usage writes neither. */
function selfUsage(span: SpanInput): { attributes: OtlpAttribute[]; notMeasured: string[] } {
  const usage = span.usage
  if (usage === undefined) return { attributes: [], notMeasured: [] }
  const attributes: OtlpAttribute[] = []
  const notMeasured: string[] = []
  if (typeof usage.model === 'string') attributes.push(str('aspira.model', modelValue(usage.model)))
  else notMeasured.push('aspira.model')
  for (const { field, key, double } of NUMBER_KEYS) {
    const value = usage[field]
    if (measured(value)) attributes.push(numberAttribute(key, value, double))
    else notMeasured.push(key)
  }
  return { attributes, notMeasured }
}

/** The inclusive sums over a span with children: self plus every descendant's self. */
function inclusiveUsage(span: SpanInput): { attributes: OtlpAttribute[]; notMeasured: string[]; partial: boolean } {
  const withUsage = subtree(span).flatMap((each) => (each.usage === undefined ? [] : [each.usage]))
  const attributes: OtlpAttribute[] = []
  const notMeasured: string[] = []
  let partial = subtree(span).slice(1).some((each) => each.attributes?.['aspira.partial'] === true)
  for (const { field, key, double } of NUMBER_KEYS) {
    const values = withUsage.map((usage) => usage[field])
    const known = values.filter(measured)
    if (known.length < values.length) partial = true
    const inclusiveKey = `${key}_inclusive`
    if (known.length === 0) notMeasured.push(inclusiveKey)
    else attributes.push(numberAttribute(inclusiveKey, known.reduce((sum, value) => sum + value, 0), double))
  }
  return { attributes, notMeasured, partial }
}

/** The extra attributes a span carries, each checked against its closed set. */
function extraAttributes(extra: SpanAttributes | undefined): OtlpAttribute[] {
  if (extra === undefined) return []
  const out: OtlpAttribute[] = []
  if (typeof extra['aspira.segment'] === 'boolean') out.push(bool('aspira.segment', extra['aspira.segment']))
  const gap = extra['aspira.gap'] === undefined ? null : inSet(GAPS, extra['aspira.gap'])
  if (gap !== null) out.push(str('aspira.gap', gap))
  if (typeof extra['aspira.time.anchored'] === 'boolean') out.push(bool('aspira.time.anchored', extra['aspira.time.anchored']))
  if (measured(extra['aspira.reported_wall_ms'])) out.push(int('aspira.reported_wall_ms', extra['aspira.reported_wall_ms']))
  const basis = extra['aspira.time_basis'] === undefined ? null : inSet(TIME_BASES, extra['aspira.time_basis'])
  if (basis !== null) out.push(str('aspira.time_basis', basis))
  const toolBasis = extra['aspira.tool_count_basis'] === undefined ? null : inSet(TOOL_COUNT_BASES, extra['aspira.tool_count_basis'])
  if (toolBasis !== null) out.push(str('aspira.tool_count_basis', toolBasis))
  const scope = extra['aspira.usage_scope'] === undefined ? null : inSet(USAGE_SCOPE_VALUES, extra['aspira.usage_scope'])
  if (scope !== null) out.push(str('aspira.usage_scope', scope))
  if (measured(extra['aspira.orchestration.duration_ms'])) out.push(int('aspira.orchestration.duration_ms', extra['aspira.orchestration.duration_ms']))
  return out
}

/** OTLP span kind INTERNAL. */
const SPAN_KIND_INTERNAL = 1

function encodeSpan(span: SpanInput, traceId: string, parent: { spanId: string; start: number; end: number } | null, out: OtlpSpan[]): void {
  const rawStart = toMs(span.start)
  const rawEnd = Math.max(rawStart, toMs(span.end))
  const start = parent === null ? rawStart : Math.min(Math.max(rawStart, parent.start), parent.end)
  const end = parent === null ? rawEnd : Math.min(Math.max(rawEnd, start), parent.end)
  const spanId = hex(8)
  const self = selfUsage(span)
  const children = span.children ?? []
  const inclusive = children.length > 0 ? inclusiveUsage(span) : { attributes: [], notMeasured: [], partial: false }
  const extra = extraAttributes(span.attributes)
  const orchestration = span.attributes?.['aspira.orchestration.duration_ms']
  const duration = span.kind === 'orchestration' && measured(orchestration) ? orchestration : end - start
  const partial = span.attributes?.['aspira.partial'] === true || inclusive.partial
  const notMeasured = [...self.notMeasured, ...inclusive.notMeasured]
  const attributes: OtlpAttribute[] = [
    int('aspira.duration_ms', duration),
    ...(span.status === undefined ? [] : [str('aspira.status', statusWord(span.status))]),
    ...self.attributes,
    ...inclusive.attributes,
    ...extra,
    ...(partial ? [bool('aspira.partial', true)] : []),
    ...(notMeasured.length > 0 ? [{ key: 'aspira.not_measured', value: { arrayValue: { values: notMeasured.map((key) => ({ stringValue: key })) } } }] : []),
  ]
  out.push({
    traceId,
    spanId,
    ...(parent === null ? {} : { parentSpanId: parent.spanId }),
    name: spanName(span.name),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes,
    status: { code: STATUS_CODE_NUMBER[statusCode(span.kind, span.status, span.verdict)] },
  })
  for (const child of children) encodeSpan(child, traceId, { spanId, start, end }, out)
}

/** The resource attributes: service name, kit version, ticket id, run id, mode and the schema version. */
function resourceAttributes(resource: TelemetryResource): OtlpAttribute[] {
  return [
    str('service.name', 'aspira-kit'),
    str('service.version', VERSION_PATTERN.test(resource.kitVersion) ? resource.kitVersion : OTHER),
    str('aspira.ticket.id', TICKET_ID_PATTERN.test(resource.ticketId) ? resource.ticketId : OTHER),
    str('aspira.run.id', RUN_ID_PATTERN.test(resource.runId) ? resource.runId : OTHER),
    str('aspira.mode', inSet(MODES, resource.mode) ?? OTHER),
    int('aspira.telemetry.schema', TELEMETRY_SCHEMA_VERSION),
  ]
}

/** The span tree as one OTLP/JSON trace: one resource, one scope, a fresh trace id and a span id per span. */
export function encodeTrace(tree: SpanInput, resource: TelemetryResource): OtlpTrace {
  const spans: OtlpSpan[] = []
  encodeSpan(tree, hex(16), null, spans)
  return { resourceSpans: [{ resource: { attributes: resourceAttributes(resource) }, scopeSpans: [{ scope: { name: 'aspira-kit' }, spans }] }] }
}

// ---------------------------------------------------------------------------------------------
// Run ids and the telemetry file.
// ---------------------------------------------------------------------------------------------

/** Where a ticket folder keeps its telemetry files. */
export const telemetryDir = (folder: string): string => join(folder, 'telemetry')
/** The telemetry file of one run. */
export const telemetryFile = (folder: string, runId: string): string => join(telemetryDir(folder), `${runId}.json`)
const localTelemetryDir = (folder: string): string => join(folder, '.local', 'telemetry')
const pendingFile = (folder: string, runId: string): string => join(localTelemetryDir(folder), `${runId}.pending`)

const errorCode = (error: unknown): string | undefined => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined)
const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  )

const MAX_SUFFIX = 1000

/**
 * Reserve a run id from the run's start time: run-<ISO start without fractional seconds, '-' and
 * ':'>, then -1, -2… while that id's .pending marker or telemetry file exists. The marker is
 * exclusive-created, so two runs started in the same second get different ids.
 */
export async function reserveRunId(folder: string, startedAt: string): Promise<string> {
  const iso = new Date(toMs(startedAt)).toISOString()
  const base = `run-${iso.replace(/\.\d+Z$/, 'Z').replaceAll('-', '').replaceAll(':', '')}`
  await mkdir(localTelemetryDir(folder), { recursive: true })
  for (let n = 0; n <= MAX_SUFFIX; n += 1) {
    const id = n === 0 ? base : `${base}-${n}`
    if (await exists(telemetryFile(folder, id))) continue
    try {
      const handle = await open(pendingFile(folder, id), 'wx')
      await handle.close()
      return id
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  throw new Error(`no free run id after ${MAX_SUFFIX} tries`)
}

/** Remove a run id's .pending marker. Never throws. */
export async function releaseRunId(folder: string, runId: string): Promise<void> {
  await rm(pendingFile(folder, runId), { force: true }).catch(() => undefined)
}

export type WriteResult = { ok: true; path: string } | { ok: false; reason: string }

const resourceRunId = (document: OtlpTrace): string | undefined => {
  const value = document.resourceSpans[0]?.resource.attributes.find((item) => item.key === 'aspira.run.id')?.value
  return value !== undefined && 'stringValue' in value ? value.stringValue : undefined
}

/**
 * Create telemetry/<run-id>.json, never replacing a file: the document goes to a temp file that
 * is then hard-linked to the target, which fails when the target exists. Removes the run's
 * .pending marker on success. Returns the result; never throws (OBS-002).
 */
export async function writeTelemetry(folder: string, runId: string, document: OtlpTrace): Promise<WriteResult> {
  if (!RUN_ID_PATTERN.test(runId)) return { ok: false, reason: 'the run id is not a run id' }
  if (resourceRunId(document) !== runId) return { ok: false, reason: 'the trace names a different run id than its file' }
  const target = telemetryFile(folder, runId)
  const temp = join(telemetryDir(folder), `.${runId}.${hex(6)}.tmp`)
  try {
    await mkdir(telemetryDir(folder), { recursive: true })
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
    try {
      await link(temp, target)
    } catch (error) {
      return { ok: false, reason: errorCode(error) === 'EEXIST' ? 'the telemetry file for this run already exists' : 'the telemetry file could not be created' }
    }
    await releaseRunId(folder, runId)
    return { ok: true, path: target }
  } catch {
    return { ok: false, reason: 'the telemetry file could not be written' }
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------------------------
// The attach dedup record.
// ---------------------------------------------------------------------------------------------

const attachedSchema = z.object({ runId: z.string().regex(RUN_ID_PATTERN), blockId: z.string().min(1) })
export type AttachedRecord = z.infer<typeof attachedSchema>

/** Where the record that a run's telemetry file was attached to the ticket lives. */
export const attachedRecord = (folder: string, runId: string): string => join(localTelemetryDir(folder), 'attached', `${runId}.json`)

/** The attach record of a run, or null when there is none or it is not valid. */
export async function readAttached(folder: string, runId: string): Promise<AttachedRecord | null> {
  const raw = await readFile(attachedRecord(folder, runId), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed = attachedSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Exclusive-create the attach record. True when this call created it, false when one already existed. */
export async function recordAttached(folder: string, record: AttachedRecord): Promise<boolean> {
  const valid = attachedSchema.parse(record)
  const file = attachedRecord(folder, valid.runId)
  await mkdir(join(localTelemetryDir(folder), 'attached'), { recursive: true })
  try {
    await writeFile(file, `${JSON.stringify(valid, null, 2)}\n`, { flag: 'wx' })
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// The BOARD-003 gate, --parent-run and the notice.
// ---------------------------------------------------------------------------------------------

/** Whether the rules allow the run telemetry file block: one line names both BOARD-003 and the run telemetry file. */
export const listsTelemetry = (rules: string): boolean => rules.split('\n').some((line) => line.includes('BOARD-003') && line.includes('run telemetry file'))

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** --parent-run '<run-id>:<nonce>': a build-feature run id and a UUID nonce. */
export const parentRunSchema = z
  .string()
  .transform((value) => {
    const at = value.indexOf(':')
    return at < 0 ? { runId: value, nonce: '' } : { runId: value.slice(0, at), nonce: value.slice(at + 1) }
  })
  .pipe(z.object({ runId: z.string().regex(RUN_ID_PATTERN), nonce: z.string().regex(UUID_PATTERN) }))
export type ParentRun = z.infer<typeof parentRunSchema>

/** The parts of build-feature's state.json the check reads. */
const parentStateSchema = z.object({
  inProgress: z.object({ runId: z.string() }).nullable().optional(),
  pending: z.object({ kind: z.string(), nonce: z.string() }).nullable().optional(),
  steps: z.array(z.object({ runId: z.string().optional(), nonce: z.string().optional() })).optional(),
})

/**
 * Check a --parent-run value against the build-feature run state in the ticket folder: the run must
 * be in progress and the nonce must be its pending step's, or, at finish only, the nonce of a step
 * of that run the driver already accepted. Anything else throws FlowRefused naming --parent-run.
 */
export async function checkParentRun(folder: string, value: string, when: 'start' | 'finish'): Promise<ParentRun> {
  const parsed = parentRunSchema.safeParse(value)
  if (!parsed.success) throw new FlowRefused('--parent-run must be <run-id>:<nonce>, the build-feature run id and the nonce of its pending step')
  const { runId, nonce } = parsed.data
  const raw = await readFile(join(folder, '.local', 'build-feature', 'state.json'), 'utf8').catch(() => null)
  let state: z.infer<typeof parentStateSchema> | null = null
  if (raw !== null) {
    try {
      const result = parentStateSchema.safeParse(JSON.parse(raw))
      state = result.success ? result.data : null
    } catch {
      state = null
    }
  }
  if (state === null) throw new FlowRefused('--parent-run names a build-feature run, but this ticket folder has no readable build-feature run state')
  if (state.inProgress?.runId !== runId) throw new FlowRefused('--parent-run names a run that is not the build-feature run in progress on this ticket')
  const pending = state.pending
  if (pending?.kind === 'step' && pending.nonce === nonce) return { runId, nonce }
  if (when === 'finish' && (state.steps ?? []).some((step) => step.runId === runId && step.nonce === nonce)) return { runId, nonce }
  throw new FlowRefused('--parent-run does not name the pending step of the build-feature run in progress')
}

/** The one line a run prints when its telemetry file was written but not attached to the ticket. */
export const telemetryNotice = (reason: string, path: string): string => `Telemetry not attached: ${reason}; the file is at ${path}`
