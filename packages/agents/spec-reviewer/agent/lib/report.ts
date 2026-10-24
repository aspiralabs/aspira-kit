// The human-facing files of a spec review: findings in severity order with the plain-English line
// first, decisions as checkboxes the author ticks, and the answers read back on the next run.
// Pure, so the spec writer renders its review half through the same code.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTickedDecisions, renderDecisions, type Answer, type DecisionRecord } from '@aspiralabs/ai/common/lib/decisions'
import { countBySeverity, findingsHeader, sortBySeverity } from '@aspiralabs/ai/common/lib/severity'
import { openGapsOf, type Finding, type Gap, type Synthesis } from './review.ts'

/** The findings in the order a human reads them: critical first; within a severity, the order they were confirmed. */
export const orderedFindings = (findings: readonly Finding[]): Finding[] => sortBySeverity(findings, (finding) => finding.severity)

/** One finding: title, severity, what it means, then the verified evidence and the exact correction (REV-022). */
export function renderFinding(finding: Finding, disposition?: Pick<Synthesis['dispositions'][number], 'status' | 'reason'>): string {
  const lines = [`## ${finding.id} — ${finding.title}`, '', `Severity: **${finding.severity}**${disposition ? ` · Disposition: ${disposition.status}` : ''}`, '', `**What this means:** ${finding.whatThisMeans}`, '', 'Evidence:', '', ...finding.evidence.map((item) => `- ${item}`), '', `Proposed correction: ${finding.fix}`]
  if (disposition) lines.push('', `Disposition reason: ${disposition.reason}`)
  return lines.join('\n')
}

/** trace/findings.md: a header whose count equals the entries below it, then every finding, sorted. Nothing is dropped. */
export function renderFindings(findings: readonly Finding[], synthesis: Synthesis | null, gaps: readonly Gap[] = []): string {
  const ordered = orderedFindings(findings)
  const dispositions = new Map((synthesis?.dispositions ?? []).map((d) => [d.findingId, d]))
  const body = ordered.map((finding) => renderFinding(finding, dispositions.get(finding.id)))
  // Gaps the author closed with a cited answer in the spec (KIT-31): the review could not verify them itself, so the human approving the spec sees them here.
  const byAuthor = (synthesis?.gapResolutions ?? []).filter((resolution) => resolution.status === 'author')
  const authorSection = byAuthor.length
    ? ['', '## Evidence gaps resolved by the author', '', 'The review could not reach these sources (the web, Notion, a cloud account); the author answered each in the spec, naming the source. Check them when approving the spec.', '', ...byAuthor.map((resolution) => `- ${resolution.gapId} (${gaps.find((gap) => gap.id === resolution.gapId)?.text ?? 'gap'}): ${resolution.evidence.join('; ')}`)]
    : []
  // Gaps nobody closed (KIT-53): listed for the approver, never a failure.
  const open = openGapsOf(gaps, synthesis)
  const openSection = open.length
    ? ['', '## Evidence gaps left open', '', 'The review could not verify these: the source was not in its packet or not reachable, and no reviewer closed them. They do not block the spec. Check them when approving it, and answer any that matters in the spec with the source named, which the next review reads as the author\'s evidence.', '', ...open.map((gap) => `- ${gap.id} (${gap.source}): ${gap.text}`)]
    : []
  return ['# Findings', '', findingsHeader(countBySeverity(ordered, (finding) => finding.severity)), '', 'Ordered by severity, then by the order the reviewers confirmed them. The plain-English line comes first; the evidence under it is what was checked (REV-022).', '', ...(body.length ? [body.join('\n\n')] : ['No findings.']), ...authorSection, ...openSection, ''].join('\n')
}

/**
 * The candidate with every decided author decision written into its `## Decisions` section (KIT-36):
 * the author's answers and the ones taken as recommended, in the `- **Q<n> — <question>** Answer:
 * <answer>. Why: <reasoning>.` form the planner's settled-decisions rule reads, so a later step
 * never raises them again. A spec with no decided decision is returned as is; an existing
 * `## Decisions` section gains the items at its end.
 */
export function withSettledDecisions(candidate: string, decisions: readonly DecisionRecord[]): string {
  const decided = decisions.filter((decision) => decision.decidedBy !== 'open' && decision.answer !== null)
  if (!decided.length) return candidate
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  const items = decided.map((decision, index) => `- **Q${index + 1} — ${clean(decision.question)}** Answer: ${clean(decision.answer ?? '')}. Why: ${clean(decision.reasoning)}${decision.decidedBy === 'agent' ? ' (taken as recommended)' : ''}.`)
  const section = candidate.match(/^## Decisions[ \t]*$([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/m)
  if (section === null) return `${candidate.replace(/\s*$/, '')}\n\n## Decisions\n\n${items.join('\n')}\n`
  const end = section.index! + section[0].length
  const body = section[0].replace(/\s*$/, '')
  return `${candidate.slice(0, section.index!)}${body}\n${items.join('\n')}\n\n${candidate.slice(end).replace(/^\s*/, '')}`
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
