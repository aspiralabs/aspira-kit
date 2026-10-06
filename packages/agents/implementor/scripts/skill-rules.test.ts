// Pins each rule in the agent's own instruction files (see pinned-rules.ts for the reasons).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
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
