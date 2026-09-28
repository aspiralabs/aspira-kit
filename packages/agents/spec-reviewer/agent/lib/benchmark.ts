import { z } from 'zod'
import type { PipelineResult } from './pipeline.ts'

const evidenceMapping = z.object({ findingId: z.string().min(1), raisedQuote: z.string(), resolutionQuote: z.string() })
export const evaluationSchema = z.object({
  expectedIssueIds: z.array(z.string().trim().min(1)).min(1).refine((ids) => new Set(ids).size === ids.length, 'Duplicate expected issue IDs'),
  mappings: z.array(evidenceMapping.extend({ id: z.string().min(1), additionalEvidence: z.array(evidenceMapping).optional() })),
})
export type Evaluation = z.infer<typeof evaluationSchema>

/** Evidence-mapped scoring, not keyword recall. A human judges whether a quote actually
 * covers the issue; code checks the quote is real and the finding survived reconciliation. */
export function scoreBenchmark(report: Pick<PipelineResult, 'findings' | 'synthesis' | 'status'> & { totalMs: number }, candidate: string, evaluation: Evaluation) {
  const { expectedIssueIds, mappings } = evaluationSchema.parse(evaluation)
  const raised: string[] = []
  const retained: string[] = []
  const errors: string[] = []
  if (new Set(mappings.map((m) => m.id)).size !== mappings.length) errors.push('Duplicate baseline IDs')
  if (!Number.isFinite(report.totalMs) || report.totalMs < 0) errors.push('Invalid run duration')
  for (const row of mappings) {
    if (!expectedIssueIds.includes(row.id)) { errors.push(`Unknown baseline ID: ${row.id}`); continue }
    const evidenceRows = [row, ...(row.additionalEvidence ?? [])]
    const outcomes = evidenceRows.map((item) => {
      const finding = report.findings.find((f) => f.id === item.findingId)
      if (!finding || !item.raisedQuote.trim() || !JSON.stringify(finding).includes(item.raisedQuote)) {
        errors.push(`Unsupported raised evidence: ${row.id}/${item.findingId}`)
        return { raised: false, retained: false }
      }
      let disposition = report.synthesis?.dispositions.find((d) => d.findingId === item.findingId)
      if (disposition?.status === 'duplicate') disposition = report.synthesis?.dispositions.find((d) => d.findingId === disposition?.duplicateOf)
      // Mandatory safeguards can live in the candidate while the remaining
      // product choice lives in an author decision. Both must be real evidence.
      const text = disposition?.status === 'author' ? `${candidate}\n${disposition.reason}` : candidate
      return { raised: true, retained: Boolean(disposition && ['applied', 'author'].includes(disposition.status) && item.resolutionQuote.trim() && text.includes(item.resolutionQuote)) }
    })
    if (outcomes.every((item) => item.raised)) raised.push(row.id)
    if (outcomes.every((item) => item.retained)) retained.push(row.id)
  }
  return { raised, retained, missing: expectedIssueIds.filter((id) => !retained.includes(id)), errors, passed: errors.length === 0 && retained.length === expectedIssueIds.length && ['ready', 'needs-author'].includes(report.status) }
}
