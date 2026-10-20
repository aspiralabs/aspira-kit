// Run telemetry for /aspira-build-feature (KIT-19 plan P7: T23-T31) at seam S1: the driver CLI
// `scripts/local.ts <ID>` as `build-feature.sh local` runs it, through driver.test-helper.ts
// project(), observed through the stages it prints and the files it leaves in the ticket folder:
// `telemetry/<run-id>.json` (OTLP JSON), `.local/telemetry/` (run-id markers and the attach record),
// state.json and build-summary.md. Only the boundaries are stood in for (TEST-007): a real temp git
// repository with a bare origin, a fake gh on PATH, time through BUILD_FEATURE_NOW (setNow), the
// Notion answers the session would write as stage answer files, and the step agents' usage files
// written as literal fixtures with their modification time set inside (or outside) the step.
// NOTION_TOKEN is never passed to the driver.
//
// The stage contract added here (beside the one driver.test-helper.ts describes):
//   - step: the printed `command` (and the command in the step prompt) ends with
//     `--parent-run <runId>:<nonce>`; nothing stored keeps it.
//   - telemetry: printed after the Build Summary push when the fetched board rules list the run
//     telemetry file on the BOARD-003 line; `notion: [{ op: 'write', target: 'ticket' }]`; the session
//     answers { attached: true, blockId } or { error }. The attach is recorded at
//     `.local/telemetry/attached/<runId>.json` ({ runId, blockId }).
//   - end: a telemetry file that is not attached adds `Telemetry not attached: <reason>; the file is at <path>`.
//   - a run refuses (exit 1, no stage) before its first step when a step skill's
//     `.claude/skills/aspira-<step>/.kit-version` is missing or differs from this package's version.
// Span attributes read here: aspira.status, aspira.duration_ms, aspira.orchestration.duration_ms,
// aspira.segment, aspira.not_measured, aspira.gap, aspira.partial, aspira.usage_scope,
// aspira.tokens.input, aspira.tokens.output, aspira.tokens.total, aspira.cost_usd, and a model attribute.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PACKAGE, PR_URL, SLUG, cleanup, ofKind, project, worktreeFor, writeStepExport, type Handler, type Project, type Result, type Stage, type StepReportOptions } from './driver.test-helper.ts'

afterAll(cleanup)

const SLOW = 240_000

/** This package's version, the one every step skill's .kit-version must name. */
const VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))).version
const STEP_SKILLS = ['groomer', 'spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer']
/** The .kit-version file kit init leaves in every step skill, as committed files. */
const kitVersions = (version = VERSION): Record<string, string> => Object.fromEntries(STEP_SKILLS.map((step) => [`.claude/skills/aspira-${step}/.kit-version`, `${version}\n`]))

/** The Feature Board rules page with BOARD-003 naming the run telemetry file block (the 2026-10-15 amendment). */
const RULES_WITH_TELEMETRY =
  '# Feature Board\n\n**BOARD-003 — MUST** push outputs as child pages under fixed titles: Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review, Grooming Decisions, Build Summary. Every /aspira-* run on the ticket may also append one run telemetry file block, holding its <run-id>.json, at the end of the ticket page body.\n'

const at = (time: string) => `2026-10-12T${time}.000Z`
const SOURCE = { 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "import { a } from './a.ts'\n", 'src/b.ts': 'export const b = 1\n' }
const high = (n: number) => [{ id: `H${n}`, severity: 'high' as const, title: `Review ${n} found the retry never stops`, file: 'src/a.ts' }]

// ---------------------------------------------------------------------------------------------
// The OTLP file, read through zod.
// ---------------------------------------------------------------------------------------------

const valueSchema = z.looseObject({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
  arrayValue: z.looseObject({ values: z.array(z.looseObject({ stringValue: z.string().optional() })).default([]) }).optional(),
})
const spanSchema = z.looseObject({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: z.array(z.object({ key: z.string(), value: valueSchema })).default([]),
  status: z.looseObject({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }).optional(),
})
type Span = z.infer<typeof spanSchema>
const traceSchema = z.object({ resourceSpans: z.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) })) })

type Value = string | number | boolean | string[] | undefined

function valueOf(value: z.infer<typeof valueSchema>): Value {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.boolValue !== undefined) return value.boolValue
  if (value.arrayValue !== undefined) return value.arrayValue.values.flatMap((item) => (item.stringValue === undefined ? [] : [item.stringValue]))
  return undefined
}

