import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildPacket } from './packet.ts'
import {
  FILES,
  OUTPUT_SCHEMAS,
  OUTPUT_VALIDATORS,
  REPO_PATH,
  SEATS,
  checkFindingsPrompt,
  openingPrompt,
  rehome,
  reviewAgreed,
  reviewDocPrompt,
  roundFilesInOrder,
  roundSettled,
  sharedPrefix,
  PROMPT_SEPARATOR,
  fullPrompt,
  turnMessage,
  turnPrompt,
  verifyPrompt,
  workspacePaths,
  writeFindingsPrompt,
  writeReviewPrompt,
  type PrContext,
  type TurnOutput,
  type VerifyOutput,
} from './review.ts'

const root = '/tmp/work dir.local'
const sandbox: PrContext = { label: 'o/n#1', repoPath: REPO_PATH }
const mapped: PrContext = { ...sandbox, repoPath: `${root}/repo`, paths: workspacePaths(root) }

// Every prompt the workflow sends, for one context.
const prompts = (pr: PrContext) => [
  sharedPrefix(pr),
  ...SEATS.flatMap((seat) => [openingPrompt(seat, pr), turnPrompt(seat, 2, pr)]),
  verifyPrompt(3, pr),
  writeFindingsPrompt(pr, true),
  writeFindingsPrompt(pr, false),
  writeReviewPrompt(pr, false),
  checkFindingsPrompt(pr),
  reviewDocPrompt('nova', (pr.paths ?? { files: FILES }).files.review, pr),
]

describe('workspace paths', () => {
  it('rehomes every sandbox file and the rounds directory under the root', () => {
    const paths = workspacePaths(root)
    expect(paths.files).toEqual({
      meta: `${root}/pr.md`,
      patch: `${root}/pr.patch`,
      changed: `${root}/changed_files.txt`,
      conversation: `${root}/conversation.md`,
      findings: `${root}/findings.md`,
      review: `${root}/review.md`,
      previousFindings: `${root}/previous-findings.md`,
    })
    expect(paths.roundsDir).toBe(`${root}/review`)
    expect(roundFilesInOrder(1, paths.roundsDir)[0]).toBe(`${root}/review/round-1/ava.md`)
  })

  it('changes nothing but the paths: a mapped prompt is the sandbox prompt with /workspace swapped for the root', () => {
    const before = prompts(sandbox)
    const after = prompts(mapped)
    for (const [i, prompt] of before.entries()) {
      expect(prompt).toContain('/workspace/')
      expect(after[i]).not.toContain('/workspace/')
      expect(after[i]).toBe(prompt.replaceAll('/workspace', root))
    }
  })

  it('maps the knowledge section the same way: load-knowledge\'s folder rehomed under the root', () => {
    const withKnowledge: PrContext = { ...sandbox, knowledgePath: '/workspace/knowledge', knowledgeRequiredFile: '/workspace/knowledge/REQUIRED.md' }
    const local: PrContext = { ...mapped, knowledgePath: rehome('/workspace/knowledge', root), knowledgeRequiredFile: rehome('/workspace/knowledge/REQUIRED.md', root) }
    const before = prompts(withKnowledge)
    const after = prompts(local)
    for (const [i, prompt] of before.entries()) expect(after[i]).toBe(prompt.replaceAll('/workspace', root))
    // The knowledge section is in the shared prefix, which every seat's prompt starts with.
    expect(sharedPrefix(local)).toContain(`Your first command is \`cat ${root}/knowledge/REQUIRED.md\``)
    expect(sharedPrefix(local)).toContain(`indexed in ${root}/knowledge/INDEX.md`)
  })

  it('keeps the sandbox layout when no paths are given', () => {
    expect(openingPrompt('ava', sandbox)).toContain('Write /workspace/review/round-1/ava.md.')
    expect(roundFilesInOrder(1)).toContain('/workspace/review/round-1/quinn.md')
  })
})

describe('output validators', () => {
  // The validators must accept exactly what the agent's JSON schemas accept.
  const strip = (schema: unknown): unknown => {
    if (Array.isArray(schema)) return schema.map(strip)
    if (schema === null || typeof schema !== 'object') return schema
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => key !== 'description' && key !== '$schema')
        .map(([key, value]) => [key, strip(value)]),
    )
  }
  for (const kind of ['turn', 'verify', 'doc', 'findings'] as const) {
    it(`${kind} mirrors its JSON schema`, () => {
      expect(strip(z.toJSONSchema(OUTPUT_VALIDATORS[kind]))).toEqual(strip(OUTPUT_SCHEMAS[kind]))
    })
  }
  it('rejects extra keys and wrong types', () => {
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: true, raised: [], disputed: [], openPoints: [], note: '' }).success).toBe(true)
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: 'yes', raised: [], disputed: [], openPoints: [], note: '' }).success).toBe(false)
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: true, openPoints: [], note: '' }).success).toBe(false)
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: true, raised: [], disputed: [], openPoints: [], note: '', extra: 1 }).success).toBe(false)
  })
})

