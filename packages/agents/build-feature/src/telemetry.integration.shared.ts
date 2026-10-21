// The fixtures the telemetry*.integration.test.ts files share (split from one file so the shards balance).

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PACKAGE, type Handler, type Project, type Result, type Stage, type StepReportOptions } from './driver.test-helper.ts'

export const SLOW = 240_000

/** This package's version, the one every step skill's .kit-version must name. */
export const VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))).version
export const STEP_SKILLS = ['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer']
/** The .kit-version file kit init leaves in every step skill, as committed files. */
export const kitVersions = (version = VERSION): Record<string, string> => Object.fromEntries(STEP_SKILLS.map((step) => [`.claude/skills/aspira-${step}/.kit-version`, `${version}\n`]))

/** The Feature Board rules page with BOARD-003 naming the run telemetry file block (the 2026-10-15 amendment). */
export const RULES_WITH_TELEMETRY =
  '# Feature Board\n\n**BOARD-003 — MUST** push outputs as child pages under fixed titles: Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review, Grooming Decisions, Build Summary. Every /aspira-* run on the ticket may also append one run telemetry file block, holding its <run-id>.json, at the end of the ticket page body.\n'

export const at = (time: string) => `2026-10-12T${time}.000Z`
export const SOURCE = { 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "import { a } from './a.ts'\n", 'src/b.ts': 'export const b = 1\n' }
export const high = (n: number) => [{ id: `H${n}`, severity: 'high' as const, title: `Review ${n} found the retry never stops`, file: 'src/a.ts' }]

// ---------------------------------------------------------------------------------------------
// The OTLP file, read through zod.
// ---------------------------------------------------------------------------------------------

export const valueSchema = z.looseObject({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
  arrayValue: z.looseObject({ values: z.array(z.looseObject({ stringValue: z.string().optional() })).default([]) }).optional(),
})
export const spanSchema = z.looseObject({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: z.array(z.object({ key: z.string(), value: valueSchema })).default([]),
  status: z.looseObject({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).optional(),
})
export type Span = z.infer<typeof spanSchema>
export const traceSchema = z.object({ resourceSpans: z.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) })) })

export type Value = string | number | boolean | string[] | undefined

export function valueOf(value: z.infer<typeof valueSchema>): Value {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.boolValue !== undefined) return value.boolValue
  if (value.arrayValue !== undefined) return value.arrayValue.values.flatMap((item) => (item.stringValue === undefined ? [] : [item.stringValue]))
  return undefined
}

export const attr = (span: Span | undefined, key: string): Value => {
  const found = span?.attributes.find((attribute) => attribute.key === key)
  return found === undefined ? undefined : valueOf(found.value)
}
export const numberAttr = (span: Span | undefined, key: string): number | undefined => {
  const value = attr(span, key)
  return typeof value === 'number' ? value : undefined
}
export const notMeasured = (span: Span | undefined): string[] => {
  const value = attr(span, 'aspira.not_measured')
  return Array.isArray(value) ? value : []
}
/** The OTLP status code by name (the JSON encoding writes the enum number, or its name). */
export function statusOf(span: Span | undefined): string {
  const code = span?.status?.code
  if (code === 1 || code === 'STATUS_CODE_OK') return 'OK'
  if (code === 2 || code === 'STATUS_CODE_ERROR') return 'ERROR'
  return 'UNSET'
}
export const durationOf = (span: Span | undefined): number | undefined => (span === undefined ? undefined : Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n))

/** The spans of one run's telemetry file, with the tree around them; empty when there is no file. */
export function tree(spans: readonly Span[]) {
  const parentOf = (span: Span) => (span.parentSpanId === undefined || span.parentSpanId === '' ? undefined : spans.find((candidate) => candidate.spanId === span.parentSpanId))
  const childrenOf = (span: Span | undefined) => (span === undefined ? [] : spans.filter((candidate) => candidate.parentSpanId === span.spanId))
  const subtree = (span: Span | undefined): Span[] => (span === undefined ? [] : [span, ...childrenOf(span).flatMap((child) => subtree(child))])
  const root = spans.find((span) => parentOf(span) === undefined)
  const steps = childrenOf(root)
    .filter((span) => STEP_SKILLS.includes(span.name))
    .sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))
  const orchestration = childrenOf(root).find((span) => attr(span, 'aspira.orchestration.duration_ms') !== undefined)
  /** The sum of one self attribute over a span and all its descendants. */
  const sum = (span: Span | undefined, key: string) => Math.round(subtree(span).reduce((total, each) => total + (numberAttr(each, key) ?? 0), 0) * 1e6) / 1e6
  return { spans, root, steps, orchestration, parentOf, childrenOf, subtree, sum, step: (name: string) => steps.find((span) => span.name === name) }
}

