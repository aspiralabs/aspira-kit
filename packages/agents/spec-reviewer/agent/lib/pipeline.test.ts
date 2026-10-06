import { describe, expect, it, vi } from 'vitest'
import { runPipeline, type Call } from './pipeline.ts'
import type { Review } from './review.ts'

const review: Review = { facts: [], findings: [{ title: 'Issue', severity: 'medium', whatThisMeans: 'Members would see the wrong list.', evidence: ['spec: quote'], fix: 'fix' }], checks: [{ rule: 'REV-001', evidence: 'spec quote' }], uiEvidence: [], gaps: [] }
const decision = { question: 'How long are saved items kept?', options: ['Forever', 'Until expiry'], recommended: 'Forever', reasoning: 'the app keeps everything else forever', whyYours: 'it changes storage cost' }
const input = { spec: '# Spec', guidelines: 'REV-001 Check facts', context: '', uiRequired: false }

describe('cancellable pipeline', () => {
  it('starts all specialists concurrently with the initial findings', async () => {
    const started: string[] = []
    const releases: (() => void)[] = []
    const call: Call = async (request) => {
      started.push(request.phase)
      if (request.phase === 'research') return review
      if (request.phase === 'synthesis') return { edits: [], dispositions: [] }
      expect(request.prompt).toContain('R1')
      await new Promise<void>((resolve) => releases.push(resolve))
      return review
    }
    const pending = runPipeline(input, call)
    await vi.waitFor(() => expect(releases).toHaveLength(6))
    expect(started).toHaveLength(7)
    releases.forEach((release) => release())
    const result = await pending
    expect(result.findings).toHaveLength(7)
    expect(result.status).toBe('incomplete')
    expect(result.problems).toContain('Missing disposition: R1')
  })
  it('aborts hanging work, preserves completed findings and skips synthesis on parent cancellation', async () => {
    const controller = new AbortController()
    let sawAbort = false
    const phases: string[] = []
    const call: Call = async ({ phase, signal }) => {
      phases.push(phase)
      if (phase === 'research') return review
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')) }, { once: true }))
      return review
    }
    const pending = runPipeline(input, call, { signal: controller.signal })
    await vi.waitFor(() => expect(phases).toHaveLength(7))
    controller.abort(new Error('User cancelled'))
    const result = await pending
    expect(phases).not.toContain('synthesis')
    expect(sawAbort).toBe(true)
    expect(result.findings).toHaveLength(1)
    expect(result.status).toBe('incomplete')
  })
  it('requires UI evidence and reports missing rule checks', async () => {
    const call: Call = async ({ phase }) => phase === 'synthesis' ? { edits: [], dispositions: [] } : { ...review, findings: [], checks: [] }
    const result = await runPipeline({ ...input, uiRequired: true }, call)
    expect(result.problems).toContain('Uncovered guideline: REV-001')
    expect(result.problems).toContain('UI catalog/component evidence missing')
  })
})

