import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { files, spec, validPlan } from './fixtures.test-helper.ts'

const retention = { question: 'Choose retention duration before implementing deletion?', options: ['Keep forever', 'Delete after 30 days'], recommended: 'Keep forever', reasoning: 'nothing else in the app expires', whyYours: 'storage cost is a product choice' }
const state = vi.hoisted(() => ({ failResearch: false, needsAuthor: false, proseResearch: false, partialChecks: false, gapResearch: false, guidelineTool: false, researchSkipsPages: false, brokenPlans: 0, uiPlan: false, refusals: [] as unknown[], close: vi.fn() }))
vi.mock('@aspiralabs/agent-common/lib/repository', () => ({ repository: async () => ({ files, instructions: '', packet: () => 'src/items.ts:1: existing save', gaps: [], commit: 'abc', dirty: false, tools: { read_files: {} } }), allowedPath: (path: string) => !path.includes('.env') }))
vi.mock('@aspiralabs/agent-common/lib/mcp', () => ({ connectReadTools: async () => ({ tools: state.guidelineTool ? { notion__read_guideline: { execute: async () => ({ content: [{ type: 'text', text: JSON.stringify({ source: 'https://www.notion.so/topic', markdown: 'TEST-001 Write the failing test first.' }) }] }) } } : {}, reads: [], sources: [], close: state.close }) }))
vi.mock('ai', async (original) => {
  const actual = await original<typeof import('ai')>()
  const mock = { ...actual, gateway: vi.fn(() => ({})), generateText: vi.fn(async (args: { tools?: ToolSet; toolChoice?: unknown; messages?: unknown[]; output?: unknown; onStepStart: (value: { stepNumber: number; messages: unknown[] }) => void; onStepEnd: (value: { usage: { inputTokens: number; outputTokens: number }; providerMetadata: unknown; finishReason: string; text: string; toolCalls: unknown[]; toolResults: unknown[] }) => void }) => {
    args.onStepStart({ stepNumber: 0, messages: [] })
    if (state.failResearch && args.tools) throw new Error('Research provider unavailable')
    args.onStepEnd({ usage: { inputTokens: 10, outputTokens: 5 }, providerMetadata: { gateway: { cost: '0.10' } }, finishReason: 'stop', text: 'mock output', toolCalls: [], toolResults: [] })
    if (args.tools) {
      // Research that ends with prose hands in nothing unless it is given a submit-only turn.
      if (state.proseResearch && !args.toolChoice) {
        const prose = { role: 'assistant', content: 'Here is my plan as prose.' }
        // response.messages holds only the last step; responseMessages holds every step.
        return { response: { messages: [prose] }, responseMessages: [{ role: 'assistant', content: 'read src/items.ts' }, { role: 'tool', content: 'EARLIER READ' }, prose] }
      }
      if (state.guidelineTool && !state.researchSkipsPages) {
        await args.tools.notion__read_guideline!.execute!({ page: 'topic' }, { toolCallId: 'page', messages: [], context: {} })
        await args.tools.notion__read_guideline!.execute!({ page: 'topic' }, { toolCallId: 'page-again', messages: [], context: {} })
      }
      if (state.gapResearch) {
        const withGaps = { facts: [], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: ['Did not read src/items.ts'], decisions: [] }
        state.refusals.push(await args.tools.submit_research!.execute!(withGaps, { toolCallId: 'gaps', messages: [], context: {} }))
        state.refusals.push(await args.tools.submit_research!.execute!(withGaps, { toolCallId: 'gaps-again', messages: [], context: {} }))
        return {}
      }
      if (state.partialChecks) state.refusals.push(await args.tools.submit_research!.execute!({ facts: ['src/items.ts:1 establishes save'], checks: [], gaps: [], decisions: [] }, { toolCallId: 'early', messages: [], context: {} }))
      await args.tools.submit_research!.execute!({ facts: ['src/items.ts:1 establishes save'], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [] }, { toolCallId: 'test', messages: [], context: {} })
      return {}
    }
    const plan = validPlan()
    if (state.brokenPlans > 0) { state.brokenPlans--; plan.tasks[1]!.dependsOn = [] }
    if (state.uiPlan) plan.tasks[1]!.changes[0]!.path = 'src/components/item-card.tsx'
    if (state.needsAuthor) plan.decisions = [retention]
    return { output: plan }
  }) }
  // The agents stream structured output; the stand-in streams the same generateText result, so its calls stay recorded there.
  return { ...mock, streamText: vi.fn((args: Parameters<typeof mock.generateText>[0]) => {
    const run = mock.generateText(args) as Promise<{ output?: unknown }>
    return { output: run.then((value) => value.output), consumeStream: () => run.then(() => undefined) }
  }) }
})
import { runPlan } from './runner.ts'