export const telemetryDir = (folder: string) => join(folder, 'telemetry')
export const telemetryFiles = async (folder: string): Promise<string[]> => (existsSync(telemetryDir(folder)) ? (await readdir(telemetryDir(folder))).sort() : [])

export async function readTrace(folder: string, runId: string | undefined) {
  const raw = await readFile(join(telemetryDir(folder), `${runId}.json`), 'utf8').catch(() => null)
  if (raw === null) return tree([])
  const parsed = traceSchema.parse(JSON.parse(raw))
  return tree(parsed.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
}

/** Every value under a `command` key anywhere in a parsed JSON value. */
export function commandValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => commandValues(item))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => [...(key === 'command' && typeof item === 'string' ? [item] : []), ...commandValues(item)])
}

// ---------------------------------------------------------------------------------------------
// The session's side.
// ---------------------------------------------------------------------------------------------

/** Report a step as the step would leave it, with a step report whose usage is `usage` as given (any shape). */
export async function reportUsage(h: Project, stage: Stage | null | undefined, status: string, usage: unknown, options: StepReportOptions = {}) {
  await h.report(stage, status, options)
  const step = String(stage?.step)
  await h.answer(stage, { step, status, resultLine: `${step}: ${status}`, usage })
}

/** Answer the summary stages with these board rules; the push is answered at `endAt` when given. */
export function summaryWith(h: Project, rules: string, endAt?: string): Handler {
  return async (stage) => {
    if (typeof stage.rules === 'string') {
      await mkdir(dirname(stage.rules), { recursive: true })
      await writeFile(stage.rules, rules)
      await h.answer(stage, {})
      return
    }
    if (endAt !== undefined) h.setNow(endAt)
    await h.answer(stage, { pushed: stage.push !== null && stage.push !== undefined })
  }
}

/** Answer every gate command as passing. */
export const gatePasses = (h: Project): Handler => async (stage) => {
  await h.answer(stage, { results: ((stage.commands ?? []) as string[]).map((command) => ({ command, exitCode: 0, output: 'ok' })) })
}

/** End the run with --finish (after the pending answer was taken) and answer the summary stages. */
export async function stopWith(h: Project, handlers: Partial<Record<string, Handler>> = {}): Promise<Result> {
  return h.advance(handlers, await h.finish())
}

/** Answer Step 10 when it is asked for and return the next stage (the first review). */
export async function toReview(h: Project, from?: Result): Promise<Result> {
  let result = await h.advance({}, from)
  while (result.stage?.stage === 'step10') {
    await h.answer(result.stage, { docs: [], docsToPropagate: 'none' })
    result = await h.advance()
  }
  return result
}

export async function put(path: string, content: string, mtime?: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
}

/** A trace/usage.json as the cloud agents write it: { scope, turns: UsageEntry[] }, with the text fields a turn carries. */
export const usageJson = (turns: { phase: string; model: string; input: number; output: number; cost: number | string | null; tools: number }[]) =>
  JSON.stringify({
    scope: 'Direct writer and review calls only; excludes eve router.',
    turns: turns.map((turn, index) => ({
      phase: turn.phase,
      model: turn.model,
      turn: index + 1,
      startedMs: index * 1000,
      durationMs: 900,
      status: 'completed',
      usage: { inputTokens: turn.input, outputTokens: turn.output, totalTokens: turn.input + turn.output },
      ...(turn.cost === null ? {} : { providerMetadata: { gateway: { cost: turn.cost } } }),
      messages: [{ role: 'user', content: 'Explore the repository for the idea' }],
      text: 'the model said this',
      toolCalls: Array.from({ length: turn.tools }, (_, call) => ({ toolName: 'read', input: { path: `/Users/x/src/${call}.ts` } })),
      toolResults: [],
    })),
  })

/** pr-reviewer's usage.jsonl lines (UsageLine). */
export const usageLines = (lines: { agent: string; input: number; output: number; startedAt: string; at: string }[]) =>
  `${lines
    .map((line, index) =>
      JSON.stringify({ agent: line.agent, sessionId: `session-${index}`, turnId: `turn-${index}`, stepIndex: index, at: line.at, startedAt: line.startedAt, durationMs: 30000, inputTokens: line.input, outputTokens: line.output, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.001 }),
    )
    .join('\n')}\n`

// ---------------------------------------------------------------------------------------------
// T23: one file per build-feature run, steps + orchestration adding up, fixes under a segment.
// ---------------------------------------------------------------------------------------------
