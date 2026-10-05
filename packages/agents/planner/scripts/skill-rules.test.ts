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
  // The planner's own rules (no competing plan, no automatic retries, what has not been executed) moved
  // to agent/instructions.md, the single source of truth; skill.test.ts asserts SKILL.md does not copy them.
  { reason: 'the rules live in the agent; a copy in the skill drifts from it', file: skill, phrase: '`agent/instructions.md` in the planner package is the authority' },
  { reason: 'the knowledge pages come from the agent\'s configuration, not from the session\'s judgement', file: skill, phrase: 'Fetch exactly the pages the stage lists' },
  { reason: 'a task output written by the session itself skips the agent prompt it was meant to answer', file: skill, phrase: 'Do not write a task output yourself' },
  { reason: 'an invalid output gets one resend; a second failure is exported as incomplete, not looped', file: skill, phrase: 'resend that task once, with the error' },
  { reason: 'exit code zero is not approval; the status lives in review.json', file: skill, phrase: 'eve process success alone is not plan approval' },
  { reason: 'a failed rerun must not be papered over with the previous report', file: skill, phrase: 'do not present a previous report as current' },
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
