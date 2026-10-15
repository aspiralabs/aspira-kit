// Where each step's result is read and whether the run goes on. The session's step report (one
// result line and the usage) is validated, but the verdict comes from the step's own export,
// validated at the boundary (PATTERN-012): every status word is read through readRunStatus (F7),
// so a pre-upgrade per-skill word (complete, clean, confirmed, ...) reads as its new five-word
// status and a word readRunStatus does not know stops the run as incomplete.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { countsFromFindings } from '@aspiralabs/agent-common/lib/findings-counts'
import { readRunStatus, type RunStatus } from '@aspiralabs/agent-common/lib/run-status'
import type { StepName } from '#src/route.ts'
import { usageSchema, type RunState } from '#src/run-state.ts'

/** The report the session writes for a step stage. */
export const stepReportSchema = z.object({ nonce: z.string().min(1), step: z.string().min(1), status: z.string().min(1), resultLine: z.string(), usage: usageSchema })
export type StepReport = z.infer<typeof stepReportSchema>

export type ResultPaths = { folder: string; repo: string; app: string }

type ResultRow = {
  /** The export file the status word is read from. */
  file: (paths: ResultPaths) => string
}

/** The `status` word of an export, the rest of the file passed through. */
const reviewStatus = z.looseObject({ status: z.string().min(1) }).transform((value) => value.status)

/** Every step continues on `ready` and stops on anything else readRunStatus knows (F7); an unknown word also stops, as "a status the run does not know". */
const CONTINUE_ON: RunStatus = 'ready'

/** Per step: where its result is read. */
export const stepResultTable: Readonly<Record<StepName, ResultRow>> = {
  groomer: { file: ({ folder }) => join(folder, 'groom/trace/groom.json') },
  'spec-writer': { file: ({ folder }) => join(folder, 'spec.written/trace/review.json') },
  'spec-reviewer': { file: ({ folder }) => join(folder, 'spec.reviewed/trace/review.json') },
  planner: { file: ({ folder }) => join(folder, 'plan.review/trace/review.json') },
  implementor: { file: ({ folder }) => join(folder, 'plan.review/trace/implementation-local.json') },
  'code-analyzer': { file: ({ repo, app }) => join(repo, app, '.static-analysis/rounds.json') },
  'pr-reviewer': { file: ({ folder }) => join(folder, 'pr-review/trace/review.json') },
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

/** In Review: Spec: whether a review covers the current spec.md (A6). */
export async function readSpecCoverage(folder: string, state: RunState): Promise<boolean> {
  const spec = await readText(join(folder, 'spec.md'))
  if (spec === null) return false
  const written = await readText(join(folder, 'spec.written/spec.md'))
  const writerReview = await readJson(join(folder, 'spec.written/trace/review.json'))
  const writerReady = writerReview.ok && reviewStatus.safeParse(writerReview.value).data === 'ready'
  if (written === spec && writerReady) return true
  const reviewer = await readJson(join(folder, 'spec.reviewed/trace/review.json'))
  const reviewerReady = reviewer.ok && reviewStatus.safeParse(reviewer.value).data === 'ready'
  return reviewerReady && state.steps.some((step) => step.step === 'spec-reviewer' && step.status === 'ready')
}

/** The code-analyzer finished ready (or its pre-upgrade clean) after the last build. */
export function analyzerReady(state: RunState): boolean {
  const last = state.steps.filter((step) => step.step === 'implementor' || step.step === 'code-analyzer').at(-1)
  return last?.step === 'code-analyzer' && readRunStatus(last.status)?.status === 'ready'
}