const attr = (span: Span | undefined, key: string): Value => {
  const found = span?.attributes.find((attribute) => attribute.key === key)
  return found === undefined ? undefined : valueOf(found.value)
}
const numberAttr = (span: Span | undefined, key: string): number | undefined => {
  const value = attr(span, key)
  return typeof value === 'number' ? value : undefined
}
const notMeasured = (span: Span | undefined): string[] => {
  const value = attr(span, 'aspira.not_measured')
  return Array.isArray(value) ? value : []
}
/** The OTLP status code by name (the JSON encoding writes the enum number, or its name). */
function statusOf(span: Span | undefined): string {
  const code = span?.status?.code
  if (code === 1 || code === 'STATUS_CODE_OK') return 'OK'
  if (code === 2 || code === 'STATUS_CODE_ERROR') return 'ERROR'
  return 'UNSET'
}
const durationOf = (span: Span | undefined): number | undefined => (span === undefined ? undefined : Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n))

/** The spans of one run's telemetry file, with the tree around them; empty when there is no file. */
function tree(spans: readonly Span[]) {
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

const telemetryDir = (folder: string) => join(folder, 'telemetry')
const telemetryFiles = async (folder: string): Promise<string[]> => (existsSync(telemetryDir(folder)) ? (await readdir(telemetryDir(folder))).sort() : [])

async function readTrace(folder: string, runId: string | undefined) {
  const raw = await readFile(join(telemetryDir(folder), `${runId}.json`), 'utf8').catch(() => null)
  if (raw === null) return tree([])
  const parsed = traceSchema.parse(JSON.parse(raw))
  return tree(parsed.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
}

/** Every value under a `command` key anywhere in a parsed JSON value. */
function commandValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => commandValues(item))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => [...(key === 'command' && typeof item === 'string' ? [item] : []), ...commandValues(item)])
}

// ---------------------------------------------------------------------------------------------
// The session's side.
// ---------------------------------------------------------------------------------------------

/** Report a step as the step would leave it, with a step report whose usage is `usage` as given (any shape). */
async function reportUsage(h: Project, stage: Stage | null | undefined, status: string, usage: unknown, options: StepReportOptions = {}) {
  await h.report(stage, status, options)
  const step = String(stage?.step)
  await h.answer(stage, { step, status, resultLine: `${step}: ${status}`, usage })
}

