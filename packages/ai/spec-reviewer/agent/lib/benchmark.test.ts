import { expect, it } from 'vitest'
import { scoreBenchmark, type Evaluation } from './benchmark.ts'

const evaluation = (id: string, mappings: Evaluation['mappings']): Evaluation => ({ expectedIssueIds: [id], mappings })

it('scores raised separately from retained and rejects fabricated evidence', () => {
  const report = { findings: [{ id: 'R1', title: 'Old mobile expects an array', severity: 'high' as const, whatThisMeans: 'The installed app would crash on its recipes list.', evidence: ['mobile/api.ts:10'], fix: 'Keep array' }], synthesis: null, status: 'incomplete', totalMs: 1000 }
  const score = scoreBenchmark(report, '', evaluation('COMPATIBILITY', [{ id: 'COMPATIBILITY', findingId: 'R1', raisedQuote: 'Old mobile expects an array', resolutionQuote: '' }]))
  expect(score.raised).toEqual(['COMPATIBILITY'])
  expect(score.retained).toEqual([])
  expect(score.passed).toBe(false)
  expect(scoreBenchmark(report, '', evaluation('COMPATIBILITY', [{ id: 'COMPATIBILITY', findingId: 'R1', raisedQuote: 'invented', resolutionQuote: '' }])).errors).toHaveLength(1)
})

it('accepts a safeguard in the candidate when a related author choice is still open', () => {
  const report = { findings: [{ id: 'R1', title: 'Choose format; enforce entitlement', severity: 'medium' as const, whatThisMeans: 'Anyone could export recipes they are not allowed to see.', evidence: ['spec: export'], fix: 'Choose file shape and deny unauthorized export' }], synthesis: { edits: [], dispositions: [{ findingId: 'R1', status: 'author' as const, reason: 'Choose array or separate files', evidence: ['spec: export'], editIds: [], duplicateOf: null }] }, status: 'needs-author', totalMs: 1000 }
  const mapping = [{ id: 'ACCESS', findingId: 'R1', raisedQuote: 'enforce entitlement', resolutionQuote: 'Deny unauthorized export' }]
  expect(scoreBenchmark(report, 'Deny unauthorized export', evaluation('ACCESS', mapping)).retained).toEqual(['ACCESS'])
  expect(scoreBenchmark(report, 'Unrelated candidate', evaluation('ACCESS', mapping)).retained).toEqual([])
  const grouped = [{ ...mapping[0]!, additionalEvidence: [{ findingId: 'R1', raisedQuote: 'Choose format', resolutionQuote: 'Choose array or separate files' }] }]
  expect(scoreBenchmark(report, 'Deny unauthorized export', evaluation('ACCESS', grouped)).retained).toEqual(['ACCESS'])
  expect(scoreBenchmark(report, 'Deny unauthorized export', evaluation('ACCESS', [{ ...grouped[0]!, additionalEvidence: [{ findingId: 'missing', raisedQuote: 'Made up', resolutionQuote: 'Deny unauthorized export' }] }])).retained).toEqual([])
})

it('uses external issue sets rather than a fixed baseline', () => {
  const report = {
    findings: [{ id: 'R1', title: 'Missing input validation', severity: 'high' as const, whatThisMeans: 'Bad input would be saved as if it were valid.', evidence: ['spec: input'], fix: 'Reject invalid input' }],
    synthesis: { edits: [], dispositions: [{ findingId: 'R1', status: 'applied' as const, reason: 'Added validation', evidence: ['spec: input'], editIds: ['E1'], duplicateOf: null }] },
    status: 'ready', totalMs: 1000,
  }
  const manifest = evaluation('VALIDATION', [{ id: 'VALIDATION', findingId: 'R1', raisedQuote: 'Missing input validation', resolutionQuote: 'Reject invalid input' }])
  const score = (value: Evaluation) => scoreBenchmark(report, 'Reject invalid input', value)
  expect(score(manifest).passed).toBe(true)
  expect(score({ ...manifest, expectedIssueIds: ['VALIDATION', 'ANOTHER'] }).missing).toEqual(['ANOTHER'])
  expect(score({ ...manifest, expectedIssueIds: ['UNRELATED'] }).passed).toBe(false)
  expect(score({ ...manifest, mappings: [...manifest.mappings, ...manifest.mappings] }).passed).toBe(false)
  expect(scoreBenchmark({ ...report, totalMs: 3_600_000 }, 'Reject invalid input', manifest).passed).toBe(true)
  expect(scoreBenchmark({ ...report, status: 'incomplete' }, 'Reject invalid input', manifest).passed).toBe(false)
  expect(scoreBenchmark({ ...report, totalMs: -1 }, 'Reject invalid input', manifest).passed).toBe(false)
  expect(() => score({ ...manifest, expectedIssueIds: [] })).toThrow()
  expect(() => score({ ...manifest, expectedIssueIds: ['VALIDATION', 'VALIDATION'] })).toThrow()
})
