import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAnswers, renderDecisionsFile, renderFindings, renderFindingsSection } from './report.ts'
import type { Finding, Synthesis } from './review.ts'

const finding = (id: string, severity: Finding['severity']): Finding => ({ id, title: `Issue ${id}`, severity, whatThisMeans: `Members would notice ${id}.`, evidence: [`spec: ${id}`], fix: `Fix ${id}` })
const mixed = [finding('R1', 'low'), finding('S1-1', 'critical'), finding('S2-1', 'info'), finding('S2-2', 'low'), finding('S3-1', 'high'), finding('S4-1', 'critical')]

describe('findings', () => {
  it('renders mixed severities in the fixed order, keeps the confirmation order within one, and heads with a count that equals the body', () => {
    const text = renderFindings(mixed, null)
    expect(text).toContain('6 findings: 2 critical · 1 high · 0 medium · 2 low · 1 info')
    const ids = [...text.matchAll(/^## (\S+) — /gm)].map((match) => match[1])
    expect(ids).toEqual(['S1-1', 'S4-1', 'S3-1', 'R1', 'S2-2', 'S2-1'])
    expect(ids).toHaveLength(6)
  })

  it('puts the plain-English line after the title and before the evidence, and keeps the evidence and the correction', () => {
    const text = renderFindings([finding('R1', 'high')], { edits: [], dispositions: [{ findingId: 'R1', status: 'applied', reason: 'Fixed in E1', evidence: ['spec: R1'], editIds: ['E1'], duplicateOf: null }] })
    const title = text.indexOf('## R1 — Issue R1')
    const meaning = text.indexOf('**What this means:** Members would notice R1.')
    const evidence = text.indexOf('- spec: R1')
    expect(title).toBeGreaterThan(-1)
    expect(meaning).toBeGreaterThan(title)
    expect(evidence).toBeGreaterThan(meaning)
    expect(text).toContain('Proposed correction: Fix R1')
    expect(text).toContain('Disposition: applied')
    expect(renderFindings([], null)).toContain('0 findings: 0 critical · 0 high · 0 medium · 0 low · 0 info')
  })

  it('renders the section a non-ready reviewed spec carries, sorted, one line per finding', () => {
    const text = renderFindingsSection(mixed)
    expect(text.split('\n')[0]).toBe('## Review findings (6 findings: 2 critical · 1 high · 0 medium · 2 low · 1 info)')
    expect(text.match(/^- \*\*/gm)).toHaveLength(6)
    expect(text.indexOf('- **critical** · S1-1')).toBeLessThan(text.indexOf('- **info** · S2-1'))
  })
})

describe('decisions', () => {
  const decision = { question: 'Keep saved items forever?', options: ['Expire after 30 days', 'Keep forever'], recommended: 'Keep forever', reasoning: 'cookbooks keep everything', whyYours: 'storage cost is yours' }
  const synthesis: Synthesis = { edits: [], dispositions: [
    { findingId: 'R1', status: 'author', reason: 'Product choice.', evidence: [], editIds: [], duplicateOf: null, decision },
    { findingId: 'R2', status: 'rejected', reason: 'Not in this spec.', evidence: ['spec: R2'], editIds: [], duplicateOf: null },
  ] }

  it('writes a checkbox per option with the recommended one first and the dispositions after', () => {
    const text = renderDecisionsFile('needs-author', [{ ...decision, id: 'R1', decidedBy: 'open', answer: null }], synthesis)
    expect(text).toContain('Status: needs-author')
    expect(text).toContain('1 decision: 1 open · 0 answered')
    expect(text).toContain('## R1 — Keep saved items forever?\n\n- [ ] Keep forever _(recommended: cookbooks keep everything)_\n- [ ] Expire after 30 days\n\nWhy it is yours to decide: storage cost is yours')
    expect(text).toContain('## Dispositions\n\n### R2 — rejected')
    expect(renderDecisionsFile('incomplete', [], null)).toContain('Reconciliation did not finish')
  })

  it('reads the ticked answers from a previous run beside the report, and none when there is no previous run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec-review-report-'))
    expect(await readAnswers(dir)).toEqual([])
    await mkdir(join(dir, 'trace'))
    await writeFile(join(dir, 'trace/decisions.md'), renderDecisionsFile('needs-author', [{ ...decision, id: 'R1', decidedBy: 'open', answer: null }], synthesis).replace('- [ ] Expire after 30 days', '- [x] Expire after 30 days'))
    expect(await readAnswers(dir)).toEqual([{ id: 'R1', question: 'Keep saved items forever?', answer: 'Expire after 30 days' }])
  })
})
