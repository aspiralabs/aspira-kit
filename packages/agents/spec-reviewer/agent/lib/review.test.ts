import { describe, expect, it } from 'vitest'
import { applyEdits, checkContract, checkedRuleIds, findingSchema, ruleIds, synthesisSchema, validateReview, type Finding, type Synthesis } from './review.ts'

const spec = `# Feature
## Intent
Let members save items.
## Acceptance criteria
### Features
- [ ] F1: Members can save a item.
### Tests
- [ ] unit: [F1] saving twice creates one record.
- [ ] integration: [F1] saving persists across reload.
`
const findings: Finding[] = [{ id: 'R1', title: 'Missing retry', severity: 'high', whatThisMeans: 'A double tap would save the item twice.', evidence: ['spec: saving twice'], fix: 'Specify retry safety' }]
const decision = { question: 'Keep saved items forever?', options: ['Forever', '30 days'], recommended: 'Forever', reasoning: 'matches cookbooks', whyYours: 'it is a storage cost' }
const synthesis: Synthesis = {
  edits: [{ id: 'E1', before: 'Members can save a item.', after: 'Members can save a item idempotently.' }],
  dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Retry contract', evidence: ['spec: saving twice'], editIds: ['E1'], duplicateOf: null }],
}

describe('candidate contract', () => {
  it('accepts business-only specs and preserves validation of intent and feature IDs', () => {
    const business = spec.split('### Tests')[0]!
    expect(checkContract(business)).toEqual([])
    for (const bad of [business.replace('Let members save items.', ''), business.replace('### Features', '### Behaviors'), business.replace('### Features', '```\n### Features'), business + '- [ ] F1: Duplicate feature.\n']) {
      expect(checkContract(bad).length).toBeGreaterThan(0)
    }
  })
  it('does not require or validate technical test design at spec-review time', () => {
    expect(checkContract(spec)).toEqual([])
    expect(checkContract(spec.replaceAll('[F1]', '[F9]'))).toEqual([])
  })
})

describe('edits and finding preservation', () => {
  it('applies only exact, unambiguous original-text edits', () => {
    expect(applyEdits(spec, synthesis.edits)).toContain('idempotently')
    expect(() => applyEdits('x x', [{ id: 'E1', before: 'x', after: 'y' }])).toThrow()
    expect(() => applyEdits('abcd', [{ id: 'E1', before: 'abc', after: 'x' }, { id: 'E2', before: 'bc', after: 'y' }])).toThrow()
  })
  it('accepts supported, fully carried findings', () => {
    expect(validateReview(findings, synthesis)).toEqual([])
  })
  it('rejects dropped findings, unknown edits and unsupported rejection', () => {
    expect(validateReview(findings, { ...synthesis, dispositions: [] })).toContain('Missing disposition: R1')
    expect(validateReview(findings, { ...synthesis, edits: [] }).length).toBeGreaterThan(0)
    expect(validateReview(findings, { edits: [], dispositions: [{ ...synthesis.dispositions[0]!, status: 'rejected', evidence: [], editIds: [] }] }).length).toBeGreaterThan(0)
  })
  it('rejects duplicate cycles and duplicate IDs', () => {
    const two = [...findings, { ...findings[0]!, id: 'R2' }]
    const dispositions = two.map((f, i) => ({ findingId: f.id, status: 'duplicate' as const, reason: 'Same', evidence: ['spec'], editIds: [], duplicateOf: i === 0 ? 'R2' : 'R1' }))
    expect(validateReview(two, { edits: [], dispositions }).length).toBeGreaterThan(0)
    expect(validateReview(findings, { ...synthesis, dispositions: [...synthesis.dispositions, ...synthesis.dispositions] }).length).toBeGreaterThan(0)
  })
})

describe('finding and decision schemas', () => {
  it('requires severity and a one-to-three-sentence whatThisMeans with its terms defined', () => {
    const finding = { title: 'T', severity: 'low', whatThisMeans: 'Members see a stale list.', evidence: ['spec: x'], fix: 'y' }
    expect(findingSchema.safeParse(finding).success).toBe(true)
    expect(findingSchema.safeParse({ ...finding, severity: 'blocker' }).success).toBe(false)
    const { whatThisMeans: _w, ...withoutMeaning } = finding
    expect(findingSchema.safeParse(withoutMeaning).success).toBe(false)
    expect(findingSchema.safeParse({ ...finding, whatThisMeans: 'One. Two. Three. Four.' }).success).toBe(false)
    expect(findingSchema.safeParse({ ...finding, whatThisMeans: 'Run `pnpm test` first.' }).success).toBe(false)
    expect(findingSchema.safeParse({ ...finding, whatThisMeans: 'Run `pnpm test` (the unit tests) first.' }).success).toBe(true)
  })
  it('requires an author disposition to carry options, a recommended option among them and whyYours', () => {
    const author = { findingId: 'R1', status: 'author', reason: 'Choose', evidence: [], editIds: [], duplicateOf: null }
    expect(validateReview(findings, { edits: [], dispositions: [author] } as Synthesis)).toContain('Author disposition without a decision (question, options, recommended, reasoning, whyYours): R1')
    expect(validateReview(findings, { edits: [], dispositions: [{ ...author, decision }] } as Synthesis)).toEqual([])
    expect(synthesisSchema.safeParse({ edits: [], dispositions: [{ ...author, decision: { ...decision, options: ['Forever'] } }] }).success).toBe(false)
    expect(synthesisSchema.safeParse({ edits: [], dispositions: [{ ...author, decision: { ...decision, recommended: 'Never' } }] }).success).toBe(false)
    const parsed = synthesisSchema.parse({ edits: [], dispositions: [{ ...author, status: 'rejected', evidence: ['spec: x'] }] })
    expect(parsed.dispositions[0]!.decision).toBeNull()
  })
})

it('tracks defined rules without mistaking citation examples for rules', () => {
  expect(ruleIds('Cite a rule, for example `TS-004`.\n**REV-001 — MUST** read facts\n## TS-070 Controls\n**SEC-012 — MUST** authorize')).toEqual(['REV-001', 'TS-070', 'SEC-012'])
})

it('normalizes compact rule references without dropping coverage', () => {
  expect(checkedRuleIds('REV-002/003/004, TS-070')).toEqual(['REV-002', 'REV-003', 'REV-004', 'TS-070'])
})
