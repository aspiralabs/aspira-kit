// Where each step's result is read and whether the run goes on. The session's step report (one
// result line and the usage) is validated, but the verdict comes from the step's own export,
// validated at the boundary (PATTERN-012): every status word is read through readRunStatus (F7),
// so a pre-upgrade per-skill word (complete, clean, confirmed, ...) reads as its new five-word
// status and a word readRunStatus does not know stops the run as incomplete.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { countsFromFindings } from '@aspiralabs/ai/common/lib/findings-counts'
import { readRunStatus, type RunStatus } from '@aspiralabs/ai/common/lib/run-status'
import type { SourceKind } from '@aspiralabs/ai/common/lib/telemetry-sources'
import type { StepName } from '#build-feature/route.ts'
import { subagentUsageSchema, usageSchema, type RunState, type SubagentUsage, type Usage } from '#build-feature/run-state.ts'

/**
 * The report the session writes for a step stage. nonce, step, status and resultLine are strict;
 * usage is taken as it comes and read by readStepUsage, so a malformed usage never fails the report
 * (KIT-19 F22).
 */
export const stepReportSchema = z.object({ nonce: z.string().min(1), step: z.string().min(1), status: z.string().min(1), resultLine: z.string(), usage: z.unknown() })
export type StepReport = z.infer<typeof stepReportSchema>

/** What a session may report as usage: the stored usage without the fields only the driver fills (phases, gap). */
const reportedUsageSchema = usageSchema.unwrap().omit({ phases: true, gap: true, subagents: true })

/** Every number not measured, with the gap that says why. */
const invalidUsage = (): NonNullable<Usage> => ({ tokens: null, wallMs: null, gap: 'invalid' })

/** A reported object without its null fields: the report shape asks for null where the Agent tool reported nothing, which is the same as leaving the field out. */
const withoutNulls = (raw: unknown): unknown => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)) : raw)

/** One reported subagent entry: its numbers, or not measured with gap invalid when it fails the schema. The free-text label is dropped. */
function readSubagent(raw: unknown): SubagentUsage {
  const parsed = subagentUsageSchema.omit({ gap: true }).safeParse(withoutNulls(raw))
  return parsed.success ? parsed.data : { gap: 'invalid' }
}

/**
 * A step or fix report's usage as the run stores it: null when the session reported none; the
 * reported numbers when they validate (each subagent entry checked on its own, a null field read as
 * not reported, as the report shape asks); otherwise every
 * number not measured with gap 'invalid'. Never throws and never fails the report (KIT-19 F9, F22).
 */
export function readStepUsage(raw: unknown): Usage {
  if (raw === null || raw === undefined) return null
  const object = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!object.success) return invalidUsage()
  const { subagents, ...rest } = object.data
  if (subagents !== undefined && !Array.isArray(subagents)) return invalidUsage()
  const parsed = reportedUsageSchema.safeParse(withoutNulls(rest))
  if (!parsed.success) return invalidUsage()
  return { ...parsed.data, ...(subagents === undefined ? {} : { subagents: subagents.map(readSubagent) }) }
}

export type ResultPaths = { folder: string; repo: string; app: string }

type ResultRow = {
  /** The export file the status word is read from. */
  file: (paths: ResultPaths) => string
  /** The step agent's own usage file, read in cloud mode when the step is accepted (KIT-19), or null when it records none (implementor). */
  usage: (paths: ResultPaths) => { file: string; kind: SourceKind } | null
}

/** The `status` word of an export, the rest of the file passed through. */
const reviewStatus = z.looseObject({ status: z.string().min(1) }).transform((value) => value.status)

/** Every step continues on `ready` and stops on anything else readRunStatus knows (F7); an unknown word also stops, as "a status the run does not know". */
const CONTINUE_ON: RunStatus = 'ready'

/** Per step: where its result is read, and where its agent records its usage (KIT-19). */
export const stepResultTable: Readonly<Record<StepName, ResultRow>> = {
  groomer: { file: ({ folder }) => join(folder, 'groom/trace/groom.json'), usage: ({ folder }) => ({ file: join(folder, 'groom/trace/usage.json'), kind: 'usage.json' }) },
  'spec-writer': { file: ({ folder }) => join(folder, 'spec.reviewed/trace/review.json'), usage: ({ folder }) => ({ file: join(folder, 'spec.reviewed/trace/usage.json'), kind: 'usage.json' }) },
  planner: { file: ({ folder }) => join(folder, 'plan.review/trace/review.json'), usage: ({ folder }) => ({ file: join(folder, 'plan.review/trace/usage.json'), kind: 'usage.json' }) },
  implementor: { file: ({ folder }) => join(folder, 'plan.review/trace/implementation-local.json'), usage: () => null },
  'code-analyzer': { file: ({ repo, app }) => join(repo, app, '.static-analysis/rounds.json'), usage: ({ repo, app }) => ({ file: join(repo, app, '.static-analysis/usage.json'), kind: 'ledger' }) },
  'pr-reviewer': { file: ({ folder }) => join(folder, 'pr-review/trace/review.json'), usage: ({ folder }) => ({ file: join(folder, 'pr-review/usage.jsonl'), kind: 'usage.jsonl' }) },
}

export type Counts = { critical: number; high: number; medium: number; low: number; info: number }
export type StepResult = { verdict: 'continue' | 'stop'; status: string; file: string | null; message: string; counts?: Counts | null }

const relative = (paths: ResultPaths, file: string): string => (file.startsWith(`${paths.repo}/`) ? file.slice(paths.repo.length + 1) : file)

async function readJson(file: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
  if (raw === null) return { ok: false, reason: 'is missing' }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, reason: 'is not valid JSON' }
  }
}