beforeEach(() => { Object.assign(state, { failResearch: false, needsAuthor: false, proseResearch: false, partialChecks: false, gapResearch: false, guidelineTool: false, researchSkipsPages: false, brokenPlans: 0, uiPlan: false, refusals: [] }); state.close.mockClear() })
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
  state.uiPlan = true
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

it('sends research that replies without submitting back to keep reading, told how many turns it has left', async () => {
  state.proseResearch = true
  const { generateText } = await import('ai')
  vi.mocked(generateText).mockClear()
  await runPlan(await input())
  const calls = vi.mocked(generateText).mock.calls.map(([args]) => args as { toolChoice?: unknown; messages?: { role: string; content: unknown }[] })
  const research = calls.filter((args) => args.messages !== undefined || !('output' in args))
  // Nine free turns (one per call here), then the forced submit: never a hand-in after the first reply.
  expect(research.filter((args) => !args.toolChoice)).toHaveLength(9)
  const second = research[1]!.messages!
  expect(second.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('you have 9 turns left') })
  expect(JSON.stringify(second)).toContain('EARLIER READ')
})

it('gives research that stops without submitting one submit-only turn before failing', async () => {
  state.proseResearch = true
  const { generateText } = await import('ai')
  const result = await runPlan(await input())
  expect(result.status).toBe('ready')
  const finalTurn = vi.mocked(generateText).mock.calls.map(([args]) => args as { tools?: ToolSet; toolChoice?: unknown; messages?: unknown[] }).find((args) => args.toolChoice)
  expect(Object.keys(finalTurn!.tools!)).toEqual(['submit_research'])
  // The submit-only turn sees every earlier step, including tool results, not just the final prose.
  expect(JSON.stringify(finalTurn!.messages)).toContain('EARLIER READ')
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
  expect(result.decisions).toEqual([{ ...retention, id: 'D1', decidedBy: 'open', answer: null }])
  const rendered = await readFile(join(result.dir, 'plan.reviewed.md'), 'utf8')
  expect(rendered).toContain('### D1 — Choose retention duration before implementing deletion?')
  expect(rendered).toContain('- [ ] Keep forever _(recommended: nothing else in the app expires)_')
  const decisionsFile = join(result.dir, 'trace/decisions.md')
  const text = await readFile(decisionsFile, 'utf8')
  expect(text).toContain('1 decision: 1 open · 0 answered')
  expect(text).toContain('## D1 — Choose retention duration before implementing deletion?\n\n- [ ] Keep forever _(recommended: nothing else in the app expires)_\n- [ ] Delete after 30 days\n\nWhy it is yours to decide: storage cost is a product choice')
  // The author ticks an option and reruns the planner: the decision is theirs and the plan is ready.
  await writeFile(decisionsFile, text.replace('- [ ] Delete after 30 days', '- [x] Delete after 30 days'))
  const again = await runPlan(args)
  expect(again.status).toBe('ready')
  expect(again.decisions).toEqual([{ ...retention, id: 'D1', decidedBy: 'author', answer: 'Delete after 30 days' }])
  const review = JSON.parse(await readFile(join(again.dir, 'trace/review.json'), 'utf8'))
  expect(review.decisions).toEqual([expect.objectContaining({ id: 'D1', decidedBy: 'author', answer: 'Delete after 30 days' })])
  expect(await readFile(join(again.dir, 'trace/decisions.md'), 'utf8')).toContain('Decided by the author: Delete after 30 days.')
  const controller = new AbortController()
  controller.abort(new Error('User cancelled'))
  const cancelled = await runPlan(args, { signal: controller.signal })
  expect(cancelled.status).toBe('incomplete')
  expect(cancelled.problems).toContain('Planning cancelled')
  expect(await readdir(cancelled.dir)).not.toContain('plan.reviewed.md')
})

