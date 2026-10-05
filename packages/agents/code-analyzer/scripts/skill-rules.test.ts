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

const fixer = 'agent/lib/fixer.ts'

const rules = [
  { reason: 'the skill routes to the agent; a session that lints by hand produces an unrecorded, unpaid-for second opinion', file: skill, phrase: 'do not run the linters or fix diagnostics yourself' },
  { reason: 'every start is paid; a silent relaunch doubles the bill', file: skill, phrase: 'Do not relaunch a finished run on your own' },
  { reason: '--local subagents must get the agent\'s prompt, not the session\'s paraphrase of it', file: skill, phrase: 'Do not edit the prompts or fix anything outside the tasks' },
  { reason: 'the skill holds mechanics only; the agent\'s instructions are the authority for the rules', file: skill, phrase: 'agent/instructions.md' },
  { reason: 'clean by suppression or config edit is not clean', file: fixer, phrase: 'fix the code, never the check' },
  { reason: 'the router does not fix code; only the workflow does', file: instructions, phrase: 'Do not analyze or fix code yourself' },
  { reason: 'the source goes through verbatim so the workflow, not the router, decides local versus remote', file: instructions, phrase: 'with `source` set to exactly what they gave' },
  { reason: 'without push nothing leaves the sandbox; a surprise push is a trust break', file: instructions, phrase: 'nothing leaves the sandbox' },
  { reason: 'every run is paid; a silent retry doubles the bill (agent side)', file: instructions, phrase: 'Never retry a finished run on your own' },
  { reason: 'no tests run; the human must know the diff is unverified behaviorally', file: instructions, phrase: 'static analysis passing does not mean behavior is unchanged' },
  { reason: 'partial is never rounded up to clean', file: instructions, phrase: '`partial` means the analyzers still fail or one could not run' },
  { reason: 'no run without the engineering rules: a refusal is reported, not worked around', file: instructions, phrase: 'do not retry without them' },
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

// One source of truth: the agent's rules live in its own files and the skill only points at them.
// A rule copied into SKILL.md drifts the day the agent changes; this keeps it from being copied.
it('SKILL.md carries no agent rules and names agent/instructions.md as the authority', () => {
  const text = readFileSync(join(root, skill), 'utf8')
  expect(text).toContain('agent/instructions.md')
  const agentRules = [
    ...rules.filter((rule) => rule.file !== skill).map((rule) => rule.phrase),
    'It never adds suppressions',
    'Do not add eslint-disable',
    'Preserve behavior',
    'Remind the user',
  ]
  for (const phrase of agentRules) expect(text, phrase).not.toContain(phrase)
})