/** The pr-reviewer's counts from findings.md, alongside its own verdict (every other step has none). */
async function pullReviewerCounts(paths: ResultPaths): Promise<Counts | null> {
  const findings = join(paths.folder, 'pr-review/findings.md')
  const text = await readFile(findings, 'utf8').catch(() => null)
  return text === null ? null : countsFromFindings(text)
}

/** The verdict for a step from its export (F7); the pr-reviewer also carries findings.md's counts. */
export async function readStepResult(step: StepName, report: StepReport, paths: ResultPaths): Promise<StepResult> {
  const row = stepResultTable[step]
  if (report.status === 'refused') return { verdict: 'stop', status: 'refused', file: null, message: `${step} refused: ${report.resultLine || 'the step refused at its Status gate'}` }
  const file = row.file(paths)
  const shown = relative(paths, file)
  const json = await readJson(file)
  if (!json.ok) return { verdict: 'stop', status: report.status, file, message: `${step} left no result the run can read: ${shown} ${json.reason}` }
  const parsed = reviewStatus.safeParse(json.value)
  if (!parsed.success) return { verdict: 'stop', status: report.status, file, message: `${step} left no status in ${shown}` }
  const read = readRunStatus(parsed.data)
  if (read === null) return { verdict: 'stop', status: parsed.data, file, message: `${step} ended ${parsed.data} (a status the run does not know) in ${shown}: ${report.resultLine}.` }
  const counts = step === 'pr-reviewer' ? await pullReviewerCounts(paths) : undefined
  if (read.status === CONTINUE_ON) {
    const message = step === 'pr-reviewer' && counts !== null && counts !== undefined ? `${step} ${read.status}: ${counts.critical} critical, ${counts.high} high` : `${step} ${read.status}`
    return { verdict: 'continue', status: read.status, file, message, ...(counts === undefined ? {} : { counts }) }
  }
  const before = step === 'code-analyzer' ? ' The run stops before the PR.' : ''
  return { verdict: 'stop', status: read.status, file, message: `${step} ended ${read.status} in ${shown}: ${report.resultLine}.${before}`, ...(counts === undefined ? {} : { counts }) }
}

/** The implementor's last exported status, read through readRunStatus (F7), or null when it has not exported or the word is unknown. */
export async function readImplementorStatus(folder: string): Promise<RunStatus | null> {
  const json = await readJson(join(folder, 'plan.review/trace/implementation-local.json'))
  if (!json.ok) return null
  const parsed = reviewStatus.safeParse(json.value)
  return parsed.success ? (readRunStatus(parsed.data)?.status ?? null) : null
}

const readText = (file: string) => readFile(file, 'utf8').catch(() => null)

/** In Review: Spec: whether a ready spec step export (spec.reviewed/) covers the current spec.md (A6, KIT-48). */
export async function readSpecCoverage(folder: string, _state: RunState): Promise<boolean> {
  const spec = await readText(join(folder, 'spec.md'))
  if (spec === null) return false
  const reviewed = await readText(join(folder, 'spec.reviewed/spec.reviewed.md'))
  const review = await readJson(join(folder, 'spec.reviewed/trace/review.json'))
  const ready = review.ok && reviewStatus.safeParse(review.value).data === 'ready'
  return ready && reviewed === spec
}

/** The code-analyzer finished ready (or its pre-upgrade clean) after the last build. */
export function analyzerReady(state: RunState): boolean {
  const last = state.steps.filter((step) => step.step === 'implementor' || step.step === 'code-analyzer').at(-1)
  return last?.step === 'code-analyzer' && readRunStatus(last.status)?.status === 'ready'
}

/** The app directories the implementor's record says it changed (`apps` in implementation-local.json), '.' for the root; none when the record has none (KIT-39). */
export async function readImplementorApps(folder: string): Promise<string[]> {
  const json = await readJson(join(folder, 'plan.review/trace/implementation-local.json'))
  if (!json.ok) return []
  const parsed = z.object({ apps: z.array(z.string()).optional() }).safeParse(json.value)
  if (!parsed.success) return []
  return [...new Set((parsed.data.apps ?? []).map((app) => app.trim().replace(/\/+$/, '') || '.'))]
}

/** Which of `apps` the code analyzer finished ready since the last build, by the `--app <dir>` its step command carried (KIT-39). */
export function analyzedApps(state: RunState, apps: readonly string[]): string[] {
  const steps = state.steps.filter((step) => step.step === 'implementor' || step.step === 'code-analyzer')
  const lastBuild = steps.map((step) => step.step).lastIndexOf('implementor')
  const since = steps.slice(lastBuild + 1)
  return apps.filter((app) => since.some((step) => step.step === 'code-analyzer' && readRunStatus(step.status)?.status === 'ready' && appOf(step.command) === app))
}

/** The `--app <dir>` a step command carries, or `fallback` ('.') when it carries none; a code-analyzer step's results live under that directory (KIT-40). */
export const commandApp = (command: string, fallback = '.'): string => (command.match(/--app\s+(\S+)/)?.[1] ?? fallback).replace(/\/+$/, '') || '.'
const appOf = (command: string): string => commandApp(command)

/** The app directories the code-analyzer steps since the last build ran on, in order, from their `--app`; `[fallback]` when there were none (KIT-40). */
export function analyzerStepApps(state: RunState, fallback = '.'): string[] {
  const steps = state.steps.filter((step) => step.step === 'implementor' || step.step === 'code-analyzer')
  const since = steps.slice(steps.map((step) => step.step).lastIndexOf('implementor') + 1)
  const apps = [...new Set(since.filter((step) => step.step === 'code-analyzer').map((step) => commandApp(step.command, fallback)))]
  return apps.length ? apps : [fallback]
}