/** Answer the summary stages with these board rules; the push is answered at `endAt` when given. */
function summaryWith(h: Project, rules: string, endAt?: string): Handler {
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
const gatePasses = (h: Project): Handler => async (stage) => {
  await h.answer(stage, { results: ((stage.commands ?? []) as string[]).map((command) => ({ command, exitCode: 0, output: 'ok' })) })
}

/** End the run with --finish (after the pending answer was taken) and answer the summary stages. */
async function stopWith(h: Project, handlers: Partial<Record<string, Handler>> = {}): Promise<Result> {
  return h.advance(handlers, await h.finish())
}

/** Answer Step 10 when it is asked for and return the next stage (the first review). */
async function toReview(h: Project, from?: Result): Promise<Result> {
  let result = await h.advance({}, from)
  while (result.stage?.stage === 'step10') {
    await h.answer(result.stage, { docs: [], docsToPropagate: 'none' })
    result = await h.advance()
  }
  return result
}

async function put(path: string, content: string, mtime?: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
}

/** A trace/usage.json as the cloud agents write it: { scope, turns: UsageEntry[] }, with the text fields a turn carries. */
const usageJson = (turns: { phase: string; model: string; input: number; output: number; cost: number | string | null; tools: number }[]) =>
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
const usageLines = (lines: { agent: string; input: number; output: number; startedAt: string; at: string }[]) =>
  `${lines
    .map((line, index) =>
      JSON.stringify({ agent: line.agent, sessionId: `session-${index}`, turnId: `turn-${index}`, stepIndex: index, at: line.at, startedAt: line.startedAt, durationMs: 30000, inputTokens: line.input, outputTokens: line.output, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.001 }),
    )
    .join('\n')}\n`

// ---------------------------------------------------------------------------------------------
// T23: one file per build-feature run, steps + orchestration adding up, fixes under a segment.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T23 F6 F7 F8 F14: one telemetry file for a build-feature run with a review, a fix and a second review', () => {
  // 09:00 start, Step 10 answered at 09:05 (review 1 printed), review 1 reported at 09:15 (fix printed),
  // fix answered at 09:20 (review 2 printed), review 2 reported at 09:30, Build Summary push answered at 09:40.
  const seen: { runId?: string; files: string[]; trace: Awaited<ReturnType<typeof readTrace>>; telemetry?: Stage; attached: string | null } = { files: [], trace: tree([]), attached: null }

  beforeAll(async () => {
    const h = await project({ status: 'In Review: Implementation', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, ...kitVersions() } })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    h.setNow(at('09:00:00'))
    const first = await h.advance({}, await h.start())
    h.setNow(at('09:05:00'))
    const review = await toReview(h, first)
    h.setNow(at('09:15:00'))
    const subagents = [
      { label: 'Read the diff', startedAt: at('09:06:00'), endedAt: at('09:09:00'), totalTokens: 3000, toolUses: 7, wallMs: 180000 },
      { label: 'Check the tests', startedAt: at('09:09:00'), endedAt: at('09:12:00'), totalTokens: 2000, toolUses: 5, wallMs: 180000 },
    ]
    await reportUsage(h, review.stage, 'complete', { tokens: 4000, wallMs: 600000, toolUses: 3, subagents }, { findings: high(1) })
    const fixStage = await h.advance()
    h.setNow(at('09:20:00'))
    await h.write('src/a.ts', 'export const a = 2\n')
    await h.answer(fixStage.stage, { decisions: [], usage: { tokens: 400, wallMs: 300000 } })
    const second = await h.advance()
    h.setNow(at('09:30:00'))
    await reportUsage(h, second.stage, 'complete', { tokens: 3000, wallMs: 600000 }, { findings: [] })
    const telemetry = await h.advance({ summary: summaryWith(h, RULES_WITH_TELEMETRY, at('09:40:00')) })
    if (telemetry.stage?.stage === 'telemetry') {
      seen.telemetry = telemetry.stage
      await h.answer(telemetry.stage, { attached: true, blockId: 'b1' })
      await h.next()
    }
    seen.runId = h.runId
    seen.files = await telemetryFiles(h.folder)
    seen.trace = await readTrace(h.folder, h.runId)
    const record = await readFile(join(h.folder, '.local/telemetry/attached', `${h.runId}.json`), 'utf8').catch(() => null)
    const parsed = record === null ? null : z.looseObject({ blockId: z.string() }).safeParse(JSON.parse(record))
    seen.attached = parsed?.success === true ? parsed.data.blockId : null
  }, SLOW)

  it('leaves exactly one <runId>.json in telemetry/ and no file for any other run id', () => {
    expect(seen.files).toEqual([`${seen.runId}.json`])
  })

  it('makes the root duration the step spans plus the orchestration time, which is the sum of its segments', () => {
    const { root, steps, orchestration, childrenOf } = seen.trace
    const segments = childrenOf(orchestration).filter((span) => attr(span, 'aspira.segment') === true)
    expect({
      root: durationOf(root),
      steps: steps.map((span) => durationOf(span)),
      orchestration: numberAttr(orchestration, 'aspira.orchestration.duration_ms'),
      segments: segments.reduce((total, span) => total + (durationOf(span) ?? 0), 0),
    }).toEqual({ root: 2_400_000, steps: [600_000, 600_000], orchestration: 1_200_000, segments: 1_200_000 })
  })

  it('places the fix under the orchestration segment it ran in, not under the orchestration span or a step', () => {
    const { spans, parentOf, orchestration, steps } = seen.trace
    const fixes = spans.filter((span) => span.name === 'fix')
    const parent = fixes[0] === undefined ? undefined : parentOf(fixes[0])
    expect({ fixes: fixes.length, segment: attr(parent, 'aspira.segment'), orchestration: parent !== undefined && parent === orchestration, step: steps.some((span) => span === parent), parentDuration: durationOf(parent) }).toEqual({
      fixes: 1,
      segment: true,
      orchestration: false,
      step: false,
      parentDuration: 300_000,
    })
  })

  it('lists the orchestration span’s tokens as not measured and gives it a duration', () => {
    const { orchestration } = seen.trace
    expect({ tokens: notMeasured(orchestration).some((key) => key.includes('tokens')), duration: typeof numberAttr(orchestration, 'aspira.orchestration.duration_ms') }).toEqual({ tokens: true, duration: 'number' })
  })

  it('prints a telemetry stage that writes only to the ticket, and records the block the session attached', () => {
    expect({ notion: seen.telemetry?.notion, attached: seen.attached }).toEqual({ notion: [{ op: 'write', target: 'ticket' }], attached: 'b1' })
  })
})

