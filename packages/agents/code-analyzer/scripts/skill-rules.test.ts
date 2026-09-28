// Rules that earned their place in the skill and the agent instructions, each
// pinned by the sentence that carries it. A rewrite that drops the sentence
// reads as a harmless tidy-up; this test makes it a failure with the reason
// attached. Rewording is fine: update the phrase and keep the reason.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skill = 'skill/aspira-code-analyzer/SKILL.md'
const instructions = 'agent/instructions.md'

const rules = [
  { reason: 'the skill routes to the agent; a session that lints by hand produces an unrecorded, unpaid-for second opinion', file: skill, phrase: 'do not run the linters or fix diagnostics yourself' },
  { reason: 'clean by suppression or config edit is not clean', file: skill, phrase: 'It never adds suppressions or edits analyzer configuration' },
  { reason: 'every run is paid; a silent retry doubles the bill', file: skill, phrase: 'Do not retry a finished run on your own: each run is paid' },
  { reason: 'no tests run; the human must know the diff is unverified behaviorally', file: skill, phrase: 'passing static analysis does not prove behavior is unchanged' },
  { reason: 'partial is never rounded up to clean', file: skill, phrase: '`partial` is not clean' },
  { reason: 'the router does not fix code; only the workflow does', file: instructions, phrase: 'Do not analyze or fix code yourself' },
  { reason: 'the source goes through verbatim so the workflow, not the router, decides local versus remote', file: instructions, phrase: 'with `source` set to exactly what they gave' },
  { reason: 'without push nothing leaves the sandbox; a surprise push is a trust break', file: instructions, phrase: 'nothing leaves the sandbox' },
  { reason: 'every run is paid; a silent retry doubles the bill (agent side)', file: instructions, phrase: 'Never retry a finished run on your own' },
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