describe('the stopping rule', () => {
  const seat = (over: Partial<TurnOutput> = {}): TurnOutput => ({ agreed: true, raised: [], disputed: [], openPoints: [], note: '', ...over })
  const quinn = (agreed: boolean): VerifyOutput => ({ agreed, openPoints: [], rejected: [], duplicates: [], note: '' })

  it('a seat with every finding ruled on is agreed even when nothing was fixed', () => {
    // Fixing is not part of the loop: the schema says agreed means ruled on, not fixed.
    expect(OUTPUT_SCHEMAS.turn.properties.agreed.description).toContain('Whether the author has fixed anything does not matter')
    const ruledOn = SEATS.map(() => seat({ agreed: true, openPoints: [] }))
    expect(roundSettled(ruledOn)).toBe(true)
    expect(reviewAgreed(ruledOn, quinn(true), true)).toBe(true)
  })

  it('a round with no dispute and no new finding ends the review', () => {
    expect(roundSettled(SEATS.map(() => seat()))).toBe(true)
    // Even when a seat still says open: nothing was raised or disputed, so there is nothing left to argue.
    const holdingOut = SEATS.map((s) => seat({ agreed: s !== 'ava', openPoints: s === 'ava' ? ['AVA1.1 waiting for the fix'] : [] }))
    expect(roundSettled(holdingOut)).toBe(true)
    expect(reviewAgreed(holdingOut, quinn(false), roundSettled(holdingOut))).toBe(true)
  })

  it('a dispute or a new finding runs one more round', () => {
    expect(roundSettled(SEATS.map((s) => seat({ disputed: s === 'reba' ? ['REBA1.2'] : [] })))).toBe(false)
    expect(roundSettled(SEATS.map((s) => seat({ raised: s === 'cole' ? ['COLE2.1'] : [], agreed: s !== 'cole' })))).toBe(false)
    const contested = SEATS.map((s) => seat({ disputed: s === 'reba' ? ['REBA1.2'] : [], agreed: s !== 'reba' }))
    expect(reviewAgreed(contested, quinn(false), roundSettled(contested))).toBe(false)
  })

  it('asks every seat, the fix list and the summary for the plain-English line before the evidence, and the fix list in severity order', () => {
    const prefix = sharedPrefix(sandbox)
    expect(prefix).toContain('Every finding opens with **What this means:**')
    const opening = openingPrompt('ava', sandbox)
    expect(opening.indexOf('`**What this means:**` (the plain-English line')).toBeLessThan(opening.indexOf('the evidence quoted from the diff, and the fix'))
    const findings = writeFindingsPrompt(sandbox, true)
    expect(findings).toContain('in this order: a `**What this means:**` line')
    expect(findings.indexOf('`**What this means:**` line')).toBeLessThan(findings.indexOf('the evidence quoted from the diff, the fix'))
    expect(findings).toContain('`## Critical` / `## High` / `## Medium` / `## Low` / `## Info`')
    expect(findings).toContain('the totals line counts exactly the entries below it')
    const review = writeReviewPrompt(sandbox, true)
    expect(review).toContain('the critical findings, then the high ones')
    expect(review).toContain('the plain-English line first')
    expect(review).toContain('medium, then low, then info, same shape, every one of them')
    expect(checkFindingsPrompt(sandbox)).toContain('every entry opens with its `**What this means:**` line')
  })

  it('every prompt tells the seats the rule, the batching and the cap', () => {
    expect(openingPrompt('ava', sandbox)).toContain('The review ends after a round in which no seat raised or disputed anything')
    // With a packet (the index), the reading rules say how to fetch by lens; without one they say to read the patch.
    const prefix = sharedPrefix({ ...sandbox, packet: '# Review packet: o/n#1\n' })
    expect(sharedPrefix(sandbox)).toContain('Read /workspace/pr.patch and the changed files first.')
    expect(prefix).toContain('fetch the hunks of exactly those files with one `read_diff(paths)` call')
    expect(prefix).toContain('with one `read_files(paths)` call')
    expect(prefix).toContain('Do not fetch what you will not review')
    expect(prefix).toContain('You have at most 8 tool calls this round')
    expect(sharedPrefix({ ...sandbox, maxSeatCalls: 3 })).toContain('You have at most 3 tool calls this round')
    expect(turnPrompt('ava', 2, sandbox)).toContain('accept it, or dispute it with evidence')
  })
})

// ---------------------------------------------------------------------------------------------
// One cached prefix: every seat and Quinn start with the same bytes, on the eve prompt builder.

/** The longest common prefix of all the strings, in bytes (UTF-8), as the provider's cache sees it. */
export function commonPrefixBytes(texts: string[]): number {
  if (texts.length === 0) return 0
  const first = texts[0]!
  let end = first.length
  for (const text of texts.slice(1)) {
    let i = 0
    while (i < end && i < text.length && first[i] === text[i]) i += 1
    end = i
  }
  return Buffer.byteLength(first.slice(0, end), 'utf8')
}

