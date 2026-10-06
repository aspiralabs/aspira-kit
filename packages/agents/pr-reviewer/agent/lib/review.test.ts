import { describe, expect, it } from 'vitest'
import { z } from 'zod'
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
    expect(after[0]).toContain(`Your first command is \`cat ${root}/knowledge/REQUIRED.md\``)
    expect(after[0]).toContain(`indexed in ${root}/knowledge/INDEX.md`)
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

  it('every prompt tells the seats the rule, the batching and the cap', () => {
    const prompt = openingPrompt('ava', sandbox)
    expect(prompt).toContain('The review ends after a round in which no seat raised or disputed anything')
    expect(prompt).toContain('one `read_files` call with every path you want, not one call per file')
    expect(prompt).toContain('You have at most 8 tool calls this round')
    expect(openingPrompt('ava', { ...sandbox, maxSeatCalls: 3 })).toContain('You have at most 3 tool calls this round')
    expect(turnPrompt('ava', 2, sandbox)).toContain('accept it, or dispute it with evidence')
  })
})
