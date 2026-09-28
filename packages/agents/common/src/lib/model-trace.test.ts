import { expect, it, vi } from 'vitest'
import { modelTrace } from './model-trace.ts'

it('honors explicit cancellation, records failed turns and ignores late callbacks', async () => {
  const controller = new AbortController()
  const trace = modelTrace(Date.now(), controller.signal)
  let late: (() => void) | undefined
  let aborted = false
  const pending = trace.invoke({ phase: 'research', model: 'test', prompt: 'evidence' }, async (signal, hooks) => {
    hooks.onStepStart({ stepNumber: 0, messages: [] })
    signal.addEventListener('abort', () => { aborted = true })
    late = () => hooks.onStepEnd({ usage: {}, finishReason: 'stop', text: 'late', toolCalls: [], toolResults: [] })
    return new Promise(() => {})
  })
  controller.abort(new Error('User cancelled'))
  const result = await pending
  late!()
  expect(result).toBeNull()
  expect(aborted).toBe(true)
  expect(trace.turns[0]?.status).toBe('failed')
  expect(trace.calls[0]?.error).toContain('User cancelled')
  expect(trace.phases[0]?.error).not.toBeNull()
})

it('allows a slow model to finish and records its complete usage', async () => {
  vi.useFakeTimers()
  try {
    const trace = modelTrace(Date.now())
    const pending = trace.invoke({ phase: 'planning', model: 'test', prompt: 'plan' }, async (signal, hooks) => {
      hooks.onStepStart({ stepNumber: 0 })
      await new Promise((resolve) => setTimeout(resolve, 600_000))
      expect(signal.aborted).toBe(false)
      hooks.onStepEnd({ usage: { inputTokens: 100, outputTokens: 200 }, finishReason: 'stop', text: 'plan', toolCalls: [], toolResults: [] })
      return 'plan'
    })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(await pending).toBe('plan')
    expect(trace.turns[0]).toMatchObject({ status: 'completed', durationMs: 600_000, usage: { outputTokens: 200 } })
    expect(trace.phases[0]).toEqual({ phase: 'planning', ms: 600_000, error: null })
  } finally { vi.useRealTimers() }
})