const personas = Object.fromEntries([...SEATS, 'quinn'].map((who) => [who, readFileSync(join(import.meta.dirname, '..', 'subagents', who, 'persona.md'), 'utf8')])) as Record<string, string>

describe('one cached prefix, eve prompt builder', () => {
  // A real index packet, from a patch with hunks: the prefix must carry the index and none of the hunks.
  const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@ export function a() {', '-  return 1', '+  return 2', '+export const added = true', ''].join('\n')
  const packet = buildPacket({ label: 'o/n#1', description: '# A change\n', patch, changed: ['a.ts'], required: `# Required\n\n${'rule. '.repeat(8_000)}` })
  const pr: PrContext = { ...sandbox, packet: packet.text, knowledgePath: '/workspace/knowledge', knowledgeRequiredFile: '/workspace/knowledge/REQUIRED.md' }
  const roundOne = [...SEATS.map((seat) => fullPrompt(pr, personas[seat]!, openingPrompt(seat, pr))), fullPrompt(pr, personas.quinn!, verifyPrompt(1, pr))]

  it('the round-one prompts of all six seats and Quinn share the full packet plus the shared instructions as their longest common prefix', () => {
    const prefix = sharedPrefix(pr)
    expect(prefix.startsWith(pr.packet!)).toBe(true)
    expect(prefix).toContain('# Review instructions, every seat')
    // The index, not the diff: no hunk header and no +/- code line anywhere in the prefix.
    expect(prefix).toContain('- `a.ts` +2/-1 · lib · a, added')
    expect(prefix).not.toMatch(/^@@/m)
    expect(prefix).not.toMatch(/^[+-](?![ -]|$)/m)
    expect(prefix).not.toContain('return 2')
    const shared = Buffer.byteLength(prefix, 'utf8')
    expect(commonPrefixBytes(roundOne)).toBeGreaterThanOrEqual(shared)
    // And nothing more than the separator and whatever the personas happen to share at their start: the personas differ.
    expect(commonPrefixBytes(roundOne)).toBeLessThan(shared + Buffer.byteLength(PROMPT_SEPARATOR, 'utf8') + 64)
    // The persona comes after the prefix, the turn after the persona.
    for (const [i, seat] of SEATS.entries()) {
      const text = roundOne[i]!
      expect(text.indexOf(personas[seat]!.trim())).toBe(prefix.length + PROMPT_SEPARATOR.length)
      expect(text.indexOf(`You are ${seat[0]!.toUpperCase()}${seat.slice(1)}, the`)).toBeGreaterThan(text.indexOf(personas[seat]!.trim()))
    }
  })

  it('the eve message carries only the persona and the turn; the prefix is the system prompt, byte-identical for every seat', () => {
    for (const seat of SEATS) {
      const message = turnMessage(personas[seat]!, openingPrompt(seat, pr))
      expect(message).not.toContain('# Review packet')
      expect(message.startsWith(personas[seat]!.trim())).toBe(true)
      expect(`${sharedPrefix(pr)}${PROMPT_SEPARATOR}${message}`).toBe(fullPrompt(pr, personas[seat]!, openingPrompt(seat, pr)))
    }
  })

  it("eve's system cache breakpoint sits at the end of the shared prefix: the prefix is the whole system prompt, so the marker lands on it", async () => {
    // eve's own placement, imported from its harness: on the Anthropic-direct path the marker goes on
    // the last system message; through the Gateway, caching: auto places the provider's breakpoint at
    // the same boundary. Either way the boundary is the end of our one system message.
    const cache = (await import(pathToFileURL(join(import.meta.dirname, '..', '..', 'node_modules', 'eve', 'dist', 'src', 'harness', 'prompt-cache.js')).href)) as {
      applySystemCacheBreakpoint: (instructions: { role: 'system'; content: string }[], marker: unknown) => { role: 'system'; content: string; providerOptions?: Record<string, unknown> }[]
      getAnthropicCacheMarker: () => Record<string, unknown>
      detectPromptCachePath: (model: string) => { kind: string }
      mergeGatewayAutoCaching: (base: Record<string, unknown> | undefined) => Record<string, unknown>
    }
    const system = [{ role: 'system' as const, content: sharedPrefix(pr) }]
    const marked = cache.applySystemCacheBreakpoint(system, cache.getAnthropicCacheMarker())
    expect(marked).toHaveLength(1)
    expect(marked[0]!.content).toBe(sharedPrefix(pr))
    expect(marked[0]!.providerOptions).toMatchObject({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    // The seats are Gateway model ids, so eve takes the gateway-auto path: caching: auto, one model id for all six.
    expect(cache.detectPromptCachePath('anthropic/claude-opus-5.5')).toEqual({ kind: 'gateway-auto' })
    expect(cache.mergeGatewayAutoCaching(undefined)).toEqual({ gateway: { caching: 'auto' } })
  })
})
