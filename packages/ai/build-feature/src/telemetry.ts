// KIT-19 run telemetry for a build-feature run: the span tree built from the run state only (never
// by re-reading a usage file), shared by the telemetry file the driver writes at the run's end and
// the Run telemetry table of the Build Summary. A run's root span runs from its start to `end`; one
// child span per step record of the run whose step is one of the seven skills, with that step's
// cloud usage groups (`phases`) or its reported subagents beneath it, never both; and one
// orchestration span over the whole run whose orchestration time is the run minus its steps, with
// one segment span per interval outside steps and each review-loop fix under the segment it ran in,
// so root = steps + orchestration and nothing is counted twice (F6-F8). Every value here is a
// number, a time or a closed-set word; the free-text fields of a record (command, resultLine,
// labels, nonce) are never read.

import { spanName, type SpanAttributes, type SpanInput, type SpanUsage } from '@aspiralabs/ai/common/lib/telemetry'
import { subagentSpans, USAGE_SCOPES, type SessionUsage } from '@aspiralabs/ai/common/lib/telemetry-sources'
import { isStep, STEPS } from '#build-feature/route.ts'
import type { PhaseRecord, RunState, StepRecord, Usage } from '#build-feature/run-state.ts'

/** The parts of a run state the tree is built from (the Build Summary's state carries at least these). */
export type TelemetryState = Pick<RunState, 'runs' | 'steps'>

/** An interval in epoch milliseconds. */
export type Interval = { start: number; end: number }

/** The tree of one run, with the pieces the summary table reads. */
export type RunTree = {
  root: SpanInput
  /** The step spans, in step order. */
  steps: SpanInput[]
  orchestration: SpanInput
  /** The run's time outside steps, in milliseconds. */
  orchestrationMs: number
}

const toMs = (iso: string): number => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

const clamp = (value: number, interval: Interval): number => Math.min(Math.max(value, interval.start), interval.end)

const stepRank = (step: string): number => {
  const index = (STEPS as readonly string[]).indexOf(step)
  return index === -1 ? STEPS.length : index
}

/** Step records in the order the Build Summary lists them: start time, then Playbook order. */
export const byStart = (a: StepRecord, b: StepRecord): number => a.startedAt.localeCompare(b.startedAt) || stepRank(a.step) - stepRank(b.step)

/** A record's own usage as span usage: the Agent tool's figure is total tokens only (A4); cost is never reported for it. */
function selfUsage(usage: Usage): SpanUsage {
  return {
    model: usage?.model ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.tokens ?? null,
    cacheRead: null,
    cacheWrite: null,
    toolCalls: usage?.toolUses ?? null,
    costUsd: null,
  }
}

/** The attributes a record's own usage adds to its span: the gap, the reported wall time and the tool-count basis. */
function usageAttributes(usage: Usage): SpanAttributes {
  return {
    ...(usage?.gap === undefined ? {} : { 'aspira.gap': usage.gap }),
    ...(usage?.wallMs === null || usage?.wallMs === undefined ? {} : { 'aspira.reported_wall_ms': usage.wallMs }),
    ...(usage?.toolUses === null || usage?.toolUses === undefined ? {} : { 'aspira.tool_count_basis': 'agent tool uses' as const }),
  }
}

/** One stored cloud usage group as a span. */
function phaseSpan(phase: PhaseRecord): SpanInput {
  return {
    name: spanName(phase.phase),
    kind: 'phase',
    start: phase.startedAt,
    end: phase.endedAt,
    ...(phase.status === undefined ? {} : { status: phase.status }),
    usage: {
      model: phase.model ?? null,
      inputTokens: phase.inputTokens ?? null,
      outputTokens: phase.outputTokens ?? null,
      totalTokens: phase.totalTokens ?? null,
      cacheRead: phase.cacheRead ?? null,
      cacheWrite: phase.cacheWrite ?? null,
      toolCalls: phase.toolCalls ?? null,
      costUsd: phase.costUsd ?? null,
    },
    attributes: {
      ...(phase.anchored === undefined ? {} : { 'aspira.time.anchored': phase.anchored }),
      ...(phase.timeBasis === undefined ? {} : { 'aspira.time_basis': phase.timeBasis }),
      ...(phase.toolCountBasis === undefined ? {} : { 'aspira.tool_count_basis': phase.toolCountBasis }),
      ...(phase.usageScope === undefined ? {} : { 'aspira.usage_scope': phase.usageScope }),
      ...(phase.partial === true ? { 'aspira.partial': true } : {}),
    },
  }
}

