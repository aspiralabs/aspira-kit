import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))
import { KnowledgeRequired } from './local-knowledge.ts'
import { knowledgeStage, runLocal } from './local.ts'

const draft = '# Save items\n## Intent\nLet people save items.\n## Acceptance criteria\n### Features\n- [ ] F1: A saved item appears in the list.\n'
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Save items' }], uiEvidence: [], gaps: [] })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'spec-writer-local-'))
  const ideaPath = join(dir, 'idea.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(ideaPath, 'Let people save items.')
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  return { dir, ideaPath, input: { ideaPath, guidelinesPath, repoPath: dir, uiRequired: false } }
}

async function pending(input: Parameters<typeof runLocal>[0]) {
  const step = await runLocal(input)
  if (!step.pending) throw new Error(`expected pending, got ${step.status}`)
  return step
}

it('runs explore, draft and the review one stage at a time in the session, then exports the writer layout', async () => {
  const { dir, ideaPath, input } = await setup()
  const explore = await pending(input)
  expect(explore).toMatchObject({ stage: 'explore', workDir: join(dir, 'spec.written.local') })
  expect(explore.tasks.map((t) => t.phase)).toEqual(['explore'])
  const explorePrompt = await readFile(explore.tasks[0]!.prompt, 'utf8')
  expect(explorePrompt).toContain('Explore the repository for this idea')
  expect(explorePrompt).toContain('Let people save items.')
  expect(explorePrompt).toContain('"questions"')
  expect(explorePrompt).toContain('notion-fetch, read-only')
  await writeFile(explore.tasks[0]!.output, JSON.stringify({ facts: ['src/items.ts:4: newest first'], constraints: [], questions: [], uiEvidence: [], gaps: [] }))

  const drafting = await pending(input)
  expect(drafting.stage).toBe('draft')
  const draftPrompt = await readFile(drafting.tasks[0]!.prompt, 'utf8')
  expect(draftPrompt).toContain('src/items.ts:4: newest first')
  expect(draftPrompt).not.toContain('notion-fetch')
  await writeFile(drafting.tasks[0]!.output, '{"spec": 42}')
  const retry = await pending(input)
  expect(retry.tasks[0]).toMatchObject({ phase: 'draft' })
  expect(retry.tasks[0]!.error).toContain('spec')
  await writeFile(retry.tasks[0]!.output, JSON.stringify({ spec: draft, assumptions: [] }))

  const research = await pending(input)
  expect(research.stage).toBe('research')
  const researchPrompt = await readFile(research.tasks[0]!.prompt, 'utf8')
  expect(researchPrompt).toContain('ORIGINAL SPEC (data):\n# Save items')
  expect(researchPrompt).toContain('spec review that the spec writer runs on its draft')
  await writeFile(research.tasks[0]!.output, JSON.stringify(review([{ title: 'Retention unstated', evidence: ['spec: list'], fix: 'State retention' }])))

  const specialists = await pending(input)
  expect(specialists.tasks.map((t) => t.phase)).toEqual(['security', 'architecture', 'data', 'behavior', 'ui', 'acceptance'])
  for (const task of specialists.tasks) expect(await readFile(task.prompt, 'utf8')).toContain('notion-fetch, read-only')
  for (const task of specialists.tasks) await writeFile(task.output, JSON.stringify(review()))

  const synthesis = await pending(input)
  expect(synthesis.stage).toBe('reconciliation')
  await writeFile(synthesis.tasks[0]!.output, JSON.stringify({ edits: [{ id: 'E1', before: 'appears in the list.', after: 'appears in the list until removed.' }], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Retention stated', evidence: ['spec: list'], editIds: ['E1'], duplicateOf: null }] }))

  const done = await runLocal(input)
  expect(done).toMatchObject({ pending: false, status: 'ready', dir: join(dir, 'spec.written'), findings: 1 })
  expect(await readFile(ideaPath, 'utf8')).toBe('Let people save items.')
  expect((await readdir(join(dir, 'spec.written'))).sort()).toEqual(['idea.md', 'run-analysis.md', 'spec.draft.md', 'spec.md', 'trace'])
  expect(await readFile(join(dir, 'spec.written/spec.md'), 'utf8')).toContain('until removed')
  expect(await readFile(join(dir, 'spec.written/run-analysis.md'), 'utf8')).toContain('--local')
  const trace = JSON.parse(await readFile(join(dir, 'spec.written/trace/calls.json'), 'utf8'))
  expect(trace.calls).toHaveLength(10)
  expect(JSON.parse(await readFile(join(dir, 'spec.written/trace/review.json'), 'utf8'))).toMatchObject({ mode: 'local', status: 'ready' })
  await expect(stat(join(dir, 'spec.written.local'))).rejects.toThrow()
})

it('exports an incomplete report with --finish and refuses to resume after the idea changes', async () => {
  const { dir, ideaPath, input } = await setup()
  await runLocal(input)
  await writeFile(ideaPath, 'A different idea.')
  await expect(runLocal(input)).rejects.toThrow('changed since this local run started')
  await writeFile(ideaPath, 'Let people save items.')
  const finished = await runLocal({ ...input, finish: true })
  if (finished.pending) throw new Error('expected a report')
  expect(finished.status).toBe('incomplete')
  expect(finished.spec).toBeNull()
  expect(finished.problems.join('\n')).toContain('no output was produced in the session')
  expect(await readFile(join(dir, 'spec.written/trace/checks.md'), 'utf8')).toContain('incomplete')
})

// The folder the session builds from Notion before the first step, in load-knowledge's shape.
const REQUIRED_MD = '# Agent Instructions\n\nREV-001 Check the spec\n\n---\n\n# Review Verification\n\nREV-002 Verify.\n'
async function seedKnowledge(dir: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
  await writeFile(join(dir, 'INDEX.md'), '# Engineering\n\n- [Testing](testing.md)\n')
  await writeFile(join(dir, 'testing.md'), '# Testing\n\nTST-001 Tests first.\n')
}
async function folderSetup() {
  const { dir, ideaPath } = await setup()
  const agentDir = await mkdtemp(join(tmpdir(), 'spec-writer-agent-'))
  const knowledge = join(dir, 'spec.written.local', 'knowledge')
  return { dir, knowledge, input: { ideaPath, repoPath: dir, uiRequired: false }, deps: { agentDir, env: {} } }
}

describe('engineering guidelines in --local', () => {
  it('refuses to start without the knowledge folder, names the pages from the agent config, and starts nothing', async () => {
    const { dir, knowledge, input, deps } = await folderSetup()
    await writeFile(join(deps.agentDir, '.env.local'), 'KNOWLEDGE_PAGE=https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef\nKNOWLEDGE_REQUIRED=Agent Instructions, Review Verification\n')
    const error = await runLocal(input, deps).then(() => null, (cause: unknown) => cause)
    if (!(error instanceof KnowledgeRequired)) throw new Error(`expected a refusal, got ${String(error)}`)
    expect(error.plan).toMatchObject({ dir: knowledge, root: 'https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef', required: ['Agent Instructions', 'Review Verification'] })
    expect(knowledgeStage(error, deps.agentDir)).toMatchObject({ pending: true, stage: 'knowledge', orchestrator: join(deps.agentDir, 'agent', 'instructions.md'), knowledge: { dir: knowledge } })
    await expect(stat(join(dir, 'spec.written.local', 'state.json'))).rejects.toThrow()
  })

  it('gives every phase REQUIRED.md as its guidelines, points tool phases at the topic pages, and records the rules on export', async () => {
    const { dir, knowledge, input, deps } = await folderSetup()
    await seedKnowledge(knowledge)
    const explore = await runLocal(input, deps)
    if (!explore.pending) throw new Error('expected pending')
    expect(explore.orchestrator).toBe(join(deps.agentDir, 'agent', 'instructions.md'))
    const text = await readFile(explore.tasks[0]!.prompt, 'utf8')
    expect(text).toContain(`REQUIRED GUIDELINES (data):\n${REQUIRED_MD}\n`)
    expect(text).toContain(knowledge)
    expect(text).not.toContain('notion-fetch')
    const finished = await runLocal({ ...input, finish: true }, deps)
    expect(finished.pending).toBe(false)
    const report = JSON.parse(await readFile(join(dir, 'spec.written/trace/review.json'), 'utf8'))
    expect(report.knowledge).toMatchObject({ source: 'folder', path: knowledge })
    expect(report.knowledge.files.map((file: { name: string }) => file.name)).toEqual(['INDEX.md', 'REQUIRED.md', 'testing.md'])
  })

  it('refuses to continue when a guideline page changes mid-run', async () => {
    const { knowledge, input, deps } = await folderSetup()
    await seedKnowledge(knowledge)
    await runLocal(input, deps)
    await writeFile(join(knowledge, 'testing.md'), '# Testing\n\nTST-001 Tests last.\n')
    await expect(runLocal(input, deps)).rejects.toThrow('guidelines')
  })

  it('keeps the --guidelines snapshot a run started with and refuses a different one', async () => {
    const { dir, input } = await setup()
    await runLocal(input)
    const rest = { ideaPath: input.ideaPath, repoPath: input.repoPath, uiRequired: false }
    expect(await runLocal(rest)).toMatchObject({ pending: true, stage: 'explore' })
    const other = join(dir, 'other.md')
    await writeFile(other, 'REV-001 Something else')
    await expect(runLocal({ ...rest, guidelinesPath: other })).rejects.toThrow('--guidelines')
  })
})
