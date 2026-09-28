// Rules that earned their place in the skill, each pinned by the sentence that
// carries it. A rewrite that drops the sentence reads as a harmless tidy-up;
// this test makes it a failure with the reason attached. Rewording is fine:
// update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skill = 'skill/aspira-spec-reviewer/SKILL.md'

const rules = [
  { reason: 'the debate workflow was removed in the three-phase rewrite; a stale prompt must not resurrect it', file: skill, phrase: 'Never switch to the removed debate workflow' },
  { reason: 'the skill routes to the pipeline; a manual review is a second, unrecorded opinion', file: skill, phrase: 'do not perform a second review yourself' },
  { reason: 'a truncated guideline page passes a review it should fail', file: skill, phrase: 'a partial rule set would pass a review it should fail' },
  { reason: 'local mode is only faithful if each phase gets the exact agent prompt', file: skill, phrase: "the value is that each phase gets exactly what the agent's phase gets" },
  { reason: 'local mode runs on one vendor and one session; it must be labelled as not independent', file: skill, phrase: 'so it is not an independent review' },
  { reason: 'every run is paid; a silent retry doubles the bill', file: skill, phrase: 'Do not automatically retry failed or incomplete reviews' },
  { reason: 'exit code zero is not approval; the status lives in review.json', file: skill, phrase: '`incomplete` or `needs-author` is not approval' },
  { reason: 'a failed rerun must not be papered over with the previous report', file: skill, phrase: 'do not present an earlier report as the new result' },
  { reason: 'the source spec is never edited in place', file: skill, phrase: 'The source spec remains unchanged' },
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