/** The reported subagents of a step or fix as spans named subagent-1..n inside the record's interval. */
function subagentChildren(usage: Usage, interval: Interval): SpanInput[] {
  const subagents = usage?.subagents ?? []
  if (subagents.length === 0) return []
  const report: SessionUsage = {
    runId: '',
    subagents: subagents.map(({ gap, ...entry }) => (gap === 'invalid' ? { valid: false as const } : { valid: true as const, entry })),
  }
  return subagentSpans(report, interval)
}

const startOf = (span: SpanInput): number => (typeof span.start === 'number' ? span.start : toMs(span.start))
const endOf = (span: SpanInput): number => (typeof span.end === 'number' ? span.end : toMs(span.end))

/** Children ordered by start, then name, then model, then the order they were reported in. */
function ordered(children: readonly SpanInput[]): SpanInput[] {
  return children
    .map((child, index) => ({ child, index }))
    .sort((a, b) => startOf(a.child) - startOf(b.child) || a.child.name.localeCompare(b.child.name) || String(a.child.usage?.model ?? '').localeCompare(String(b.child.usage?.model ?? '')) || a.index - b.index)
    .map(({ child }) => child)
}

/** A step's children from one source only: its cloud usage groups when it has them, else the subagents the session reported. */
function stepChildren(record: StepRecord, interval: Interval): SpanInput[] {
  const phases = record.usage?.phases ?? []
  if (phases.length > 0) return ordered(phases.map(phaseSpan))
  return ordered(subagentChildren(record.usage, interval))
}

function stepSpan(record: StepRecord, run: Interval): SpanInput {
  const interval = { start: clamp(toMs(record.startedAt), run), end: clamp(toMs(record.endedAt), run) }
  const phases = record.usage?.phases ?? []
  const scope = isStep(record.step) && phases.length > 0 ? USAGE_SCOPES[record.step] : undefined
  return {
    name: record.step,
    kind: 'step',
    start: interval.start,
    end: Math.max(interval.start, interval.end),
    status: record.status,
    ...(record.verdict === undefined ? {} : { verdict: record.verdict }),
    usage: selfUsage(record.usage),
    attributes: { ...usageAttributes(record.usage), ...(scope === undefined ? {} : { 'aspira.usage_scope': scope, 'aspira.partial': true }) },
    children: stepChildren(record, interval),
  }
}

function fixSpan(record: StepRecord, segment: Interval): SpanInput {
  const interval = { start: clamp(toMs(record.startedAt), segment), end: clamp(toMs(record.endedAt), segment) }
  return {
    name: 'fix',
    kind: 'fix',
    start: interval.start,
    end: Math.max(interval.start, interval.end),
    status: record.status,
    usage: selfUsage(record.usage),
    attributes: usageAttributes(record.usage),
    children: ordered(subagentChildren(record.usage, interval)),
  }
}

/** The contiguous intervals of `run` outside every step interval: before the first step, between steps, after the last. */
export function segmentsOf(run: Interval, steps: readonly Interval[]): Interval[] {
  const sorted = [...steps].sort((a, b) => a.start - b.start)
  const segments: Interval[] = []
  let cursor = run.start
  for (const step of sorted) {
    if (step.start > cursor) segments.push({ start: cursor, end: step.start })
    cursor = Math.max(cursor, step.end)
  }
  if (run.end > cursor) segments.push({ start: cursor, end: run.end })
  return segments
}

/** The segment a fix ran in: the one containing its start, else the last one starting before it, else the first. */
function segmentFor(segments: readonly Interval[], start: number): number {
  const containing = segments.findIndex((segment) => start >= segment.start && start <= segment.end)
  if (containing >= 0) return containing
  const before = segments.map((segment, index) => ({ segment, index })).filter(({ segment }) => segment.start <= start)
  return before.at(-1)?.index ?? 0
}

/**
 * The span tree of one run from the run state: `end` is when the root ends (the write time, or the
 * summary time for the table) and `status` the root's word (the run's ended word). Throws when the
 * run is not in the state.
 */
