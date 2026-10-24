import type { UsageEntry, PhaseTiming } from './run-analysis.ts'

export function modelTrace(started: number, parent?: AbortSignal) {
  const turns: UsageEntry[] = []
  const phases: PhaseTiming[] = []
  const calls: { phase: string; model: string; prompt: string; startedMs: number; durationMs?: number; output?: unknown; error?: string }[] = []
  async function invoke<T>(request: { phase: string; model: string; prompt: string }, execute: (signal: AbortSignal, hooks: {
    onStepStart: (step: { stepNumber: number; messages?: unknown }) => void
    onStepEnd: (step: { usage: UsageEntry['usage']; providerMetadata?: unknown; finishReason: string; text: string; toolCalls: unknown; toolResults: unknown }) => void
  }) => Promise<T>): Promise<T | null> {
    const start = Date.now()
    const record: (typeof calls)[number] = { ...request, startedMs: start - started }
    calls.push(record)
    const signal = parent ?? new AbortController().signal
    let current: UsageEntry | undefined
    let onAbort: (() => void) | undefined
    let finished = false
    let error: string | null = null
    try {
      signal.throwIfAborted()
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([execute(signal, {
        onStepStart(step) {
          if (finished) return
          current = { phase: request.phase, model: request.model, turn: step.stepNumber + 1, startedMs: Date.now() - started, status: 'running', usage: {}, messages: step.messages }
          turns.push(current)
        },
        onStepEnd(step) {
          if (finished || !current) return
          Object.assign(current, { usage: step.usage, providerMetadata: step.providerMetadata, finishReason: step.finishReason, text: step.text, toolCalls: step.toolCalls, toolResults: step.toolResults, status: 'completed', durationMs: Date.now() - started - current.startedMs })
        },
      }), aborted])
      record.output = result
      return result
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      record.error = error
      return null
    } finally {
      finished = true
      if (onAbort) signal.removeEventListener('abort', onAbort)
      if (current?.status === 'running') { current.status = 'failed'; current.durationMs = Date.now() - started - current.startedMs }
      record.durationMs = Date.now() - start
      phases.push({ phase: request.phase, ms: record.durationMs, error })
    }
  }
  return { turns, phases, calls, invoke }
}
