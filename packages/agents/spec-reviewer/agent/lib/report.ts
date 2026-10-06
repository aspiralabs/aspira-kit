// The human-facing files of a spec review: findings in severity order with the plain-English line
// first, decisions as checkboxes the author ticks, and the answers read back on the next run.
// Pure, so the spec writer renders its review half through the same code.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTickedDecisions, renderDecisions, type Answer, type DecisionRecord } from '@aspiralabs/agent-common/lib/decisions'
import { countBySeverity, findingsHeader, sortBySeverity } from '@aspiralabs/agent-common/lib/severity'
import type { Finding, Synthesis } from './review.ts'

/** The findings in the order a human reads them: critical first; within a severity, the order they were confirmed. */
export const orderedFindings = (findings: readonly Finding[]): Finding[] => sortBySeverity(findings, (finding) => finding.severity)

/** One finding: title, severity, what it means, then the verified evidence and the exact correction (REV-022). */
export function renderFinding(finding: Finding, disposition?: Pick<Synthesis['dispositions'][number], 'status' | 'reason'>): string {
  const lines = [`## ${finding.id} — ${finding.title}`, '', `Severity: **${finding.severity}**${disposition ? ` · Disposition: ${disposition.status}` : ''}`, '', `**What this means:** ${finding.whatThisMeans}`, '', 'Evidence:', '', ...finding.evidence.map((item) => `- ${item}`), '', `Proposed correction: ${finding.fix}`]
  if (disposition) lines.push('', `Disposition reason: ${disposition.reason}`)
  return lines.join('\n')
}

/** trace/findings.md: a header whose count equals the entries below it, then every finding, sorted. Nothing is dropped. */
export function renderFindings(findings: readonly Finding[], synthesis: Synthesis | null): string {
  const ordered = orderedFindings(findings)
  const dispositions = new Map((synthesis?.dispositions ?? []).map((d) => [d.findingId, d]))
  const body = ordered.map((finding) => renderFinding(finding, dispositions.get(finding.id)))
  return ['# Findings', '', findingsHeader(countBySeverity(ordered, (finding) => finding.severity)), '', 'Ordered by severity, then by the order the reviewers confirmed them. The plain-English line comes first; the evidence under it is what was checked (REV-022).', '', ...(body.length ? [body.join('\n\n')] : ['No findings.']), ''].join('\n')
}

/** The findings section a non-ready reviewed spec carries above the candidate: what to read before the spec itself. */
export function renderFindingsSection(findings: readonly Finding[]): string {
  const ordered = orderedFindings(findings)
  const lines = [`## Review findings (${findingsHeader(countBySeverity(ordered, (finding) => finding.severity))})`, '']
  for (const finding of ordered) lines.push(`- **${finding.severity}** · ${finding.id} — ${finding.title}: ${finding.whatThisMeans}`)
  if (!ordered.length) lines.push('None.')
  return lines.join('\n')
}

/** trace/decisions.md: the author's decisions as checkboxes, recommended option first, then every other disposition for the record. */
export function renderDecisionsFile(status: string, authorDecisions: readonly DecisionRecord[], synthesis: Synthesis | null): string {
  const head = renderDecisions(authorDecisions, { title: 'Decisions', status, intro: 'Tick one option per decision to answer it. The next review of this spec reads the tick and records the decision as yours in trace/review.json.' })
  if (!synthesis) return `${head}\nReconciliation did not finish. All findings remain unresolved.\n`
  const rest = synthesis.dispositions.filter((d) => d.status !== 'author')
  const record = rest.map((d) => `### ${d.findingId} — ${d.status}\n\n${d.reason}\n\nEvidence: ${d.evidence.join('; ') || 'none'}\n\nEdits: ${d.editIds.join(', ') || 'none'}${d.duplicateOf ? `; duplicate of ${d.duplicateOf}` : ''}`)
  return `${head}\n## Dispositions\n\n${record.length ? record.join('\n\n') : 'None.'}\n`
}

/** The ticks the author made in the previous run's decisions file, or none when there is no previous run. */
export async function readAnswers(reportDir: string): Promise<Answer[]> {
  const text = await readFile(join(reportDir, 'trace', 'decisions.md'), 'utf8').catch(() => null)
  return text === null ? [] : parseTickedDecisions(text)
}
