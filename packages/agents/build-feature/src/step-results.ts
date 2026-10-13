// Where each step's result is read and whether the run goes on. The session's step report (one
// result line and the usage) is validated, but the verdict comes from the step's own export,
// validated at the boundary (PATTERN-012): a status word the table does not know stops the run.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { countsFromFindings } from '@aspiralabs/agent-common/lib/findings-counts'
import type { StepName } from '#src/route.ts'
import { usageSchema, type RunState } from '#src/run-state.ts'

/** The report the session writes for a step stage. */
export const stepReportSchema = z.object({ nonce: z.string().min(1), step: z.string().min(1), status: z.string().min(1), resultLine: z.string(), usage: usageSchema })
export type StepReport = z.infer<typeof stepReportSchema>

export type ResultPaths = { folder: string; repo: string; app: string }

type ResultRow = {
  /** The export file the verdict is read from, or null when the report carries the status (pr-reviewer). */
  file: (paths: ResultPaths) => string | null
  /** The status word in that file. */
  status: z.ZodType<string>
  continueOn: readonly string[]
  stopOn: readonly string[]
}

/** The `status` word of an export, the rest of the file passed through. */
const reviewStatus = z.looseObject({ status: z.string().min(1) }).transform((value) => value.status)

/** Per step: where its result is read and the continue/stop rule. */
export const stepResultTable: Readonly<Record<StepName, ResultRow>> = {
  groomer: { file: ({ folder }) => join(folder, 'groom/trace/groom.json'), status: reviewStatus, continueOn: ['confirmed'], stopOn: ['needs-author', 'stopped', 'incomplete'] },
  'spec-writer': { file: ({ folder }) => join(folder, 'spec.written/trace/review.json'), status: reviewStatus, continueOn: ['ready'], stopOn: ['needs-author', 'incomplete'] },
  'spec-reviewer': { file: ({ folder }) => join(folder, 'spec.reviewed/trace/review.json'), status: reviewStatus, continueOn: ['ready'], stopOn: ['needs-author', 'incomplete'] },
  planner: { file: ({ folder }) => join(folder, 'plan.review/trace/review.json'), status: reviewStatus, continueOn: ['ready'], stopOn: ['needs-author', 'incomplete'] },
  implementor: { file: ({ folder }) => join(folder, 'plan.review/trace/implementation-local.json'), status: reviewStatus, continueOn: ['complete'], stopOn: ['incomplete', 'refused', 'blocked'] },
  'code-analyzer': { file: ({ repo, app }) => join(repo, app, '.static-analysis/rounds.json'), status: reviewStatus, continueOn: ['clean'], stopOn: [] },
  'pr-reviewer': { file: () => null, status: z.string(), continueOn: ['complete'], stopOn: ['incomplete'] },
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

/** The verdict for a step from its export (and, for the pr-reviewer, its report and findings.md). */
export async function readStepResult(step: StepName, report: StepReport, paths: ResultPaths): Promise<StepResult> {
  const row = stepResultTable[step]
  if (report.status === 'refused') return { verdict: 'stop', status: 'refused', file: null, message: `${step} refused: ${report.resultLine || 'the step refused at its Status gate'}` }
  const file = row.file(paths)
  if (file === null) {
    // pr-reviewer: the report's word, then the counts from findings.md.
    if (!row.continueOn.includes(report.status)) return { verdict: 'stop', status: report.status, file: null, message: `${step} ended ${report.status}: ${report.resultLine}` }
    const findings = join(paths.folder, 'pr-review/findings.md')
    const text = await readFile(findings, 'utf8').catch(() => null)
    const counts = text === null ? null : countsFromFindings(text)
    if (counts === null) return { verdict: 'stop', status: report.status, file: findings, message: `${step} left no findings the run can count: ${relative(paths, findings)} is missing or not a findings file`, counts: null }
    return { verdict: 'continue', status: report.status, file: findings, message: `${step} complete: ${counts.critical} critical, ${counts.high} high`, counts }
  }
  const shown = relative(paths, file)
  const json = await readJson(file)
  if (!json.ok) return { verdict: 'stop', status: report.status, file, message: `${step} left no result the run can read: ${shown} ${json.reason}` }
  const parsed = row.status.safeParse(json.value)
  if (!parsed.success) return { verdict: 'stop', status: report.status, file, message: `${step} left no status in ${shown}` }
  const status = parsed.data
  if (row.continueOn.includes(status)) return { verdict: 'continue', status, file, message: `${step} ${status}` }
  const known = row.stopOn.includes(status)
  const before = step === 'code-analyzer' ? ' The run stops before the PR.' : ''
  return { verdict: 'stop', status, file, message: `${step} ended ${status}${known ? '' : ' (a status the run does not know)'} in ${shown}: ${report.resultLine}.${before}` }
}

/** The implementor's last exported status, or null when it has not exported. */
export async function readImplementorStatus(folder: string): Promise<string | null> {
  const json = await readJson(join(folder, 'plan.review/trace/implementation-local.json'))
  if (!json.ok) return null
  const parsed = reviewStatus.safeParse(json.value)
  return parsed.success ? parsed.data : null
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

/** The code-analyzer finished clean after the last build. */
export function analyzerClean(state: RunState): boolean {
  const last = state.steps.filter((step) => step.step === 'implementor' || step.step === 'code-analyzer').at(-1)
  return last?.step === 'code-analyzer' && last.status === 'clean'
}
