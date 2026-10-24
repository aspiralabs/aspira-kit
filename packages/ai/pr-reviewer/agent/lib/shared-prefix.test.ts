import { readFile, rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { prContextFrom } from './review-context.ts'
import { sharedPrefix } from './review.ts'
import { contextFileFor, forgetSession, pointerFor, readContext, rememberSession, sharedPrefixForSession, writeContext } from './shared-prefix.ts'
import type { ReviewContextFile } from './target.ts'

const personas = { ava: '# Ava', cole: '# Cole', nova: '# Nova', reba: '# Reba', dex: '# Dex', iris: '# Iris', quinn: '# Quinn' }
const context: ReviewContextFile = {
  pr: { label: 'o/n#1', repoPath: '/workspace/repo', knowledgePath: '/workspace/knowledge', knowledgeRequiredFile: '/workspace/knowledge/REQUIRED.md' },
  packet: '# Review packet: o/n#1\n\npacket\n',
  target: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), since: null },
  stats: { chars: 30, tokens: 8, files: 1, areas: { lib: 1 } },
  changedLines: 12,
  personas,
  costSamples: [],
}

describe('the review context and the seats\' system prompt', () => {
  it('a seat session finds its root\'s context through the pointer its hook left, and gets the shared prefix, byte for byte', async () => {
    const root = `root-${process.pid}-${Date.now()}`
    const seat = `seat-${process.pid}-${Date.now()}`
    const path = await writeContext(root, context)
    expect(path).toBe(contextFileFor(root))
    expect(await readContext(path)).toEqual(context)
    expect(await sharedPrefixForSession(seat)).toBeNull()
    await rememberSession(seat, root)
    expect(await readFile(pointerFor(seat), 'utf8')).toBe(root)
    const env = { MAX_SEAT_CALLS: '5' }
    expect(await sharedPrefixForSession(seat, env)).toBe(sharedPrefix(prContextFrom(context, env)))
    expect(await sharedPrefixForSession(seat, env)).toContain('You have at most 5 tool calls this round')
    await forgetSession(seat)
    expect(await sharedPrefixForSession(seat)).toBeNull()
    await rm(path, { force: true })
  })

  it('says plainly when the pointer names a context that is gone', async () => {
    const seat = `orphan-${process.pid}-${Date.now()}`
    await rememberSession(seat, 'no-such-root')
    await expect(sharedPrefixForSession(seat)).rejects.toThrow('is gone. Run load-pr again')
    await forgetSession(seat)
  })

  it('builds the PrContext the prompts come from, the same on both paths', () => {
    expect(prContextFrom(context, {})).toEqual({
      label: 'o/n#1',
      repoPath: '/workspace/repo',
      knowledgePath: '/workspace/knowledge',
      knowledgeRequiredFile: '/workspace/knowledge/REQUIRED.md',
      packet: context.packet,
      target: context.target,
      maxSeatCalls: 8,
    })
  })
})
