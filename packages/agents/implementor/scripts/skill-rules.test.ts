// Pins each rule in the agent's own instruction files (see pinned-rules.ts for the reasons).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SETTLED_DECISIONS_RULE } from '@aspiralabs/agent-common/lib/decisions'
import { PINNED_RULES, PINNED_SKILL_RULES } from './pinned-rules.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

it('pins each rule with a distinctive phrase', () => {
  const phrases = PINNED_RULES.map((r) => r.phrase)
  expect(new Set(phrases).size).toBe(phrases.length)
  for (const phrase of phrases) expect(phrase.length).toBeGreaterThanOrEqual(20)
})

for (const { reason, file, phrase } of [...PINNED_RULES, ...PINNED_SKILL_RULES]) {
  it(`${file} keeps: ${reason}`, () => {
    expect(readFileSync(join(root, file), 'utf8')).toContain(phrase)
  })
}

// A spec's `## Decisions` were made by the author before the build (the groomer writes them): an
// assumption never reopens one. The sentence sits beside the assumptions rule, which stays.
it('agent/instructions.md says ## Decisions items are settled by the author and keeps the assumptions rule', () => {
  const text = readFileSync(join(root, 'agent/instructions.md'), 'utf8')
  expect([text.includes(SETTLED_DECISIONS_RULE), text.includes('Present every assumption as a decision with its recommended answer already taken')]).toEqual([true, true])
})
