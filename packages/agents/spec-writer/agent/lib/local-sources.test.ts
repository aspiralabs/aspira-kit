import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// --local copies nothing: every prompt file is assembled when the step runs, from the agent's own
// prompt and schema modules (writer.ts, and spec-reviewer's review.ts for the review half).

vi.mock('./repository.ts', () => ({ repository: async () => ({ instructions: '', packet: () => 'source.ts:1: evidence', gaps: [], files: new Map(), commit: 'abc', dirty: false, tools: {} }) }))

afterEach(() => {
  vi.doUnmock('./writer.ts')
  vi.resetModules()
})

async function firstPrompt(): Promise<{ text: string; writerSystemPrompt: string; explorePrompt: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'spec-writer-sources-'))
  const ideaPath = join(dir, 'idea.md')
  const guidelinesPath = join(dir, 'rules.md')
  await writeFile(ideaPath, 'Let people save items.')
  await writeFile(guidelinesPath, 'REV-001 Check the spec')
  const { runLocal } = await import('./local.ts')
  const { writerSystemPrompt, explorePrompt } = await import('./writer.ts')
  const result = await runLocal({ ideaPath, guidelinesPath, repoPath: dir, uiRequired: false })
  if (!result.pending) throw new Error('expected pending')
  return { text: await readFile(result.tasks[0]!.prompt, 'utf8'), writerSystemPrompt, explorePrompt }
}

it('embeds the agent\'s live system prompt and explore prompt, byte for byte', async () => {
  const { text, writerSystemPrompt, explorePrompt } = await firstPrompt()
  expect(text).toContain(`## System\n\n${writerSystemPrompt}\n\n## Task\n\n`)
  expect(text).toContain(`${explorePrompt}\n\n## Output schema`)
})

it('changes when the agent\'s prompt module changes', async () => {
  vi.resetModules()
  vi.doMock('./writer.ts', async (original) => ({ ...(await original<typeof import('./writer.ts')>()), writerSystemPrompt: 'Version two of the writer system prompt.' }))
  const { text } = await firstPrompt()
  expect(text).toContain('## System\n\nVersion two of the writer system prompt.\n\n## Task')
  expect(text).not.toContain('You write feature specs from ideas')
})
