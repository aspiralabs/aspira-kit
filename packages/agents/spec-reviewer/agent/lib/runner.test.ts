import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'

const fixture = vi.hoisted(() => ({ candidate: '# Feature\n## Intent\nSave items.\n## Acceptance criteria\n### Features\n- [ ] F1: Save an item idempotently.\n' }))
vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: { read_files: {} } }) }))
vi.mock('./mcp.ts', () => ({ connectReadTools: async () => ({ tools: {}, sources: [], reads: [], close: async () => {} }) }))
vi.mock('ai', async (original) => {
  const actual = await original<typeof import('ai')>()
  return { ...actual, gateway: vi.fn(() => ({})), generateText: vi.fn(async (args: { prompt: string; tools: ToolSet; prepareStep: (input: { stepNumber: number }) => { activeTools?: string[] }; output?: unknown; onStepStart: (value: { stepNumber: number; messages: unknown[] }) => void; onStepEnd: (value: { usage: { inputTokens: number; outputTokens: number }; finishReason: string; text: string; toolCalls: unknown[]; toolResults: unknown[] }) => void }) => {
    args.onStepStart({ stepNumber: 0, messages: [{ role: 'user', content: args.prompt }] })
    const synthesis = args.prompt.includes('Reconcile once')
    if (!synthesis && args.output === undefined) expect(args.prepareStep({ stepNumber: 0 }).activeTools).not.toContain('submit_review')
    const result = synthesis
      ? { edits: [{ id: 'E1', before: '# Original', after: fixture.candidate }], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Repair acceptance contract', evidence: ['spec: Original'], editIds: ['E1'], duplicateOf: null }] }
      : { facts: [], findings: args.prompt.includes('Research and raise') ? [{ title: 'Missing contract', evidence: ['spec: Original'], fix: 'Add intent and acceptance' }] : [], checks: [{ rule: 'REV-001', evidence: 'spec: Original' }], uiEvidence: [], gaps: [] }
    args.onStepEnd({ usage: { inputTokens: 100, outputTokens: 10 }, finishReason: 'stop', text: 'mock model output', toolCalls: [], toolResults: [] })
    if (args.output !== undefined) return { output: result }
    await args.tools.submit_review!.execute!(result, { toolCallId: 'test', messages: [], context: {} })
    return {}
  }) }
})
import { runReview } from './runner.ts'

it('exports a reviewed candidate and raw findings without altering the source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-review-export-test-'))
  const specPath = join(dir, 'spec.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(specPath, '# Original')
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  const result = await runReview({ specPath, guidelinesPath, repoPath: dir, uiRequired: false })
  expect(result.status).toBe('ready')
  expect(result.dir).toBe(join(dir, 'spec.reviewed'))
  expect(await readFile(specPath, 'utf8')).toBe('# Original')
  expect(await readFile(join(result.dir, 'spec.reviewed.md'), 'utf8')).toBe(fixture.candidate)
  expect(await readFile(join(result.dir, 'trace/findings.md'), 'utf8')).toContain('R1')
  expect(await readFile(join(result.dir, 'run-analysis.md'), 'utf8')).toContain('Run analysis')
  expect((await readdir(result.dir)).sort()).toEqual(['run-analysis.md', 'spec.original.md', 'spec.reviewed.md', 'trace'])
  const trace = JSON.parse(await readFile(join(result.dir, 'trace/calls.json'), 'utf8'))
  expect(trace.calls).toHaveLength(8)
  expect(trace.calls[0].prompt).toContain('# Original')
  expect(trace.calls[0].output.findings[0].title).toBe('Missing contract')
  const usage = JSON.parse(await readFile(join(result.dir, 'trace/usage.json'), 'utf8'))
  expect(usage.turns).toHaveLength(8)
  expect(usage.turns[0]).toMatchObject({ turn: 1, status: 'completed', text: 'mock model output' })
  expect(usage.turns[0].durationMs).toBeGreaterThanOrEqual(0)
  const custom = await runReview({ specPath, guidelinesPath, repoPath: dir, uiRequired: false, outputDir: join(dir, 'custom-review') })
  expect(custom.dir).toBe(join(dir, 'custom-review'))
  expect(await readFile(join(custom.dir, 'spec.reviewed.md'), 'utf8')).toBe(fixture.candidate)
  await expect(runReview({ specPath, guidelinesPath, repoPath: dir, outputDir: dir })).rejects.toThrow('must not contain')
})
