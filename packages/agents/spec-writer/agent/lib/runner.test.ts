import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'

const fixture = vi.hoisted(() => ({
  draft: '# Save items\n## Intent\nLet people save items.\n## Acceptance criteria\n### Features\n- [ ] F1: A saved item appears in the list.\n',
  models: [] as string[],
}))
vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: { read_files: {} } }) }))
vi.mock('./mcp.ts', () => ({ connectReadTools: async () => ({ tools: {}, sources: [], reads: [], close: async () => {} }) }))
vi.mock('@aspiralabs/agent-common/lib/gateway', async (original) => ({ ...await original<typeof import('@aspiralabs/agent-common/lib/gateway')>(), gateway: vi.fn((model: string) => { fixture.models.push(model); return {} }) }))
vi.mock('ai', async (original) => {
  const actual = await original<typeof import('ai')>()
  const mock = { ...actual, generateText: vi.fn(async (args: { prompt: string; tools?: ToolSet; output?: unknown; onStepStart: (value: { stepNumber: number; messages: unknown[] }) => void; onStepEnd: (value: { usage: { inputTokens: number; outputTokens: number }; finishReason: string; text: string; toolCalls: unknown[]; toolResults: unknown[] }) => void }) => {
    args.onStepStart({ stepNumber: 0, messages: [{ role: 'user', content: args.prompt }] })
    const review = { facts: [], findings: [] as unknown[], checks: [{ rule: 'REV-001', evidence: 'spec: Save items' }], uiEvidence: [], gaps: [] }
    let result: unknown = review
    if (args.prompt.includes('Explore the repository for this idea')) result = { facts: ['source.ts:1: evidence'], constraints: [], questions: [], uiEvidence: [], gaps: [] }
    else if (args.prompt.includes('Write the complete initial spec')) result = { spec: fixture.draft, assumptions: [] }
    else if (args.prompt.includes('Research and raise')) result = { ...review, findings: [{ title: 'Retention unstated', evidence: ['spec: list'], fix: 'State retention' }] }
    else if (args.prompt.includes('Reconcile once')) result = { edits: [{ id: 'E1', before: 'appears in the list.', after: 'appears in the list until removed.' }], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Retention stated', evidence: ['spec: list'], editIds: ['E1'], duplicateOf: null }] }
    args.onStepEnd({ usage: { inputTokens: 100, outputTokens: 10 }, finishReason: 'stop', text: 'mock model output', toolCalls: [], toolResults: [] })
    if (args.output !== undefined) return { output: result }
    const submit = Object.keys(args.tools ?? {}).find((name) => name.startsWith('submit_'))!
    await args.tools![submit]!.execute!(result, { toolCallId: 'test', messages: [], context: {} })
    return {}
  }) }
  // The agents stream structured output; the stand-in streams the same generateText result, so its calls stay recorded there.
  return { ...mock, streamText: vi.fn((args: Parameters<typeof mock.generateText>[0]) => {
    const run = mock.generateText(args) as Promise<{ output?: unknown }>
    return { output: run.then((value) => value.output), consumeStream: () => run.then(() => undefined) }
  }) }
})
import { runWrite } from './runner.ts'

it('writes the draft and the reviewed spec beside the idea without altering it, on Claude and OpenAI models', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-writer-export-test-'))
  const ideaPath = join(dir, 'idea.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(ideaPath, 'Let people save items.')
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  const result = await runWrite({ ideaPath, guidelinesPath, repoPath: dir, uiRequired: false })
  expect(result).toMatchObject({ status: 'ready', dir: join(dir, 'spec.written'), spec: join(dir, 'spec.written/spec.md'), draft: join(dir, 'spec.written/spec.draft.md'), findings: 1 })
  expect(await readFile(ideaPath, 'utf8')).toBe('Let people save items.')
  expect((await readdir(result.dir)).sort()).toEqual(['idea.md', 'run-analysis.md', 'spec.draft.md', 'spec.md', 'trace'])
  expect(await readFile(join(result.dir, 'spec.draft.md'), 'utf8')).toBe(fixture.draft)
  expect(await readFile(join(result.dir, 'spec.md'), 'utf8')).toContain('until removed')
  expect(await readFile(join(result.dir, 'trace/exploration.md'), 'utf8')).toContain('source.ts:1: evidence')
  expect(await readFile(join(result.dir, 'trace/findings.md'), 'utf8')).toContain('R1')
  expect(await readFile(join(result.dir, 'run-analysis.md'), 'utf8')).toContain('Run analysis')
  const trace = JSON.parse(await readFile(join(result.dir, 'trace/calls.json'), 'utf8'))
  expect(trace.calls.map((c: { phase: string }) => c.phase).slice(0, 3)).toEqual(['explore', 'draft', 'research'])
  expect(trace.calls).toHaveLength(10)
  const usage = JSON.parse(await readFile(join(result.dir, 'trace/usage.json'), 'utf8'))
  expect(usage.turns).toHaveLength(10)
  expect(new Set(fixture.models)).toEqual(new Set(['anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol']))
  const rerun = await runWrite({ ideaPath, guidelinesPath, repoPath: dir, uiRequired: false })
  expect(await readdir(join(rerun.dir, 'trace/history'))).toHaveLength(1)
  await expect(runWrite({ ideaPath, guidelinesPath, repoPath: dir, outputDir: dir })).rejects.toThrow('must not contain')
})