// ---------------------------------------------------------------------------------------------
// T24: --parent-run on the printed step command only.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T24 F6: every printed step command carries --parent-run <runId>:<nonce>, and nothing stored does', () => {
  it.each(['local', 'cloud'] as const)('ends the %s step command and the command in its prompt with --parent-run', async (mode) => {
    const h = await project({ status: 'Ready: Spec', mode, files: kitVersions() })
    const step = await h.advance({}, await h.start())
    const suffix = ` --parent-run ${String(step.stage?.runId)}:${String(step.stage?.nonce)}`
    const prompt = await readFile(String(step.stage?.prompt), 'utf8').catch(() => '')
    expect({
      stage: step.stage?.stage,
      command: String(step.stage?.command).endsWith(suffix),
      // KIT-2 (F44): the prompt names the launcher form, not the slash command; the launcher line carries the suffix.
      prompt: prompt.split('\n').some((line) => line.includes('/scripts/planner.sh') && line.endsWith(suffix)),
    }).toEqual({ stage: 'step', command: true, prompt: true })
  }, SLOW)

  it.each(['local', 'cloud'] as const)('keeps --parent-run and the nonce out of every command in state.json and out of build-summary.md (%s)', async (mode) => {
    const h = await project({ status: 'Ready: Spec', mode, files: kitVersions() })
    const step = await h.advance({}, await h.start())
    const nonce = String(step.stage?.nonce)
    await h.report(step.stage, 'ready')
    await h.next()
    await stopWith(h)
    const commands = commandValues(await h.state())
    const summary = await h.summary()
    expect({
      printed: String(step.stage?.command).includes('--parent-run'),
      commands: commands.length > 0,
      stored: commands.filter((command) => command.includes('--parent-run') || command.includes(nonce)),
      summary: summary.includes('--parent-run') || summary.includes(nonce),
    }).toEqual({ printed: true, commands: true, stored: [], summary: false })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T25: the step skills must be from the driver's kit version.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T25 F6 F22: a run refuses before its first step when the step skills are from another kit version', () => {
  it('exits 1 naming both versions, with no step stage and no step record, when a step skill is from kit 0.0.1', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    await h.write('.claude/skills/aspira-planner/.kit-version', '0.0.1\n')
    const result = await h.advance({}, await h.start())
    const steps = existsSync(join(h.stateDir, 'state.json')) ? ((await h.state()).steps ?? []) : []
    expect({ code: result.code, said: result.text.includes(`step skills are from kit 0.0.1, the driver is ${VERSION}: run kit init`), stepStages: ofKind(h.stages, 'step').length, steps }).toEqual({
      code: 1,
      said: true,
      stepStages: 0,
      steps: [],
    })
  }, SLOW)

  it('exits 1 naming the missing .kit-version, with no step stage and no step record, when a step skill has none', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    await rm(join(h.repo, '.claude/skills/aspira-planner/.kit-version'), { force: true })
    const result = await h.advance({}, await h.start())
    const steps = existsSync(join(h.stateDir, 'state.json')) ? ((await h.state()).steps ?? []) : []
    expect({ code: result.code, named: result.text.includes('aspira-planner/.kit-version'), stepStages: ofKind(h.stages, 'step').length, steps }).toEqual({ code: 1, named: true, stepStages: 0, steps: [] })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T26: cloud steps read their agent's usage file when the step is accepted.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T26 F10 F11 F12: cloud step spans carry the numbers of their own usage file', () => {
  it('gives the spec-writer step span the summed tokens and gateway cost of its trace/usage.json, partial with a usage scope', async () => {
    const h = await project({ status: 'Ready: Idea', mode: 'cloud', files: kitVersions() })
    h.setNow(at('09:00:00'))
    const step = await h.advance({}, await h.start())
    h.setNow(at('09:10:00'))
    await reportUsage(h, step.stage, 'ready', null)
    await put(
      join(h.folder, 'spec.written/trace/usage.json'),
      usageJson([
        { phase: 'explore', model: 'anthropic/claude-opus-5.5', input: 1000, output: 200, cost: 0.02, tools: 2 },
        { phase: 'explore', model: 'anthropic/claude-opus-5.5', input: 500, output: 100, cost: '0.01', tools: 1 },
        { phase: 'draft', model: 'anthropic/claude-sonnet-5', input: 2000, output: 800, cost: 0.03, tools: 0 },
      ]),
      at('09:05:00'),
    )
    await h.next()
    await stopWith(h)
    const trace = await readTrace(h.folder, h.runId)
    const span = trace.step('spec-writer')
    expect({
      input: trace.sum(span, 'aspira.tokens.input'),
      output: trace.sum(span, 'aspira.tokens.output'),
      cost: trace.sum(span, 'aspira.cost_usd'),
      partial: attr(span, 'aspira.partial'),
      scoped: trace.subtree(span).some((each) => typeof attr(each, 'aspira.usage_scope') === 'string'),
    }).toEqual({ input: 3500, output: 1100, cost: 0.06, partial: true, scoped: true })
  }, SLOW)

  it('gives the code-analyzer step span the summed tokens and cost of its .static-analysis/usage.json', async () => {
    const h = await project({ status: 'In Progress: Implementation', mode: 'cloud', files: kitVersions() })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    h.setNow(at('09:00:00'))
    const step = await h.advance({ gate: gatePasses(h) }, await h.start())
    h.setNow(at('09:10:00'))
    await reportUsage(h, step.stage, 'clean', null)
    const turn = (round: number, input: number, output: number, cost: number) => ({ round, batch: 1, model: 'anthropic/claude-sonnet-5', turn: round, startedMs: round * 1000, durationMs: 900, status: 'completed', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }, providerMetadata: { gateway: { cost } }, text: 'fixed it', toolCalls: [] })
    await put(join(h.repo, '.static-analysis/usage.json'), JSON.stringify({ scope: 'fix calls', model: 'anthropic/claude-sonnet-5', turns: [turn(1, 400, 50, 0.004), turn(2, 600, 70, 0.006)] }), at('09:05:00'))
    await h.next()
    await stopWith(h)
    const trace = await readTrace(h.folder, h.runId)
    const span = trace.step('code-analyzer')
    expect({ stage: step.stage?.step, input: trace.sum(span, 'aspira.tokens.input'), output: trace.sum(span, 'aspira.tokens.output'), cost: trace.sum(span, 'aspira.cost_usd') }).toEqual({ stage: 'code-analyzer', input: 1000, output: 120, cost: 0.01 })
  }, SLOW)

  it('gives each pr-reviewer step span its own review’s usage.jsonl numbers and the model from pr-reviewer’s model map', async () => {
    const h = await project({ status: 'In Review: Implementation', mode: 'cloud', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, ...kitVersions() } })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const usage = join(h.folder, 'pr-review/usage.jsonl')
    h.setNow(at('09:00:00'))
    const first = await h.advance({}, await h.start())
    h.setNow(at('09:05:00'))
    const review = await toReview(h, first)
    h.setNow(at('09:15:00'))
    await reportUsage(h, review.stage, 'complete', null, { findings: high(1) })
    await put(
      usage,
      usageLines([
        { agent: 'ava', input: 100, output: 10, startedAt: at('09:06:00'), at: at('09:06:30') },
        { agent: 'quinn', input: 200, output: 20, startedAt: at('09:07:00'), at: at('09:07:30') },
      ]),
      at('09:14:00'),
    )
    const fixStage = await h.advance()
    h.setNow(at('09:20:00'))
    await h.write('src/a.ts', 'export const a = 2\n')
    await h.answer(fixStage.stage, { decisions: [], usage: { tokens: 400, wallMs: 300000 } })
    const second = await h.advance()
    h.setNow(at('09:30:00'))
    await reportUsage(h, second.stage, 'complete', null, { findings: [] })
    await put(
      usage,
      usageLines([
        { agent: 'ava', input: 1000, output: 100, startedAt: at('09:21:00'), at: at('09:21:30') },
        { agent: 'quinn', input: 2000, output: 200, startedAt: at('09:22:00'), at: at('09:22:30') },
      ]),
      at('09:29:00'),
    )
    await h.advance()
    const trace = await readTrace(h.folder, h.runId)
    const reviews = trace.steps.filter((span) => span.name === 'pr-reviewer')
    const models = (span: Span | undefined) => trace.subtree(span).flatMap((each) => each.attributes.filter((attribute) => attribute.key.includes('model')).map((attribute) => valueOf(attribute.value)))
    expect({
      inputs: reviews.map((span) => trace.sum(span, 'aspira.tokens.input')),
      outputs: reviews.map((span) => trace.sum(span, 'aspira.tokens.output')),
      models: reviews.map((span) => ['anthropic/claude-opus-5.5', 'openai/gpt-6-luna'].every((model) => models(span).includes(model))),
    }).toEqual({ inputs: [300, 3000], outputs: [30, 300], models: [true, true] })
  }, SLOW)

  it('gives the implementor span a duration and lists its tokens, tool calls and cost as not measured', async () => {
    const h = await project({ status: 'Ready: Plan', mode: 'cloud', files: kitVersions() })
    h.setNow(at('09:00:00'))
    const step = await h.advance({}, await h.start())
    h.setNow(at('09:10:00'))
    await reportUsage(h, step.stage, 'complete', null)
    await h.next()
    await stopWith(h)
    const trace = await readTrace(h.folder, h.runId)
    const span = trace.step('implementor')
    const missing = notMeasured(span)
    expect({ duration: durationOf(span), tokens: missing.some((key) => key.includes('tokens')), toolCalls: missing.some((key) => key.includes('tool')), cost: missing.some((key) => key.includes('cost')) }).toEqual({
      duration: 600_000,
      tokens: true,
      toolCalls: true,
      cost: true,
    })
  }, SLOW)

  it('times a planner span only, with gap stale when its usage.json was written before the step and gap missing when there is none', async () => {
    const outcomes = []
    for (const variant of ['stale', 'missing'] as const) {
      const h = await project({ status: 'Ready: Spec', mode: 'cloud', files: kitVersions() })
      h.setNow(at('09:00:00'))
      const step = await h.advance({}, await h.start())
      h.setNow(at('09:10:00'))
      await reportUsage(h, step.stage, 'ready', null)
      if (variant === 'stale') await put(join(h.folder, 'plan.review/trace/usage.json'), usageJson([{ phase: 'plan', model: 'anthropic/claude-opus-5.5', input: 900, output: 90, cost: 0.02, tools: 1 }]), at('08:00:00'))
      await h.next()
      await stopWith(h)
      const trace = await readTrace(h.folder, h.runId)
      const span = trace.step('planner')
      outcomes.push({ gap: attr(span, 'aspira.gap'), duration: durationOf(span), tokens: trace.sum(span, 'aspira.tokens.input') })
    }
    expect(outcomes).toEqual([
      { gap: 'stale', duration: 600_000, tokens: 0 },
      { gap: 'missing', duration: 600_000, tokens: 0 },
    ])
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T27: state and step reports written before this change.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T27 F9 F22: an earlier run state and step reports in three shapes', () => {
  const EARLIER = 'run-20261011T090000Z'
  const OLD_STATE = {
    runs: [{ runId: EARLIER, command: '/aspira-build-feature KIT-11 --local', startedAt: '2026-10-11T09:00:00.000Z', endedAt: '2026-10-11T10:00:00.000Z', ended: 'stopped', mode: 'local', end: { message: 'stopped by hand', stopped: true } }],
    inProgress: null,
    approvals: [{ runId: EARLIER, notionUserId: 'user-1', name: 'Ada Approver', at: '2026-10-11T09:00:00.000Z', command: '/aspira-build-feature KIT-11 --local' }],
    moves: [],
    steps: [{ step: 'groomer', runId: EARLIER, command: '/aspira-groomer KIT-11 --local --take-recommended', status: 'confirmed', startedAt: '2026-10-11T09:00:00.000Z', endedAt: '2026-10-11T09:30:00.000Z', usage: { tokens: 700, wallMs: 1800000 }, resultLine: 'groomer: confirmed', nonce: '00000000-0000-4000-8000-000000000000' }],
    takenKeys: [],
    asked: [],
    reviews: [],
    remaining: [],
    failure: null,
    step8: { pushed: false, prUrl: null, prPropertySet: false, moved: false },
    step10: { committed: false, changeset: null, docsToPropagate: null, releaseRow: null },
    pending: null,
    card: null,
    overrides: [],
    queue: [],
    afterAsks: null,
    phases: {},
  }
  const seen: { after: string[]; runId?: string; files: string[]; trace: Awaited<ReturnType<typeof readTrace>>; implementorStatus?: unknown } = { after: [], files: [], trace: tree([]) }
  const label = (result: Result) => (result.stage?.stage === 'step' ? String(result.stage.step) : String(result.stage?.stage ?? 'no stage'))

  beforeAll(async () => {
    const h = await project({ status: 'Ready: Idea', files: kitVersions() })
    await put(join(h.stateDir, 'state.json'), `${JSON.stringify(OLD_STATE, null, 2)}\n`)
    h.setNow(at('10:00:00'))
    const writer = await h.advance({}, await h.start())
    h.setNow(at('10:10:00'))
    await reportUsage(h, writer.stage, 'ready', {
      tokens: 2000,
      wallMs: 600000,
      toolUses: 12,
      model: 'anthropic/claude-opus-5.5',
      subagents: [
        { label: 'Explore the repository at /Users/x/repo', startedAt: at('10:01:00'), endedAt: at('10:04:00'), totalTokens: 3000, toolUses: 20, wallMs: 180000, model: 'anthropic/claude-sonnet-5' },
        { label: 'Draft the spec', startedAt: at('10:05:00'), endedAt: at('10:08:00'), totalTokens: 1500, toolUses: 3, wallMs: 180000 },
      ],
    })
    const planner = await h.advance()
    seen.after.push(label(planner))
    h.setNow(at('10:20:00'))
    await reportUsage(h, planner.stage, 'ready', { tokens: 1000, wallMs: 540000 })
    const implementor = await h.advance()
    seen.after.push(label(implementor))
    h.setNow(at('10:30:00'))
    await reportUsage(h, implementor.stage, 'complete', { tokens: 'lots', subagents: [{ label: 'lane A', totalTokens: 10 }, { label: 'lane B', totalTokens: 'many' }] })
    // With no gate commands in the fixture, the step after the implementor is the code-analyzer (as driver test T26 pins).
    const next = await h.advance()
    seen.after.push(label(next))
    seen.implementorStatus = ((await h.state()).steps ?? []).find((record) => record.step === 'implementor')?.status
    h.setNow(at('10:40:00'))
    await stopWith(h)
    seen.runId = h.runId
    seen.files = await telemetryFiles(h.folder)
    seen.trace = await readTrace(h.folder, h.runId)
  }, SLOW)

  it('loads the earlier state and goes on after every report', () => {
    expect(seen.after).toEqual(['planner', 'implementor', 'code-analyzer'])
  })

  it('puts each reported subagent once under its step with the start and end the session recorded', () => {
    const { step, childrenOf } = seen.trace
    expect(childrenOf(step('spec-writer')).map((span) => ({ name: span.name, start: span.startTimeUnixNano, end: span.endTimeUnixNano }))).toEqual([
      { name: 'subagent-1', start: '1791799260000000000', end: '1791799440000000000' },
      { name: 'subagent-2', start: '1791799500000000000', end: '1791799680000000000' },
    ])
  })

  it('gives the {tokens, wallMs} step span its total tokens and duration, with input, output, tool calls and cost not measured', () => {
    const span = seen.trace.step('planner')
    const missing = notMeasured(span)
    expect({ total: numberAttr(span, 'aspira.tokens.total'), duration: durationOf(span), missing: ['input', 'output', 'tool', 'cost'].map((part) => missing.some((key) => key.includes(part))) }).toEqual({
      total: 1000,
      duration: 600_000,
      missing: [true, true, true, true],
    })
  })

  it('marks the malformed usage step gap invalid and keeps its status', () => {
    expect({ gap: attr(seen.trace.step('implementor'), 'aspira.gap'), status: seen.implementorStatus }).toEqual({ gap: 'invalid', status: 'ready' })
  })

  it('writes no telemetry file for the earlier run', () => {
    expect(seen.files).toEqual([`${seen.runId}.json`])
  })
})

// ---------------------------------------------------------------------------------------------
// T28: run boundaries.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T28 F13: one file per run id, written once when that run ends', () => {
  const seen: { first?: string; second?: string; afterFirst: string[]; afterSecond: string[]; before: string; afterFinish: string; secondSteps: string[] } = { afterFirst: [], afterSecond: [], before: '', afterFinish: '', secondSteps: [] }

  beforeAll(async () => {
    const h = await project({ status: 'Ready: Idea', files: kitVersions() })
    h.setNow(at('09:00:00'))
    const writer = await h.advance({}, await h.start())
    h.setNow(at('09:10:00'))
    await h.report(writer.stage, 'ready')
    const planner = await h.advance()
    h.setNow(at('09:20:00'))
    await h.report(planner.stage, 'ready')
    await h.next()
    h.setNow(at('09:30:00'))
    await stopWith(h)
    seen.first = h.runId
    seen.afterFirst = await telemetryFiles(h.folder)
    const file = join(telemetryDir(h.folder), `${seen.first}.json`)
    seen.before = await readFile(file, 'utf8').catch(() => '')
    h.setNow(at('09:40:00'))
    await h.finish()
    seen.afterFinish = await readFile(file, 'utf8').catch(() => '')
    h.setNow(at('10:00:00'))
    const implementor = await h.advance({}, await h.start())
    h.setNow(at('10:10:00'))
    await h.report(implementor.stage, 'complete')
    await h.next()
    h.setNow(at('10:20:00'))
    await stopWith(h)
    seen.second = h.runId
    seen.afterSecond = await telemetryFiles(h.folder)
    seen.secondSteps = (await readTrace(h.folder, seen.second)).steps.map((span) => span.name)
  }, SLOW)

  it('writes one file for a run continued with --run across steps', () => {
    expect(seen.afterFirst).toEqual([`${seen.first}.json`])
  })

  it('writes a second file under a new run id holding only the resumed run’s steps', () => {
    expect({ fresh: seen.second !== seen.first, files: seen.afterSecond, steps: seen.secondSteps }).toEqual({ fresh: true, files: [`${seen.first}.json`, `${seen.second}.json`].sort(), steps: ['implementor'] })
  })

  it('leaves the file’s bytes unchanged on --finish of the ended run', () => {
    expect({ written: seen.before !== '', unchanged: seen.afterFinish === seen.before }).toEqual({ written: true, unchanged: true })
  })

  it('writes the replaced run’s file, root status replaced, when --force-run replaces a run in progress', async () => {
    const h = await project({ status: 'Ready: Plan', files: kitVersions() })
    h.setNow(at('09:00:00'))
    await h.advance({}, await h.start())
    const replaced = h.runId
    h.setNow(at('10:00:00'))
    await h.start(['--force-run'])
    const trace = await readTrace(h.folder, replaced)
    expect({ files: await telemetryFiles(h.folder), status: attr(trace.root, 'aspira.status') }).toEqual({ files: [`${replaced}.json`], status: 'replaced' })
  }, SLOW)

  it('writes a run that moved into the worktree only in the worktree’s ticket folder, leaving no file or marker in the main checkout', async () => {
    const h = await project({ status: 'Ready: Spec', layout: 'checkout', mainFiles: kitVersions() })
    const mainFolder = h.folder
    await mkdir(mainFolder, { recursive: true })
    await writeFile(join(mainFolder, 'spec.md'), '# X\n\n## Acceptance criteria\n\n- [ ] F1: it works.\n')
    h.setNow(at('09:00:00'))
    const moved = await h.advance({}, await h.start())
    h.cd(String(moved.stage?.worktree ?? worktreeFor(h.main)))
    await h.answer(moved.stage, {})
    const step = await h.advance()
    h.setNow(at('09:10:00'))
    await h.report(step.stage, 'ready')
    await h.next()
    h.setNow(at('09:20:00'))
    await stopWith(h)
    const markers = existsSync(join(mainFolder, '.local')) ? (await readdir(join(mainFolder, '.local'), { recursive: true })).filter((path) => path.endsWith('.pending')) : []
    expect({ worktree: h.folder === join(worktreeFor(h.main), '.work', SLUG), main: await telemetryFiles(mainFolder), markers, files: await telemetryFiles(h.folder) }).toEqual({
      worktree: true,
      main: [],
      markers: [],
      files: [`${h.runId}.json`],
    })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T29, T30: attach failures and the BOARD-003 gate.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T29 F16: a telemetry failure never changes how the run ends', () => {
  it('ends the run as it would have, adding the Telemetry not attached line, when the attach fails', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage, 'ready')
    await h.next()
    const telemetry = await stopWith(h, { summary: summaryWith(h, RULES_WITH_TELEMETRY) })
    if (telemetry.stage?.stage === 'telemetry') await h.answer(telemetry.stage, { error: 'upload failed' })
    const end = telemetry.stage?.stage === 'telemetry' ? await h.next() : telemetry
    const run = ((await h.state()).runs ?? []).find((record) => record.runId === h.runId)
    const message = String(end.stage?.message ?? '')
    expect({ telemetry: telemetry.stage?.stage, end: end.stage?.stage, notice: message.includes('Telemetry not attached: upload failed; the file is at'), file: message.includes(`${h.runId}.json`), ended: run?.ended, stopped: end.stage?.stopped }).toEqual({
      telemetry: 'telemetry',
      end: 'end',
      notice: true,
      file: true,
      ended: 'stopped',
      stopped: true,
    })
  }, SLOW)

  it('still writes the file of a run stopped with no aspira.json, saying it was not attached, with no telemetry stage', async () => {
    const h = await project({ status: 'Ready: Spec', aspira: null, files: kitVersions() })
    const end = await h.advance({}, await h.start())
    expect({ end: end.stage?.stage, files: await telemetryFiles(h.folder), telemetry: ofKind(h.stages, 'telemetry').length, notice: String(end.stage?.message ?? '').includes('Telemetry not attached') }).toEqual({
      end: 'end',
      files: [`${h.runId}.json`],
      telemetry: 0,
      notice: true,
    })
  }, SLOW)
})

