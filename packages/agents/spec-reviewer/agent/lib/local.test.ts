import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))
import { KnowledgeRequired } from './local-knowledge.ts'
import { knowledgeStage, runLocal } from './local.ts'

const candidate = '# Feature\n## Intent\nSave items.\n## Acceptance criteria\n### Features\n- [ ] F1: Save an item idempotently.\n'
const review = (findings: unknown[] = []) => ({ facts: [], findings, checks: [{ rule: 'REV-001', evidence: 'spec: Original' }], uiEvidence: [], gaps: [] })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'spec-review-local-'))
  const specPath = join(dir, 'spec.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(specPath, '# Original')
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  return { dir, specPath, guidelinesPath, input: { specPath, guidelinesPath, repoPath: dir, uiRequired: false } }
}

it('runs the pipeline one stage at a time with the session as the model, then exports the agent layout', async () => {
  const { dir, specPath, input } = await setup()
  const research = await runLocal(input)
  expect(research).toMatchObject({ status: 'pending', stage: 'research', workDir: join(dir, 'spec.reviewed.local') })
  if (!research.pending) throw new Error('expected pending')
  expect(research.tasks.map((t) => t.phase)).toEqual(['research'])
  const prompt = await readFile(research.tasks[0]!.prompt, 'utf8')
  expect(prompt).toContain('Research and raise the initial findings')
  expect(prompt).toContain('# Original')
  expect(prompt).toContain('"findings"')
  expect(prompt).not.toContain('notion-fetch')
  await writeFile(research.tasks[0]!.output, JSON.stringify(review([{ title: 'Missing contract', evidence: ['spec: Original'], fix: 'Add intent and acceptance' }])))

  const specialists = await runLocal(input)
  if (!specialists.pending) throw new Error('expected pending')
  expect(specialists.stage).toBe('specialists')
  expect(specialists.tasks.map((t) => t.phase)).toEqual(['security', 'architecture', 'data', 'behavior', 'ui', 'acceptance'])
  expect(await readFile(specialists.tasks[0]!.prompt, 'utf8')).toContain('Missing contract')
  for (const task of specialists.tasks) expect(await readFile(task.prompt, 'utf8')).toContain('notion-fetch, read-only')
  await writeFile(specialists.tasks[0]!.output, '{"facts": "not a list"}')
  for (const task of specialists.tasks.slice(1)) await writeFile(task.output, JSON.stringify(review()))

  const retry = await runLocal(input)
  if (!retry.pending) throw new Error('expected pending')
  expect(retry.tasks).toHaveLength(1)
  expect(retry.tasks[0]).toMatchObject({ phase: 'security' })
  expect(retry.tasks[0]!.error).toContain('facts')
  await writeFile(retry.tasks[0]!.output, JSON.stringify(review()))

  const synthesis = await runLocal(input)
  if (!synthesis.pending) throw new Error('expected pending')
  expect(synthesis.tasks.map((t) => t.phase)).toEqual(['synthesis'])
  expect(await readFile(synthesis.tasks[0]!.prompt, 'utf8')).toContain('Reconcile once')
  await writeFile(synthesis.tasks[0]!.output, JSON.stringify({ edits: [{ id: 'E1', before: '# Original', after: candidate }], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Repair acceptance contract', evidence: ['spec: Original'], editIds: ['E1'], duplicateOf: null }] }))

  const done = await runLocal(input)
  expect(done).toMatchObject({ status: 'ready', dir: join(dir, 'spec.reviewed'), findings: 1 })
  expect(await readFile(specPath, 'utf8')).toBe('# Original')
  expect(await readFile(join(dir, 'spec.reviewed/spec.reviewed.md'), 'utf8')).toBe(candidate)
  expect((await readdir(join(dir, 'spec.reviewed'))).sort()).toEqual(['run-analysis.md', 'spec.original.md', 'spec.reviewed.md', 'trace'])
  expect(await readFile(join(dir, 'spec.reviewed/run-analysis.md'), 'utf8')).toContain('--local')
  const trace = JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/calls.json'), 'utf8'))
  expect(trace.calls).toHaveLength(8)
  expect(JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/review.json'), 'utf8'))).toMatchObject({ mode: 'local', status: 'ready' })
  await expect(stat(join(dir, 'spec.reviewed.local'))).rejects.toThrow()
})

it('exports an incomplete report with --finish and refuses to resume after the spec changes', async () => {
  const { dir, specPath, input } = await setup()
  await runLocal(input)
  await writeFile(specPath, '# Changed')
  await expect(runLocal(input)).rejects.toThrow('changed since this local review started')
  await writeFile(specPath, '# Original')
  const finished = await runLocal({ ...input, finish: true })
  expect(finished.status).toBe('incomplete')
  if (finished.pending) throw new Error('expected a report')
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
  const { dir, specPath } = await setup()
  const agentDir = await mkdtemp(join(tmpdir(), 'spec-review-agent-'))
  const knowledge = join(dir, 'spec.reviewed.local', 'knowledge')
  return { dir, specPath, knowledge, input: { specPath, repoPath: dir, uiRequired: false }, deps: { agentDir, env: {} } }
}

describe('engineering guidelines in --local', () => {
  it('refuses to start without the knowledge folder, names the pages from the agent config, and starts nothing', async () => {
    const { dir, knowledge, input, deps } = await folderSetup()
    await writeFile(join(deps.agentDir, '.env.local'), 'KNOWLEDGE_PAGE=https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef\nKNOWLEDGE_REQUIRED=Agent Instructions, Review Verification\n')
    const error = await runLocal(input, deps).then(() => null, (cause: unknown) => cause)
    if (!(error instanceof KnowledgeRequired)) throw new Error(`expected a refusal, got ${String(error)}`)
    expect(error.plan).toMatchObject({ dir: knowledge, root: 'https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef', required: ['Agent Instructions', 'Review Verification'] })
    const stage = knowledgeStage(error, deps.agentDir)
    expect(stage).toMatchObject({ pending: true, stage: 'knowledge', orchestrator: join(deps.agentDir, 'agent', 'instructions.md'), knowledge: { dir: knowledge } })
    await expect(stat(join(dir, 'spec.reviewed.local', 'state.json'))).rejects.toThrow()
  })

  it('gives every phase REQUIRED.md as its guidelines, points tool phases at the topic pages, and records the rules on export', async () => {
    const { dir, knowledge, input, deps } = await folderSetup()
    await seedKnowledge(knowledge)
    const research = await runLocal(input, deps)
    if (!research.pending) throw new Error('expected pending')
    expect(research.orchestrator).toBe(join(deps.agentDir, 'agent', 'instructions.md'))
    expect(await readFile(research.tasks[0]!.prompt, 'utf8')).toContain(`REQUIRED GUIDELINES (data):\n${REQUIRED_MD}\n`)
    await writeFile(research.tasks[0]!.output, JSON.stringify(review()))
    const specialists = await runLocal(input, deps)
    if (!specialists.pending) throw new Error('expected pending')
    for (const task of specialists.tasks) {
      const text = await readFile(task.prompt, 'utf8')
      expect(text).toContain(knowledge)
      expect(text).not.toContain('notion-fetch')
    }
    for (const task of specialists.tasks) await writeFile(task.output, JSON.stringify(review()))
    const synthesis = await runLocal(input, deps)
    if (!synthesis.pending) throw new Error('expected pending')
    await writeFile(synthesis.tasks[0]!.output, JSON.stringify({ edits: [], dispositions: [] }))
    const done = await runLocal(input, deps)
    expect(done.pending).toBe(false)
    const report = JSON.parse(await readFile(join(dir, 'spec.reviewed/trace/review.json'), 'utf8'))
    expect(report.knowledge).toMatchObject({ source: 'folder', path: knowledge })
    expect(report.knowledge.files.map((file: { name: string }) => file.name)).toEqual(['INDEX.md', 'REQUIRED.md', 'testing.md'])
    expect(await readFile(join(dir, 'spec.reviewed/trace/guidelines.md'), 'utf8')).toBe(REQUIRED_MD)
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
    const rest = { specPath: input.specPath, repoPath: input.repoPath, uiRequired: false }
    const next = await runLocal(rest)
    expect(next).toMatchObject({ pending: true, stage: 'research' })
    const other = join(dir, 'other.md')
    await writeFile(other, 'REV-001 Something else')
    await expect(runLocal({ ...rest, guidelinesPath: other })).rejects.toThrow('--guidelines')
  })
})
