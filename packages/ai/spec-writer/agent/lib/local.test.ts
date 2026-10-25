import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))
import { KnowledgeBlocked } from './local-knowledge.ts'
import { runLocal } from './local.ts'
import { writeSnapshot } from './snapshot.test-helper.ts'

const draft = '# Save items\n## Intent\nLet people save items.\n## Acceptance criteria\n### Features\n- [ ] F1: A saved item appears in the list.\n'
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Save items' }], uiEvidence: [], gaps: [] })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'spec-writer-local-'))
  const ideaPath = join(dir, 'idea.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(ideaPath, 'Let people save items.')
  await writeSnapshot(guidelinesPath)
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
  expect(explore).toMatchObject({ stage: 'explore', workDir: join(dir, 'spec.reviewed.local') })
  expect(explore.tasks.map((t) => [t.phase, t.model])).toEqual([['explore', 'haiku']])
  const explorePrompt = await readFile(explore.tasks[0]!.prompt, 'utf8')
  expect(explorePrompt).toContain('Explore the repository for this idea')
  expect(explorePrompt).toContain('Let people save items.')
  expect(explorePrompt).toContain('"questions"')
  expect(explorePrompt).toContain('a load-knowledge snapshot. The topic pages they route to are the files beside it')
  await writeFile(explore.tasks[0]!.output, JSON.stringify({ facts: ['src/items.ts:4: newest first'], constraints: [], questions: [], uiEvidence: [], gaps: [] }))

  const drafting = await pending(input)
  expect(drafting.stage).toBe('draft')
  const draftPrompt = await readFile(drafting.tasks[0]!.prompt, 'utf8')
  expect(draftPrompt).toContain('src/items.ts:4: newest first')
  expect(draftPrompt).toContain('notion-fetch') // KIT-53: the draft may read Notion when the exploration lacks a fact
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
  await writeFile(research.tasks[0]!.output, JSON.stringify(review([{ title: 'Retention unstated', severity: 'low', whatThisMeans: 'Nobody knows when a saved item disappears.', evidence: ['spec: list'], fix: 'State retention' }])))

  const specialists = await pending(input)
  expect(specialists.tasks.map((t) => t.phase)).toEqual(['security', 'architecture', 'data', 'behavior', 'ui', 'acceptance'])
  for (const task of specialists.tasks) expect(await readFile(task.prompt, 'utf8')).toContain('a load-knowledge snapshot. The topic pages they route to are the files beside it')
  for (const task of specialists.tasks) await writeFile(task.output, JSON.stringify(review()))

  const synthesis = await pending(input)
  expect(synthesis.stage).toBe('reconciliation')
  const edits = [{ id: 'E1', before: 'appears in the list.', after: 'appears in the list until removed.' }, { id: 'E2', before: 'Let people save items.', after: 'Let signed-in people save items.' }]
  // An orphan edit is sent back once as its own task, beside the refused output (SCOOP-7).
  await writeFile(synthesis.tasks[0]!.output, JSON.stringify({ edits, dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Retention stated', evidence: ['spec: list'], editIds: ['E1'], duplicateOf: null }] }))
  const sentBack = await pending(input)
  expect(sentBack.tasks).toMatchObject([{ phase: 'synthesis', model: 'opus' }])
  expect(sentBack.tasks[0]!.output).toBe(join(dir, 'spec.reviewed.local/outputs/synthesis.sent-back.json'))
  expect(await readFile(sentBack.tasks[0]!.prompt, 'utf8')).toContain('- Unjustified edit: E2')
  await writeFile(sentBack.tasks[0]!.output, JSON.stringify({ edits: edits.slice(0, 1), dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Retention stated', evidence: ['spec: list'], editIds: ['E1'], duplicateOf: null }] }))

  const done = await runLocal(input)
  expect(done).toMatchObject({ pending: false, status: 'ready', dir: join(dir, 'spec.reviewed'), findings: 1 })
  expect(await readFile(ideaPath, 'utf8')).toBe('Let people save items.')
  expect((await readdir(join(dir, 'spec.reviewed'))).sort()).toEqual(['idea.md', 'run-analysis.md', 'spec.draft.md', 'spec.reviewed.md', 'trace'])
  expect(await readFile(join(dir, 'spec.reviewed/spec.reviewed.md'), 'utf8')).toContain('until removed')
  expect(await readFile(join(dir, 'spec.reviewed/run-analysis.md'), 'utf8')).toContain('--local')
  const trace = JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/calls.json'), 'utf8'))
  expect(trace.calls).toHaveLength(11)
  expect(JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/review.json'), 'utf8'))).toMatchObject({ mode: 'local', status: 'ready' })
  await expect(stat(join(dir, 'spec.reviewed.local'))).rejects.toThrow()
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
  expect(await readFile(join(dir, 'spec.reviewed/trace/checks.md'), 'utf8')).toContain('incomplete')
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
  const knowledge = join(dir, 'spec.reviewed.local', 'knowledge')
  return { dir, knowledge, input: { ideaPath, repoPath: dir, uiRequired: false }, deps: { agentDir, env: {} } }
}

describe('engineering guidelines in --local', () => {
  it('ends blocked without the knowledge folder or a NOTION_TOKEN to load it, names the token and the project env files, and starts nothing', async () => {
    const { dir, knowledge, input, deps } = await folderSetup()
    await writeFile(join(deps.agentDir, '.env.local'), 'KNOWLEDGE_PAGE=https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef\nKNOWLEDGE_REQUIRED=Agent Instructions, Review Verification\nNOTION_TOKEN=agent-own-token\n')
    const error = await runLocal(input, deps).then(() => null, (cause: unknown) => cause)
    // The agent package's own .env.local is never read for the token (F52): this run has none.
    if (!(error instanceof KnowledgeBlocked)) throw new Error(`expected a blocked run, got ${String(error)}`)
    expect(error).toMatchObject({ pending: false, status: 'blocked', stage: 'knowledge' })
    expect(error.message).toContain('NOTION_TOKEN')
    expect(error.message).toContain(join(dir, '.env.local'))
    expect(error.message).not.toMatch(/Notion MCP|notion-fetch/i)
    await expect(stat(knowledge)).rejects.toThrow()
    await expect(stat(join(dir, 'spec.reviewed.local', 'state.json'))).rejects.toThrow()
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
    expect(text).not.toMatch(/notion-fetch[^.]*guideline|guideline[^.]*notion-fetch/i)
    const finished = await runLocal({ ...input, finish: true }, deps)
    expect(finished.pending).toBe(false)
    const report = JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/review.json'), 'utf8'))
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