it('produces a valid candidate without mutating source and preserves author decisions', async () => {
  const spec = '# Original'
  const candidate = '# Feature\n## Intent\nSave items.\n## Acceptance criteria\n### Features\n- [ ] F1: Save an item idempotently.\n'
  const call: Call = async ({ phase }) => {
    if (phase === 'research') return review
    if (phase !== 'synthesis') return { ...review, findings: [] }
    return { edits: [{ id: 'E1', before: spec, after: candidate }], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Contract repair', evidence: ['spec: Original'], editIds: ['E1'], duplicateOf: null }] }
  }
  const result = await runPipeline({ ...input, spec }, call)
  expect(result.status).toBe('ready')
  expect(result.candidate).toBe(candidate)
  expect(spec).toBe('# Original')
  const authorCall: Call = async (request) => request.phase === 'synthesis' ? { edits: [], dispositions: [{ findingId: 'R1', status: 'author', reason: 'Choose retention: forever costs storage; expiration removes history.', evidence: [], editIds: [], duplicateOf: null, decision }] } : call(request)
  const open = await runPipeline({ ...input, spec: candidate }, authorCall)
  expect(open.status).toBe('needs-author')
  expect(open.authorDecisions).toEqual([{ ...decision, id: 'R1', decidedBy: 'open', answer: null }])
})

it('refuses an author disposition without a decision, and records a ticked answer as the author\'s so the spec no longer needs them', async () => {
  const candidate = '# Feature\n## Intent\nSave items.\n## Acceptance criteria\n### Features\n- [ ] F1: Save an item idempotently.\n'
  const without: Call = async ({ phase }) => phase === 'synthesis' ? { edits: [], dispositions: [{ findingId: 'R1', status: 'author', reason: 'Choose retention.', evidence: [], editIds: [], duplicateOf: null }] } : phase === 'research' ? review : { ...review, findings: [] }
  const missing = await runPipeline({ ...input, spec: candidate }, without)
  expect(missing.status).toBe('incomplete')
  expect(missing.problems).toContain('Author disposition without a decision (question, options, recommended, reasoning, whyYours): R1')
  const withDecision: Call = async (request) => request.phase === 'synthesis' ? { edits: [], dispositions: [{ findingId: 'R1', status: 'author', reason: 'Choose retention.', evidence: [], editIds: [], duplicateOf: null, decision }] } : without(request)
  const answered = await runPipeline({ ...input, spec: candidate, answers: [{ id: 'S3-1', question: 'How long are saved items kept', answer: 'Until expiry' }] }, withDecision)
  expect(answered.status).toBe('ready')
  expect(answered.authorDecisions).toEqual([{ ...decision, id: 'R1', decidedBy: 'author', answer: 'Until expiry' }])
})

it('preserves findings but publishes no candidate on malformed synthesis', async () => {
  const call: Call = async ({ phase }) => phase === 'synthesis' ? { wrong: 'schema' } : review
  const result = await runPipeline(input, call)
  expect(result.findings).toHaveLength(7)
  expect(result.candidate).toBeNull()
  expect(result.status).toBe('incomplete')
  expect(result.problems.some((problem) => problem.startsWith('synthesis:'))).toBe(true)
})

it('requires evidence to resolve a gap and lets another reviewer supply it', async () => {
  const spec = '# Feature\n## Intent\nSave.\n## Acceptance criteria\n### Features\n- [ ] F1: Save an item.\n### Tests\n- [ ] unit: [F1] save twice is idempotent.\n- [ ] integration: [F1] save persists.\n'
  const call: Call = async ({ phase }) => {
    if (phase === 'synthesis') return { edits: [], dispositions: [], gapResolutions: [{ gapId: 'G1', status: 'resolved', evidence: ['security read auth.ts:10: server denies anonymous'] }] }
    return { ...review, findings: [], gaps: phase === 'research' ? ['Auth policy not read yet'] : [] }
  }
  expect((await runPipeline({ ...input, spec }, call)).status).toBe('ready')
  const unsupported: Call = async (request) => request.phase === 'synthesis' ? { edits: [], dispositions: [], gapResolutions: [{ gapId: 'G1', status: 'resolved', evidence: [] }] } : call(request)
  expect((await runPipeline({ ...input, spec }, unsupported)).status).toBe('incomplete')
})

it('lets every phase finish beyond the former time limits and records elapsed time', async () => {
  vi.useFakeTimers()
  try {
    const signals: AbortSignal[] = []
    const call: Call = async ({ phase, signal }) => {
      signals.push(signal)
      await new Promise((resolve) => setTimeout(resolve, 600_000))
      if (phase === 'synthesis') return { edits: [], dispositions: [] }
      return { ...review, findings: [] }
    }
    const spec = '# Feature\n## Intent\nSave items.\n## Acceptance criteria\n### Features\n- [ ] F1: Save an item.\n'
    const pending = runPipeline({ ...input, spec }, call)
    await vi.advanceTimersByTimeAsync(1_800_000)
    const result = await pending
    expect(result.status).toBe('ready')
    expect(signals).toHaveLength(8)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    expect(result.phases.every((phase) => phase.ms === 600_000)).toBe(true)
    expect(result.reviewMs).toBe(1_800_000)
  } finally { vi.useRealTimers() }
})
