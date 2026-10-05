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
  reviewDocPrompt,
  roundFilesInOrder,
  turnPrompt,
  verifyPrompt,
  workspacePaths,
  writeFindingsPrompt,
  writeReviewPrompt,
  type PrContext,
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
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: true, openPoints: [], note: '' }).success).toBe(true)
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: 'yes', openPoints: [], note: '' }).success).toBe(false)
    expect(OUTPUT_VALIDATORS.turn.safeParse({ agreed: true, openPoints: [], note: '', extra: 1 }).success).toBe(false)
  })
})
