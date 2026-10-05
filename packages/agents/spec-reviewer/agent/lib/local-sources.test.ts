import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// --local copies nothing: every prompt file is assembled when the step runs, from the agent's own
// prompt and schema modules (review.ts, pipeline.ts). Swap the module and the prompt file follows.

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))

afterEach(() => {
  vi.doUnmock('./review.ts')
  vi.resetModules()
})

async function firstPrompt(): Promise<{ text: string; systemPrompt: string; task: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'spec-review-sources-'))
  const specPath = join(dir, 'spec.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(specPath, '# Original')
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  const { runLocal } = await import('./local.ts')
  const { systemPrompt } = await import('./review.ts')
  const { runPipeline } = await import('./pipeline.ts')
  const result = await runLocal({ specPath, guidelinesPath, repoPath: dir, uiRequired: false })
  if (!result.pending) throw new Error('expected pending')
  // What the agent sends research, captured from the agent's own pipeline.
  let task = ''
  await runPipeline({ spec: '# Original', guidelines: 'REV-001 Check the spec', context: 'x', uiRequired: false }, async ({ phase, prompt }) => {
    if (phase === 'research') task = prompt
    throw new Error('stop')
  })
  return { text: await readFile(result.tasks[0]!.prompt, 'utf8'), systemPrompt, task }
}

it('embeds the agent\'s live system prompt and task prompt, byte for byte', async () => {
  const { text, systemPrompt, task } = await firstPrompt()
  expect(text).toContain(`## System\n\n${systemPrompt}\n\n## Task\n\n`)
  const instruction = task.slice(task.lastIndexOf('\n\n') + 2)
  expect(instruction.startsWith('Research and raise the initial findings')).toBe(true)
  expect(text).toContain(instruction)
})

it('changes when the agent\'s prompt module changes', async () => {
  vi.resetModules()
  vi.doMock('./review.ts', async (original) => ({ ...(await original<typeof import('./review.ts')>()), systemPrompt: 'Version two of the review system prompt.' }))
  const { text } = await firstPrompt()
  expect(text).toContain('## System\n\nVersion two of the review system prompt.\n\n## Task')
  expect(text).not.toContain('You review specs against evidence.')
})
