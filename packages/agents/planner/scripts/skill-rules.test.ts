// Rules that earned their place in the skill, each pinned by the sentence that
// carries it. A rewrite that drops the sentence reads as a harmless tidy-up;
// this test makes it a failure with the reason attached. Rewording is fine:
// update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skill = 'skill/aspira-planner/SKILL.md'

const rules = [
  { reason: 'the skill routes to the agent; a competing session plan is unreviewed and unrecorded', file: skill, phrase: 'do not implement the feature or generate a competing plan yourself' },
  { reason: 'every run is paid; a silent retry doubles the bill', file: skill, phrase: 'Do not automatically retry incomplete or failed runs' },
  { reason: 'exit code zero is not approval; the status lives in review.json', file: skill, phrase: 'eve process success alone is not plan approval' },
  { reason: 'a failed rerun must not be papered over with the previous report', file: skill, phrase: 'do not present a previous report as current' },
  { reason: 'the plan lists commands; none have run, so nothing is verified yet', file: skill, phrase: 'No planned tests or implementation commands have been executed' },
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
