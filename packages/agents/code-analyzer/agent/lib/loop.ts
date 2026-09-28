import type { Analyzer } from './analyzers.ts'
import { batch, errors, sameSet, type Batch, type Diagnostic } from './diagnostics.ts'
import type { Executor } from './executor.ts'
import type { Rejection } from './guards.ts'

export type AnalyzerRun = { id: string; exitCode: number; ms: number; diagnostics: number; problem: string | null }
export type Round = { round: number; autofix: { id: string; exitCode: number; ms: number }[]; analyzers: AnalyzerRun[]; targets: number; batches: number; edits: number; rejected: number; unresolved: string[]; ms: number }
export type Status = 'clean' | 'partial' | 'nothing-detected' | 'failed'
export type LoopResult = { status: Status; reason: string; rounds: Round[]; initial: Diagnostic[]; remaining: Diagnostic[]; problems: string[]; editedFiles: string[]; rejected: Rejection[]; ms: number }
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
  const finish = (status: Status, reason: string, initial: Diagnostic[], remaining: Diagnostic[]): LoopResult =>
    ({ status, reason, rounds, initial, remaining, problems: [...new Set(problems)], editedFiles: [...editedFiles].sort(), rejected, ms: Date.now() - started })
  if (!analyzers.some((a) => a.check)) return finish('nothing-detected', 'no analyzers detected', [], [])

  const initialRun = await runAnalyzers(executor, analyzers, options)
  for (const run of initialRun.runs) if (run.problem) problems.push(run.problem)
  if (initialRun.runs.length && initialRun.runs.every((r) => r.problem)) return finish('failed', 'every analyzer failed to run', [], [])
  const targetsOf = (all: Diagnostic[]) => (options.fixWarnings ? all : errors(all))
  let current = initialRun.diagnostics
  let previous: Diagnostic[] | null = null
  let reason = `round cap (${options.maxRounds}) reached`

  for (let round = 1; round <= options.maxRounds; round++) {
    if (options.signal?.aborted) { reason = 'cancelled'; break }
    if (options.costSoFar() >= options.maxCostUsd) { reason = `cost cap ($${options.maxCostUsd}) reached`; break }
    const roundStarted = Date.now()
    const record: Round = { round, autofix: [], analyzers: [], targets: 0, batches: 0, edits: 0, rejected: 0, unresolved: [], ms: 0 }
    rounds.push(record)
    for (const analyzer of analyzers) {
      if (!analyzer.fix) continue
      options.progress?.(`autofix ${analyzer.id}`)
      const fixStarted = Date.now()
      const result = await executor.run(analyzer.fix, { cwd: analyzer.cwd, timeoutMs: options.commandTimeoutMs, signal: options.signal })
      record.autofix.push({ id: analyzer.id, exitCode: result.exitCode, ms: Date.now() - fixStarted })
    }
    const analyzed = await runAnalyzers(executor, analyzers, options)
    record.analyzers = analyzed.runs
    for (const run of analyzed.runs) if (run.problem) problems.push(run.problem)
    current = analyzed.diagnostics
    const targets = targetsOf(current)
    record.targets = targets.length
    record.ms = Date.now() - roundStarted
    if (!targets.length) { reason = 'analyzers clean'; break }
    if (previous && sameSet(targets, previous)) { reason = 'no progress: diagnostics unchanged after a full round'; break }
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
  const remainingTargets = targetsOf(current)
  // An analyzer that could not run leaves its verdict unknown, so a run with problems is never clean.
  const status: Status = remainingTargets.length === 0 && !problems.length ? 'clean' : 'partial'
  return finish(status, reason, initialRun.diagnostics, current)
}
