import type { ReasonCode } from '@aspiralabs/ai/common/lib/run-status'
import type { Analyzer } from './analyzers.ts'
import { batch, errors, sameSet, type Batch, type Diagnostic } from './diagnostics.ts'
import type { Executor } from './executor.ts'
import type { Rejection } from './guards.ts'
import { filesFor, partition, type Scope } from './scope.ts'

export type AnalyzerRun = { id: string; exitCode: number; ms: number; diagnostics: number; problem: string | null }
export type Round = { round: number; autofix: { id: string; exitCode: number; ms: number }[]; analyzers: AnalyzerRun[]; targets: number; batches: number; edits: number; rejected: number; unresolved: string[]; ms: number }
/** One of the five shared run statuses (F1): code-analyzer only ever ends ready or incomplete. */
export type Status = 'ready' | 'incomplete'
/** `scope` and `untouched` (KIT-48): a ticket run's changed files, and the diagnostics in files outside them that the run reported but never fixed. */
export type LoopResult = { status: Status; reason: string; reasonCode: ReasonCode | null; rounds: Round[]; initial: Diagnostic[]; remaining: Diagnostic[]; problems: string[]; editedFiles: string[]; rejected: Rejection[]; ms: number; scope?: Scope | null; untouched?: Diagnostic[] }
export type FixRequest = { batch: Batch; round: number; signal?: AbortSignal }
export type FixResult = { edits: number; editedFiles: string[]; rejected: Rejection[]; unresolved: string[] }
export type Fixer = (request: FixRequest) => Promise<FixResult>
export type LoopOptions = {
  maxRounds: number
  maxCostUsd: number
  costSoFar: () => number
  fixWarnings: boolean
  commandTimeoutMs: number
  concurrency: number
  signal?: AbortSignal
  progress?: (message: string) => void
  /** A ticket run's changed files (KIT-48): auto-fix and the model fix stay inside them; null fixes the whole tree. */
  scope?: Scope | null
}

const tail = (text: string, n = 1200) => text.trim().slice(-n)

export async function runAnalyzers(executor: Executor, analyzers: Analyzer[], options: Pick<LoopOptions, 'commandTimeoutMs' | 'signal' | 'progress'>): Promise<{ diagnostics: Diagnostic[]; runs: AnalyzerRun[] }> {
  const diagnostics: Diagnostic[] = []
  const runs: AnalyzerRun[] = []
  for (const analyzer of analyzers) {
    if (!analyzer.check) continue
    options.signal?.throwIfAborted()
    options.progress?.(`analyze ${analyzer.id}`)
    const started = Date.now()
    const result = await executor.run(analyzer.check, { cwd: analyzer.cwd, timeoutMs: options.commandTimeoutMs, signal: options.signal })
    const parsed = result.timedOut ? null : analyzer.parse(result.stdout, result.stderr, { cwd: analyzer.cwd, root: executor.root })
    let problem: string | null = null
    if (result.timedOut) problem = `${analyzer.id}: timed out after ${Math.round(options.commandTimeoutMs / 1000)}s`
    else if (parsed === null) problem = `${analyzer.id}: exit ${result.exitCode}, output not parseable:\n${tail(result.stderr || result.stdout)}`
    else if (parsed.length === 0 && result.exitCode !== 0) problem = `${analyzer.id}: exit ${result.exitCode} with no diagnostics:\n${tail(result.stderr || result.stdout)}`
    if (parsed && !problem) diagnostics.push(...parsed)
    runs.push({ id: analyzer.id, exitCode: result.exitCode, ms: Date.now() - started, diagnostics: parsed?.length ?? 0, problem })
  }
  return { diagnostics, runs }
}

/**
 * Every analyzer's auto-fix, in order, recorded per analyzer: the whole tree, or, with a scope
 * (KIT-48), only the scope's files the tool handles; an analyzer whose fix cannot take files
 * (a project script) is skipped in a scoped run, and one with no matching file runs nothing.
 */
export async function runAutofix(executor: Executor, analyzers: Analyzer[], options: Pick<LoopOptions, 'commandTimeoutMs' | 'signal' | 'progress' | 'scope'>): Promise<Round['autofix']> {
  const autofix: Round['autofix'] = []
  const scope = options.scope ?? null
  for (const analyzer of analyzers) {
    if (!analyzer.fix) continue
    let command = analyzer.fix
    if (scope !== null) {
      if (!analyzer.fixFiles || !analyzer.exts) continue
      const files = filesFor(scope, analyzer.cwd, analyzer.exts)
      if (!files.length) continue
      command = analyzer.fixFiles(files)
    }
    options.progress?.(`autofix ${analyzer.id}`)
    const fixStarted = Date.now()
    const result = await executor.run(command, { cwd: analyzer.cwd, timeoutMs: options.commandTimeoutMs, signal: options.signal })
    autofix.push({ id: analyzer.id, exitCode: result.exitCode, ms: Date.now() - fixStarted })
  }
  return autofix
}

