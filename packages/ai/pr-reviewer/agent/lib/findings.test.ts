import { describe, expect, it } from 'vitest'
import { countsFromFindings, findingSummaries, missingWhatThisMeans, renderFindingsList, sortFindingsMarkdown } from './findings.ts'

const entry = (id: string, title: string, meaning?: string) => `### [${id}] ${title}\n${meaning === undefined ? '' : `**What this means:** ${meaning}\n`}- **Location:** \`a.ts:1\`\n- **Evidence:** \`x\`\n`

const MIXED = [
  '# Findings: o/r#2',
  '',
  'Reviewed: base `aaaa111` → head `bbbb222`',
  '',
  'Totals: 9 critical · 9 high · 9 medium · 9 low · 9 info',
  '',
  '## Low',
  '',
  entry('DEX1.1', 'Naming', 'The helper is hard to find.'),
  '## Critical',
  '',
  entry('AVA1.1', 'Unchecked input', 'Anyone could run commands on the server.'),
  entry('AVA1.2', 'Secret in log'),
  '## Info',
  '',
  entry('IRIS1.1', 'Token nit', 'A colour is hard-coded.'),
  '## High',
  '',
  entry('REBA1.1', 'No test', 'The bug would come back unnoticed.'),
  '## Unresolved',
  '',
  '- [COLE1.1] both positions',
  '',
].join('\n')

describe('sortFindingsMarkdown', () => {
  it('puts the severity sections in the fixed order, keeps entries in their order, keeps the other sections in place, and rewrites the totals from the body', () => {
    const sorted = sortFindingsMarkdown(MIXED)
    const headings = [...sorted.matchAll(/^## (.+)$/gm)].map((match) => match[1])
    expect(headings).toEqual(['Critical', 'High', 'Low', 'Info', 'Unresolved'])
    expect(sorted).toContain('Totals: 2 critical · 1 high · 0 medium · 1 low · 1 info')
    expect(sorted.indexOf('[AVA1.1]')).toBeLessThan(sorted.indexOf('[AVA1.2]'))
    expect(sorted.indexOf('Reviewed: base')).toBeLessThan(sorted.indexOf('Totals:'))
    expect(countsFromFindings(sorted)).toEqual({ critical: 2, high: 1, medium: 0, low: 1, info: 1 })
  })

  it('returns a file that is already in order unchanged, and a non-findings file as is', () => {
    const ordered = '# Findings: test\n\nTotals: 0 critical · 1 high · 0 medium · 0 low · 0 info\n\n## High\n\n### [AVA1.1] Unchecked input\n- **Location:** `a.ts:1`\n'
    expect(sortFindingsMarkdown(ordered)).toBe(ordered)
    expect(sortFindingsMarkdown('# Review: x\n\nNot a fix list.\n')).toBe('# Review: x\n\nNot a fix list.\n')
  })

  it('adds a totals line under the title when the writer left it out', () => {
    const sorted = sortFindingsMarkdown('# Findings: test\n\n## Medium\n\n### [COLE1.1] Slow query\n')
    expect(sorted.startsWith('# Findings: test\n\nTotals: 0 critical · 0 high · 1 medium · 0 low · 0 info\n')).toBe(true)
    expect(countsFromFindings(sorted)).toEqual({ critical: 0, high: 0, medium: 1, low: 0, info: 0 })
  })
})

describe('summaries and the comment list', () => {
  it('lists every finding critical first with its plain-English line, and names the ones without one', () => {
    expect(findingSummaries(MIXED).map((finding) => [finding.id, finding.severity, finding.whatThisMeans])).toEqual([
      ['AVA1.1', 'critical', 'Anyone could run commands on the server.'],
      ['AVA1.2', 'critical', null],
      ['REBA1.1', 'high', 'The bug would come back unnoticed.'],
      ['DEX1.1', 'low', 'The helper is hard to find.'],
      ['IRIS1.1', 'info', 'A colour is hard-coded.'],
    ])
    expect(missingWhatThisMeans(MIXED)).toEqual(['AVA1.2'])
  })

  it('heads the list with a count that equals the lines under it', () => {
    const list = renderFindingsList(MIXED)
    expect(list.split('\n')[0]).toBe('## Findings (5: 2 critical · 1 high · 0 medium · 1 low · 1 info)')
    expect(list.match(/^- \*\*/gm)).toHaveLength(5)
    expect(list).toContain('- **Critical** · Anyone could run commands on the server. _(AVA1.1: Unchecked input; evidence in findings.md)_')
    expect(list).toContain('- **Critical** · Secret in log _(AVA1.2; evidence in findings.md)_')
    expect(renderFindingsList('# Findings: clean\n\nTotals: 0 critical · 0 high · 0 medium · 0 low · 0 info\n')).toContain('None.')
  })
})
