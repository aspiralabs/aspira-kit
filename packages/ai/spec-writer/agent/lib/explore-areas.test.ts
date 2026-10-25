// KIT-48: an idea that names two or more repository areas gets one explorer per area, in parallel;
// the explorations merge; a single-area idea keeps the one explorer; the draft, research and
// reconciliation prompts are held to the packet.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { exploreAreas, mergeExplorations, writePipeline, type Exploration } from './writer.ts'

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map([['instances/core/stack/lambda/a.ts', ''], ['instances/core/app/page.tsx', ''], ['tools/aspira/cli.ts', ''], ['scripts/x.sh', '']]), commit: 'abc', dirty: false, tools: {} }) }))
import { runLocal } from './local.ts'
import { writeSnapshot } from './snapshot.test-helper.ts'

const paths = ['instances/core/stack/lambda/a.ts', 'instances/core/app/page.tsx', 'tools/aspira/cli.ts', 'scripts/x.sh', 'README.md']

describe('exploreAreas', () => {
  it('finds the directories (two levels deep) of the paths an idea names, and nothing for an idea naming fewer than two', () => {
    expect(exploreAreas('Fix `instances/core/stack/lambda/a.ts` and the console under instances/core/app/ plus scripts/x.sh.', paths)).toEqual(['instances/core', 'scripts'])
    expect(exploreAreas('Fix tools/aspira/cli.ts and tools/aspira/README.', paths)).toEqual([])
    expect(exploreAreas('Nothing path-like here.', paths)).toEqual([])
  })

  it('merges explorations without duplicates, in area order', () => {
    const a: Exploration = { facts: ['f1', 'shared'], constraints: ['c1'], questions: [{ question: 'q?', options: ['a', 'b'], evidence: [] }], uiEvidence: [], gaps: ['g1'] }
    const b: Exploration = { facts: ['shared', 'f2'], constraints: [], questions: [{ question: 'q?', options: ['a', 'b'], evidence: [] }], uiEvidence: ['ui'], gaps: [] }
    expect(mergeExplorations([a, b])).toEqual({ facts: ['f1', 'shared', 'f2'], constraints: ['c1'], questions: [{ question: 'q?', options: ['a', 'b'], evidence: [] }], uiEvidence: ['ui'], gaps: ['g1'] })
  })
})

describe('the pipeline with areas', () => {
  it('runs one explore phase per area and drafts from the merged exploration', async () => {
    const phases: string[] = []
    const call = async ({ phase, prompt }: { phase: string; prompt: string }) => {
      phases.push(phase)
      if (phase.startsWith('explore:')) return { facts: [`${phase.slice(8)}: fact`], constraints: [], questions: [], uiEvidence: [], gaps: [] }
      if (phase === 'draft') { expect(prompt).toContain('instances/core: fact'); expect(prompt).toContain('scripts: fact'); throw new Error('stop at draft') }
      throw new Error(`unexpected ${phase}`)
    }
    const result = await writePipeline({ idea: 'x', guidelines: 'REV-001', context: '', uiRequired: false, areas: ['instances/core', 'scripts'] }, call)
    expect(phases).toEqual(['explore:instances/core', 'explore:scripts', 'draft'])
    expect(result.exploration?.facts).toEqual(['instances/core: fact', 'scripts: fact'])
    expect(result.status).toBe('incomplete')
  })
})

describe('--local with areas', () => {
  it('prints one explore task per area, each on haiku, in one stage, and holds the draft to the packet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec-writer-areas-'))
    const ideaPath = join(dir, 'idea.md')
    const guidelinesPath = join(dir, 'rules.md')
    await writeFile(ideaPath, 'Change instances/core/stack/lambda/a.ts and tools/aspira/cli.ts together.')
    await writeSnapshot(guidelinesPath)
    const input = { ideaPath, guidelinesPath, repoPath: dir, uiRequired: false }
    const explore = await runLocal(input)
    if (!explore.pending) throw new Error('expected pending')
    expect(explore.stage).toBe('explore')
    expect(explore.tasks.map((task) => [task.phase, task.model])).toEqual([['explore:instances/core', 'haiku'], ['explore:tools/aspira', 'haiku']])
    expect(await readFile(explore.tasks[0]!.prompt, 'utf8')).toContain('YOUR AREA: instances/core')
    for (const task of explore.tasks) await writeFile(task.output, JSON.stringify({ facts: [`${task.phase}: fact`], constraints: [], questions: [], uiEvidence: [], gaps: [] }))
    const draft = await runLocal(input)
    if (!draft.pending) throw new Error('expected pending')
    expect(draft.tasks.map((task) => [task.phase, task.model])).toEqual([['draft', 'opus']])
    const prompt = await readFile(draft.tasks[0]!.prompt, 'utf8')
    expect(prompt).toContain('head start, not a wall')
    expect(prompt).toContain('explore:tools/aspira: fact')
  })
})
