import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SCHEMAS } from './local-plan.ts'

const base = {
  status: 'done',
  features: [{ id: 'F1', tasks: ['P3'], tests: ['T1'], passing: true }],
  deviations: [],
  blockers: [],
  assumptions: [],
  dependenciesAdded: [],
  notesRewritten: [],
  slopEntries: [],
  slopJustification: 'None: no bugs were found and fixed',
}

describe('VERIFICATION', () => {
  it('accepts a complete output, with empty arrays when the build added, rewrote and learned nothing', () => {
    expect(SCHEMAS.VERIFICATION.safeParse(base).success).toBe(true)
    const full = {
      ...base,
      dependenciesAdded: [{ name: 'expo-camera', version: '16.0.0', app: 'apps/mobile', scope: 'runtime', native: true, approval: 'Adopt' }],
      notesRewritten: [{ file: 'handoff-notes.md', action: 'rewritten' }, { file: 'lane-notes.md', action: 'deleted' }],
      slopEntries: [{ rule: 'Check the cursor binding before replaying a page.', area: 'Testing Standards', whatWentWrong: 'The cursor test replayed a page under another viewer. It passed because the fixture shared one viewer.', source: 'implementor, aspiralabs/nomnomzz, NOM-4' }],
      slopJustification: '',
    }
    expect(SCHEMAS.VERIFICATION.safeParse(full).success).toBe(true)
  })

  it('rejects an output missing any of the three fields', () => {
    for (const field of ['dependenciesAdded', 'notesRewritten', 'slopEntries'] as const) {
      const { [field]: _dropped, ...without } = base
      const result = SCHEMAS.VERIFICATION.safeParse(without)
      expect(result.success, field).toBe(false)
      if (!result.success) expect(z.prettifyError(result.error)).toContain(field)
    }
  })

  it('rejects empty slopEntries without a justification, and a bad action or scope', () => {
    const empty = SCHEMAS.VERIFICATION.safeParse({ ...base, slopJustification: '' })
    expect(empty.success).toBe(false)
    if (!empty.success) expect(z.prettifyError(empty.error)).toContain('slopJustification')
    expect(SCHEMAS.VERIFICATION.safeParse({ ...base, slopJustification: '   ' }).success).toBe(false)
    expect(SCHEMAS.VERIFICATION.safeParse({ ...base, notesRewritten: [{ file: 'x', action: 'kept' }] }).success).toBe(false)
    expect(SCHEMAS.VERIFICATION.safeParse({ ...base, dependenciesAdded: [{ name: 'x', version: '1', app: 'root', scope: 'peer', native: false, approval: 'Adopt' }] }).success).toBe(false)
  })

  it('prints as JSON schema for the prompt, with the three fields required', () => {
    const schema = z.toJSONSchema(SCHEMAS.VERIFICATION, { io: 'input' })
    expect(schema.required).toEqual(expect.arrayContaining(['dependenciesAdded', 'notesRewritten', 'slopEntries']))
  })
})