export function runSpans(state: TelemetryState, runId: string, end: string, status?: string): RunTree {
  const run = state.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) throw new Error(`run ${runId} is not in the run state`)
  const start = toMs(run.startedAt)
  const interval: Interval = { start, end: Math.max(start, toMs(end)) }
  const records = state.steps.filter((record) => record.runId === runId)
  const steps = records
    .filter((record) => isStep(record.step))
    .sort(byStart)
    .map((record) => stepSpan(record, interval))
  const stepIntervals = steps.map((span) => ({ start: startOf(span), end: endOf(span) }))
  const stepMs = stepIntervals.reduce((total, step) => total + (step.end - step.start), 0)
  const orchestrationMs = Math.max(0, interval.end - interval.start - stepMs)
  const segments = segmentsOf(interval, stepIntervals)
  const fixes = records.filter((record) => record.step === 'fix').sort(byStart)
  const segmentFixes = segments.map((): StepRecord[] => [])
  if (segments.length > 0) for (const fix of fixes) segmentFixes[segmentFor(segments, toMs(fix.startedAt))]?.push(fix)
  const orchestration: SpanInput = {
    name: 'orchestration',
    kind: 'orchestration',
    start: interval.start,
    end: interval.end,
    // The orchestrating session's own tokens: no source reports them, so every number is listed as not measured (F8).
    usage: selfUsage(null),
    attributes: { 'aspira.orchestration.duration_ms': orchestrationMs },
    children: segments.map((segment, index) => ({
      name: `segment-${index + 1}`,
      kind: 'segment',
      start: segment.start,
      end: segment.end,
      attributes: { 'aspira.segment': true },
      children: (segmentFixes[index] ?? []).map((fix) => fixSpan(fix, segment)),
    })),
  }
  const root: SpanInput = { name: 'build-feature', kind: 'build-feature', start: interval.start, end: interval.end, ...(status === undefined ? {} : { status }), children: [...steps, orchestration] }
  return { root, steps, orchestration, orchestrationMs }
}

// ---------------------------------------------------------------------------------------------
// The Build Summary's Run telemetry table, from the same tree.
// ---------------------------------------------------------------------------------------------

/** A summed column: the value, or null when nothing was measured; partial when some summed span lacks the number. */
export type Cell = { value: number | null; partial: boolean }
export type TableRow = {
  /** A closed-set label: a step, phase or agent name, subagent-<n>, fix, Orchestration or Total. */
  label: string
  /** 0 for a step, Orchestration and Total; 1 for the rows indented beneath them. */
  depth: 0 | 1
  durationMs: number
  input: Cell
  output: Cell
  total: Cell
  toolCalls: Cell
  cost: Cell
}

/** The summed columns of the table, as span usage fields. */
type Column = 'inputTokens' | 'outputTokens' | 'totalTokens' | 'toolCalls' | 'costUsd'

const subtree = (span: SpanInput): SpanInput[] => [span, ...(span.children ?? []).flatMap(subtree)]

/** One column summed over the self values of the given spans (spans without usage are containers and are skipped). */
function sumCell(spans: readonly SpanInput[], column: Column): Cell {
  const values = spans.flatMap((span) => (span.usage === undefined ? [] : [span.usage[column]]))
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return { value: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0), partial: known.length > 0 && known.length < values.length }
}

function row(label: string, depth: 0 | 1, durationMs: number, spans: readonly SpanInput[]): TableRow {
  return { label, depth, durationMs, input: sumCell(spans, 'inputTokens'), output: sumCell(spans, 'outputTokens'), total: sumCell(spans, 'totalTokens'), toolCalls: sumCell(spans, 'toolCalls'), cost: sumCell(spans, 'costUsd') }
}

const durationOf = (span: SpanInput): number => Math.max(0, endOf(span) - startOf(span))

/**
 * The Run telemetry table of one run at `now`: each step with its inclusive values and its children
 * beneath it, then Orchestration (elapsed time to `now` minus the steps) with the run's fixes
 * beneath it, then the Total, whose duration is the step rows plus Orchestration and whose numbers
 * are the self values of every span, each counted once (F15, F21).
 */
export function tableRows(state: TelemetryState, runId: string, now: string): TableRow[] {
  const tree = runSpans(state, runId, now)
  const rows: TableRow[] = []
  for (const step of tree.steps) {
    rows.push(row(spanName(step.name), 0, durationOf(step), subtree(step)))
    for (const child of step.children ?? []) rows.push(row(spanName(child.name), 1, durationOf(child), subtree(child)))
  }
  rows.push(row('Orchestration', 0, tree.orchestrationMs, subtree(tree.orchestration)))
  for (const fix of (tree.orchestration.children ?? []).flatMap((segment) => segment.children ?? [])) rows.push(row('fix', 1, durationOf(fix), subtree(fix)))
  const stepMs = tree.steps.reduce((total, step) => total + durationOf(step), 0)
  rows.push(row('Total (to summary)', 0, stepMs + tree.orchestrationMs, subtree(tree.root)))
  return rows
}