it('sends research and planning the exact default prompt bytes', async () => {
  // Built here by hand, not from runner helpers: --local shares those helpers, so this pins
  // the default path's bytes independently of them.
  const { system, researchSystem, researchInstructions, planningInstructions } = await import('./prompts.ts')
  const { generateText } = await import('ai')
  vi.mocked(generateText).mockClear()
  const args = await input()
  await runPlan(args)
  const sent = vi.mocked(generateText).mock.calls.map(([call]) => call as { system?: string; prompt?: string })
  const context = `BUSINESS SPEC (spec.reviewed.md):\n${spec}\n\nREQUIRED GUIDELINES:\nREV-001 Inspect source evidence\n\nREPOSITORY INSTRUCTIONS:\nThe repository has no AGENTS.md or CLAUDE.md at its root.\n\n\nsrc/items.ts:1: existing save`
  const research = { facts: ['src/items.ts:1 establishes save'], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [] }
  expect(sent.map((call) => call.system)).toEqual([researchSystem, system])
  expect(sent[0]!.prompt).toBe(`${context}\n\n${researchInstructions}`)
  expect(sent[1]!.prompt).toBe(`${context}\n\nRESEARCH:\n${JSON.stringify(research)}\n\n${planningInstructions}`)
})

it('needs UI kit reads only when the plan writes UI files', async () => {
  const result = await runPlan({ ...await input(), uiRequired: true })
  expect(result.problems).not.toContain('UI planning requires successful list_components and get_component MCP reads')
  expect(result.status).toBe('ready')
})

it('refuses research that leaves a required rule out, naming the rule, then takes the full submission', async () => {
  state.partialChecks = true
  const result = await runPlan(await input())
  expect(state.refusals).toEqual([expect.objectContaining({ accepted: false, reason: expect.stringContaining('REV-001') })])
  expect(result.status).toBe('ready')
})

it('hands a plan that fails its checks back for a correction pass and keeps the corrected plan', async () => {
  state.brokenPlans = 1
  const { generateText } = await import('ai')
  vi.mocked(generateText).mockClear()
  const result = await runPlan(await input())
  expect(result.status).toBe('ready')
  const prompts = vi.mocked(generateText).mock.calls.map(([call]) => (call as { prompt?: string }).prompt ?? '')
  expect(prompts).toHaveLength(3)
  expect(prompts[2]).toContain('PLAN CHECKS:\n- Implementation P2 needs an earlier test dependency for F1')
  const trace = JSON.parse(await readFile(join(result.dir, 'trace/calls.json'), 'utf8'))
  expect(trace.calls.map((call: { phase: string }) => call.phase)).toEqual(['research', 'planning', 'repair-1'])
})

it('stops correcting when a pass does not improve the plan, after at most two passes', async () => {
  state.brokenPlans = 5
  const result = await runPlan(await input())
  expect(result.status).toBe('incomplete')
  const trace = JSON.parse(await readFile(join(result.dir, 'trace/calls.json'), 'utf8'))
  expect(trace.calls.map((call: { phase: string }) => call.phase)).toEqual(['research', 'planning', 'repair-1'])
})

it('refuses research\'s first gaps once while it has turns left, telling it to read them; a second submission stands', async () => {
  state.gapResearch = true
  const result = await runPlan(await input())
  expect(state.refusals).toEqual([
    expect.objectContaining({ accepted: false, reason: expect.stringContaining('read these now instead of listing them as gaps') }),
    { accepted: true },
  ])
  expect(result.problems).toContain('Research gap: Did not read src/items.ts')
})

it('hands planning the full text of every guideline page research read, once each', async () => {
  state.guidelineTool = true
  const { generateText } = await import('ai')
  vi.mocked(generateText).mockClear()
  await runPlan(await input())
  const planning = vi.mocked(generateText).mock.calls.map(([call]) => call as { prompt?: string; output?: unknown }).find((call) => call.output)!
  expect(planning.prompt).toContain('GUIDELINE PAGES READ DURING RESEARCH (full text):\nSOURCE https://www.notion.so/topic\nTEST-001 Write the failing test first.\n\n')
  expect(planning.prompt!.split('TEST-001 Write the failing test first.')).toHaveLength(2)
})

it('hands planning every page the required guidelines link to, even ones research did not open', async () => {
  state.guidelineTool = true
  state.researchSkipsPages = true
  const args = await input()
  await writeFile(args.guidelinesPath, 'REV-001 Inspect source evidence\n| Any code change | [Testing](https://app.notion.com/p/44444444444444444444444444444444) |\n')
  const { generateText } = await import('ai')
  vi.mocked(generateText).mockClear()
  await runPlan(args)
  const planning = vi.mocked(generateText).mock.calls.map(([call]) => call as { prompt?: string; output?: unknown }).find((call) => call.output)!
  expect(planning.prompt).toContain('GUIDELINE PAGES READ DURING RESEARCH (full text):\nSOURCE https://www.notion.so/topic\nTEST-001 Write the failing test first.')
})
