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
const skill = 'skill/aspira-pr-reviewer/SKILL.md'

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
  { reason: 'the skill routes to the pipeline; a manual review is an unrecorded seventh opinion', file: skill, phrase: 'do not review the PR yourself' },
  { reason: 'local mode is only faithful if each task gets the exact agent prompt', file: skill, phrase: "the value is that each task gets exactly what the agent's seat gets" },
  { reason: 'the six seats of a round are independent lenses; run one after another they cost six times the wall clock', file: skill, phrase: 'Launch all six seat tasks **in one message**' },
  { reason: 'a subagent told anything beyond the file names drifts from the agent prompt', file: skill, phrase: 'Read <prompt> in full and follow it exactly. Write your JSON result to <output>. Reply with one line.' },
  { reason: 'the round loop and its stop rule belong to the driver, not the session', file: skill, phrase: 'until the driver says the rounds are done' },
  { reason: 'local mode runs every seat and the verifier on one model in one session; it must be labelled as not independent', file: skill, phrase: '`--local` is not independent of this session' },
  { reason: 'every seat runs on the session model; the cross-vendor verifier of the default mode is gone', file: skill, phrase: "every seat and Quinn run on this session's model" },
  { reason: 'every run is paid; a silent retry doubles the bill', file: skill, phrase: 'Do not automatically retry failed or incomplete reviews' },
  { reason: 'a schema rejection gets one resend, not a loop', file: skill, phrase: 'send the error back and resend it once' },
  { reason: 'the review comment goes only to the PR that was reviewed', file: skill, phrase: 'never to any other PR' },
  { reason: 'an incomplete review carries no verdict and is not approval', file: skill, phrase: '`incomplete` is not approval' },
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