/** The loop's stop reasons, shared with --local so both runs report the same words. */
export const STOP = {
  none: 'no static analysis ran: no analyzers detected',
  allFailed: 'every analyzer failed to run',
  clean: 'analyzers clean',
  noProgress: 'no progress: diagnostics unchanged after a full round',
  roundCap: (maxRounds: number) => `round cap (${maxRounds}) reached`,
  cancelled: 'cancelled',
} as const

/** What the loop tries to fix: errors only, or warnings too; with a scope (KIT-48), only in the files the ticket changed. */
export const targetsOf = (all: Diagnostic[], fixWarnings: boolean, scope: Scope | null = null): Diagnostic[] => partition(fixWarnings ? all : errors(all), scope).targets

/** ready only when nothing targeted remains and every analyzer ran: an analyzer that could not run leaves its verdict unknown. */
export const finalStatus = (remainingTargets: Diagnostic[], problems: string[]): Status => (remainingTargets.length === 0 && !problems.length ? 'ready' : 'incomplete')

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]!, i) }
  }))
  return results
}

/** Autofix → analyze → model fix, until clean, unchanged, capped or cancelled. Every stop has a recorded reason. */
export async function runLoop(executor: Executor, analyzers: Analyzer[], fixer: Fixer, options: LoopOptions): Promise<LoopResult> {
  const started = Date.now()
  const rounds: Round[] = []
  const problems: string[] = []
  const rejected: Rejection[] = []
  const editedFiles = new Set<string>()
  const scope = options.scope ?? null
  const finish = (status: Status, reason: string, initial: Diagnostic[], all: Diagnostic[], reasonCode: ReasonCode | null = null): LoopResult => {
    const { targets: remaining, untouched } = partition(all, scope)
    return { status, reason, reasonCode, rounds, initial, remaining, problems: [...new Set(problems)], editedFiles: [...editedFiles].sort(), rejected, ms: Date.now() - started, scope, untouched }
  }
  if (!analyzers.some((a) => a.check)) return finish('ready', STOP.none, [], [], 'no-analyzers')

  const initialRun = await runAnalyzers(executor, analyzers, options)
  for (const run of initialRun.runs) if (run.problem) problems.push(run.problem)
  if (initialRun.runs.length && initialRun.runs.every((r) => r.problem)) return finish('incomplete', STOP.allFailed, [], [])
  const targetsIn = (all: Diagnostic[]) => targetsOf(all, options.fixWarnings, scope)
  let current = initialRun.diagnostics
  let previous: Diagnostic[] | null = null
  let reason: string = STOP.roundCap(options.maxRounds)

  for (let round = 1; round <= options.maxRounds; round++) {
    if (options.signal?.aborted) { reason = STOP.cancelled; break }
    if (options.costSoFar() >= options.maxCostUsd) { reason = `cost cap ($${options.maxCostUsd}) reached`; break }
    const roundStarted = Date.now()
    const record: Round = { round, autofix: [], analyzers: [], targets: 0, batches: 0, edits: 0, rejected: 0, unresolved: [], ms: 0 }
    rounds.push(record)
    record.autofix = await runAutofix(executor, analyzers, options)
    const analyzed = await runAnalyzers(executor, analyzers, options)
    record.analyzers = analyzed.runs
    for (const run of analyzed.runs) if (run.problem) problems.push(run.problem)
    current = analyzed.diagnostics
    const targets = targetsIn(current)
    record.targets = targets.length
    record.ms = Date.now() - roundStarted
    if (!targets.length) { reason = STOP.clean; break }
    if (previous && sameSet(targets, previous)) { reason = STOP.noProgress; break }
    previous = targets
    if (options.costSoFar() >= options.maxCostUsd) { reason = `cost cap ($${options.maxCostUsd}) reached`; break }
    const batches = batch(targets)
    record.batches = batches.length
    options.progress?.(`round ${round}: ${targets.length} diagnostics in ${batches.length} batches`)
    const results = await mapConcurrent(batches, options.concurrency, async (b) => {
      if (options.signal?.aborted || options.costSoFar() >= options.maxCostUsd) return null
      try { return await fixer({ batch: b, round, signal: options.signal }) }
      catch (error) { problems.push(`round ${round} fixer: ${error instanceof Error ? error.message : String(error)}`); return null }
    })
    for (const result of results) {
      if (!result) continue
      record.edits += result.edits
      record.rejected += result.rejected.length
      record.unresolved.push(...result.unresolved)
      rejected.push(...result.rejected)
      for (const file of result.editedFiles) editedFiles.add(file)
    }
    record.ms = Date.now() - roundStarted
    if (round === options.maxRounds) {
      // The last round's edits deserve a verdict too.
      const final = await runAnalyzers(executor, analyzers, options)
      for (const run of final.runs) if (run.problem) problems.push(run.problem)
      current = final.diagnostics
    }
  }
  // An analyzer that could not run leaves its verdict unknown, so a run with problems is never clean.
  return finish(finalStatus(targetsIn(current), [...new Set(problems)]), reason, initialRun.diagnostics, current)
}
