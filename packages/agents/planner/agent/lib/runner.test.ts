import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { files, spec, validPlan } from './fixtures.test-helper.ts'

const state = vi.hoisted(() => ({ failResearch: false, needsAuthor: false, proseResearch: false, close: vi.fn() }))
vi.mock('@aspiralabs/agent-common/lib/repository', () => ({ repository: async () => ({ files, instructions: '', packet: () => 'src/items.ts:1: existing save', gaps: [], commit: 'abc', dirty: false, tools: { read_files: {} } }), allowedPath: (path: string) => !path.includes('.env') }))
vi.mock('@aspiralabs/agent-common/lib/mcp', () => ({ connectReadTools: async () => ({ tools: {}, reads: [], sources: [], close: state.close }) }))
vi.mock('ai', async (original) => {
  const actual = await original<typeof import('ai')>()
  return { ...actual, gateway: vi.fn(() => ({})), generateText: vi.fn(async (args: { tools?: ToolSet; toolChoice?: unknown; output?: unknown; onStepStart: (value: { stepNumber: number; messages: unknown[] }) => void; onStepEnd: (value: { usage: { inputTokens: number; outputTokens: number }; providerMetadata: unknown; finishReason: string; text: string; toolCalls: unknown[]; toolResults: unknown[] }) => void }) => {
    args.onStepStart({ stepNumber: 0, messages: [] })
    if (state.failResearch && args.tools) throw new Error('Research provider unavailable')
    args.onStepEnd({ usage: { inputTokens: 10, outputTokens: 5 }, providerMetadata: { gateway: { cost: '0.10' } }, finishReason: 'stop', text: 'mock output', toolCalls: [], toolResults: [] })
    if (args.tools) {
      // Research that ends with prose hands in nothing unless it is given a submit-only turn.
      if (state.proseResearch && !args.toolChoice) return { response: { messages: [{ role: 'assistant', content: 'Here is my plan as prose.' }] } }
      await args.tools.submit_research!.execute!({ facts: ['src/items.ts:1 establishes save'], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [] }, { toolCallId: 'test', messages: [], context: {} })
      return {}
    }
    const plan = validPlan()
    if (state.needsAuthor) plan.decisions = ['Choose retention duration before implementing deletion.']
    return { output: plan }
  }) }
})
import { runPlan } from './runner.ts'

beforeEach(() => { state.failResearch = false; state.needsAuthor = false; state.proseResearch = false; state.close.mockClear() })
async function input() {
  const dir = await mkdtemp(join(tmpdir(), 'planner-test-'))
  const specPath = join(dir, 'spec.reviewed.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(specPath, spec)
  await writeFile(guidelinesPath, 'REV-001 Inspect source evidence')
  return { specPath, guidelinesPath, repoPath: dir, uiRequired: false }
}

it('writes only the plan, analysis and trace while preserving the original spec', async () => {
  const args = await input()
  const result = await runPlan(args)
  expect(result.status).toBe('ready')
  expect((await readdir(result.dir)).sort()).toEqual(['plan.reviewed.md', 'run-analysis.md', 'trace'])
  expect(await readFile(args.specPath, 'utf8')).toBe(spec)
  expect(await readFile(join(result.dir, 'plan.reviewed.md'), 'utf8')).toContain('modify `src/items.ts`')
  expect(await readFile(join(result.dir, 'run-analysis.md'), 'utf8')).toContain('$0.2000')
  const trace = JSON.parse(await readFile(join(result.dir, 'trace/calls.json'), 'utf8'))
  expect(trace.calls).toHaveLength(2)
  expect(trace.calls[0].prompt).toContain(spec)
  expect(state.close).toHaveBeenCalled()
})

it('blocks UI planning without live kit evidence and preserves diagnostics', async () => {
  const result = await runPlan({ ...await input(), uiRequired: true })
  expect(result.status).toBe('incomplete')
  expect(result.problems).toContain('UI planning requires successful list_components and get_component MCP reads')
  expect(await readFile(join(result.dir, 'plan.reviewed.md'), 'utf8')).toContain('Status: **incomplete**')
})

it('does not plan after failed research and exports its trace', async () => {
  state.failResearch = true
  const result = await runPlan(await input())
  expect(result.status).toBe('incomplete')
  expect(result.problems).toContain('research: Research provider unavailable')
  expect(await readdir(result.dir)).not.toContain('plan.reviewed.md')
  expect(await readFile(join(result.dir, 'trace/calls.json'), 'utf8')).toContain('Research provider unavailable')
})

it('gives research that stops without submitting one submit-only turn before failing', async () => {
  state.proseResearch = true
  const { generateText } = await import('ai')
  const result = await runPlan(await input())
  expect(result.status).toBe('ready')
  const finalTurn = vi.mocked(generateText).mock.calls.map(([args]) => args as { tools?: ToolSet; toolChoice?: unknown }).find((args) => args.toolChoice)
  expect(Object.keys(finalTurn!.tools!)).toEqual(['submit_research'])
  expect(finalTurn!.toolChoice).toEqual({ type: 'tool', toolName: 'submit_research' })
})

it('requires complete guidelines and rejects unresolved reviewed specs', async () => {
  const args = await input()
  await writeFile(args.guidelinesPath, '')
  await expect(runPlan(args)).rejects.toThrow('complete required-guidelines')
  await writeFile(args.guidelinesPath, 'Rules')
  await writeFile(args.specPath, '> Review status: **needs-author**\n\n' + spec)
  await expect(runPlan(args)).rejects.toThrow('Resolve the spec review')
})

it('puts planning output beside a standard spec review directory', async () => {
  const args = await input()
  const review = join(args.repoPath, 'spec.reviewed')
  await mkdir(review)
  const specPath = join(review, 'spec.reviewed.md')
  await writeFile(specPath, spec)
  const result = await runPlan({ ...args, specPath })
  expect(result.dir).toBe(join(args.repoPath, 'plan.review'))
  expect(await readdir(review)).toEqual(['spec.reviewed.md'])
})

it('keeps product decisions explicit and blocks cancelled runs', async () => {
  state.needsAuthor = true
  const args = await input()
  const result = await runPlan(args)
  expect(result.status).toBe('needs-author')
  expect(await readFile(join(result.dir, 'plan.reviewed.md'), 'utf8')).toContain('Choose retention duration')
  const controller = new AbortController()
  controller.abort(new Error('User cancelled'))
  const cancelled = await runPlan(args, { signal: controller.signal })
  expect(cancelled.status).toBe('incomplete')
  expect(cancelled.problems).toContain('Planning cancelled')
  expect(await readdir(cancelled.dir)).not.toContain('plan.reviewed.md')
})
