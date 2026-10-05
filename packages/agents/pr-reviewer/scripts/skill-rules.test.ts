// Rules that earned their place in the orchestrator instructions, each pinned
// by the sentence that carries it. A rewrite that drops the sentence reads as
// a harmless tidy-up; this test makes it a failure with the reason attached.
// Rewording is fine: update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const instructions = 'agent/instructions.md'

const rules = [
  { reason: 'the orchestrator reports; a seventh opinion from the router is unverified and unrecorded', file: instructions, phrase: 'Never review the diff yourself, never add a finding, never soften one' },
  { reason: 'the verdict is a function of the counts, so it cannot be argued down', file: instructions, phrase: 'The verdict is computed from the counts, not chosen' },
  { reason: 'a review costs seven model calls a round; a silent rerun doubles it', file: instructions, phrase: 'Do not run `pr-debator` twice on the same PR unless the person asks for it' },
  { reason: 'reviewing a guessed branch reviews the wrong code', file: instructions, phrase: 'Never review something you could not load' },
  { reason: 'the branch reviewed must be named when it was defaulted, or the human assumes theirs', file: instructions, phrase: 'say in your reply which branch was reviewed' },
  { reason: 'the review files belong to the seats; the router writing them breaks the verifier chain', file: instructions, phrase: 'Never write to `/workspace/findings.md` or `/workspace/review.md` yourself' },
  { reason: 'the review comment goes only to the PR that was reviewed; posting elsewhere publishes findings to the wrong audience', file: instructions, phrase: 'Post the review only to the PR that was loaded' },
  { reason: 'a review the person asked to keep private must not be posted', file: instructions, phrase: 'Skip it only when the person asked you not to comment' },
  { reason: 'a missing guidelines load is reported, never silently skipped', file: instructions, phrase: 'saying the guidelines were not loaded and why' },
]

it('pins each rule with a distinctive phrase', () => {
  const phrases = rules.map((r) => r.phrase)
  expect(new Set(phrases).size).toBe(phrases.length)
  for (const phrase of phrases) expect(phrase.length).toBeGreaterThanOrEqual(20)
})

for (const { reason, file, phrase } of rules) {
  it(`${file} keeps: ${reason}`, () => {
    expect(readFileSync(join(root, file), 'utf8')).toContain(phrase)
  })
}
