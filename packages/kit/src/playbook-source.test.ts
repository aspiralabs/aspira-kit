// NOVA1.1: the Playbook's Status table lives in @aspiralabs/agent-common (src/lib/playbook.json),
// and kit reads it from there as plain JSON instead of keeping its own copy, so the agents never
// depend on this CLI and the two can never drift apart.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commandFor, nextStep, PLAYBOOK } from './playbook.js'

const SRC = dirname(fileURLToPath(import.meta.url))
const COMMON_TABLE = join(SRC, '..', '..', 'agents', 'common', 'src', 'lib', 'playbook.json')

describe("kit's Playbook table is agent-common's playbook.json (NOVA1.1)", () => {
  it('PLAYBOOK equals the rows in agent-common', () => {
    const rows = (JSON.parse(readFileSync(COMMON_TABLE, 'utf8')) as { rows: unknown[] }).rows
    expect(PLAYBOOK).toEqual(rows)
  })

  it('playbook.ts keeps no row of its own and imports the table from @aspiralabs/ai/common', () => {
    const source = readFileSync(join(SRC, 'playbook.ts'), 'utf8')
    expect(source).not.toMatch(/statuses: \[/)
    expect(source).toContain("from '@aspiralabs/ai/common/lib/playbook.json'")
  })

  it('nextStep and commandFor read that table', () => {
    expect(commandFor(nextStep('Ready: Spec')!, 'NOM-4')).toBe('/aspira-planner NOM-4')
    expect(nextStep('Not a status')).toBeNull()
  })
})