describe('KIT-19 T30 F14: the attach follows BOARD-003 and happens once per run', () => {
  it('prints no telemetry stage and says the file was not attached when BOARD-003 does not list the run telemetry file', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage, 'ready')
    await h.next()
    const end = await stopWith(h)
    expect({ end: end.stage?.stage, telemetry: ofKind(h.stages, 'telemetry').length, notice: String(end.stage?.message ?? '').includes('Telemetry not attached'), files: await telemetryFiles(h.folder) }).toEqual({
      end: 'end',
      telemetry: 0,
      notice: true,
      files: [`${h.runId}.json`],
    })
  }, SLOW)

  it('writes the file but prints no telemetry stage for a run whose attach is already recorded', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    const step = await h.advance({}, await h.start())
    await put(join(h.folder, '.local/telemetry/attached', `${h.runId}.json`), JSON.stringify({ runId: h.runId, blockId: 'b0' }))
    await h.report(step.stage, 'ready')
    await h.next()
    const end = await stopWith(h, { summary: summaryWith(h, RULES_WITH_TELEMETRY) })
    expect({ end: end.stage?.stage, telemetry: ofKind(h.stages, 'telemetry').length, files: await telemetryFiles(h.folder) }).toEqual({ end: 'end', telemetry: 0, files: [`${h.runId}.json`] })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T31: a partial code-analyzer step.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T31 F20: status words map to the OTLP status code', () => {
  const seen: { trace: Awaited<ReturnType<typeof readTrace>>; end?: string } = { trace: tree([]) }

  beforeAll(async () => {
    const h = await project({ status: 'In Progress: Implementation', files: kitVersions() })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const step = await h.advance({ gate: gatePasses(h) }, await h.start())
    await h.report(step.stage, 'partial')
    const end = await h.advance()
    seen.end = end.stage?.stage
    seen.trace = await readTrace(h.folder, h.runId)
  }, SLOW)

  it('records the code-analyzer step that ended partial (now incomplete, KIT-2) as aspira.status incomplete with code ERROR', () => {
    const span = seen.trace.step('code-analyzer')
    expect({ status: attr(span, 'aspira.status'), code: statusOf(span) }).toEqual({ status: 'incomplete', code: 'ERROR' })
  })

  it('gives the root span of a run that ended stopped the code ERROR', () => {
    expect({ end: seen.end, status: attr(seen.trace.root, 'aspira.status'), code: statusOf(seen.trace.root) }).toEqual({ end: 'end', status: 'stopped', code: 'ERROR' })
  })
})
