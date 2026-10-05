// Rules that earned their place in the skill, each pinned by the sentence that
// carries it. A rewrite that drops the sentence reads as a harmless tidy-up;
// this test makes it a failure with the reason attached. Rewording is fine:
// update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skill = 'skill/aspira-spec-writer/SKILL.md'

const rules = [
  { reason: 'the skill routes to the pipeline; a spec written in the conversation skips exploration and review', file: skill, phrase: 'Do not write the spec yourself' },
  { reason: 'the idea is source data; embellishing it hides choices the review should surface', file: skill, phrase: 'Never rewrite or embellish the idea' },
  { reason: 'a truncated guideline page passes a review it should fail', file: skill, phrase: 'a partial rule set would pass a review it should fail' },
  { reason: 'local mode is only faithful if each phase gets the exact agent prompt', file: skill, phrase: "each phase must get exactly what the agent's phase gets" },
  { reason: 'local mode runs on one vendor and one session; it must be labelled as not independent', file: skill, phrase: 'its review is not independent of the writer' },
  { reason: 'every run is paid; a silent retry doubles the bill', file: skill, phrase: 'Do not automatically retry a failed or incomplete run' },
  { reason: 'exit code zero is not approval; the status lives in review.json', file: skill, phrase: '`incomplete` or `needs-author` is not a spec to plan from' },
  { reason: 'a failed rerun must not be papered over with the previous report', file: skill, phrase: 'do not present an earlier report as the new result' },
  { reason: 'the idea file is never edited in place', file: skill, phrase: 'The idea file is never modified' },
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
