// findings.md as code reads it: Nova writes the fix list and Quinn signs it off, but the order a
// human reads it in, the totals line and the plain-English line are checked and fixed here, so the
// file, the PR comment and the counts the verdict is computed from always agree
// (specs/agents-human-lists.md F1, F2). Pure: text in, text out.

import { SEVERITIES, countsLine, severityHeading, severityRank, totalFindings, type Counts, type Severity } from '@aspiralabs/agent-common/lib/severity'

const TITLE = /^# Findings\b/m
const SECTION = /^## (.+?)\s*$/
const ENTRY = /^### \[([^\]]+)\]\s*(.*)$/
const TOTALS = /^Totals: .*$/m
const MEANING = /^\*\*What this means:\*\*\s*(.*)$/

const severityOf = (heading: string): Severity | null => SEVERITIES.find((name) => name === heading.toLowerCase()) ?? null

/** `## <Severity>` sections and the rest, each with its lines, in file order. */
type Section = { heading: string | null; severity: Severity | null; lines: string[] }

function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [{ heading: null, severity: null, lines: [] }]
  for (const line of markdown.split('\n')) {
    const heading = line.match(SECTION)?.[1]
    if (heading !== undefined) sections.push({ heading, severity: severityOf(heading), lines: [line] })
    else sections.at(-1)!.lines.push(line)
  }
  return sections
}

/**
 * The counts from findings.md, or null when the text is not a findings file. Counts the
 * `### [ID]` findings under each `## <Severity>` heading, so the verdict never depends on how
 * the model worded its totals line.
 */
export function countsFromFindings(findings: string): Counts | null {
  if (!TITLE.test(findings)) return null
  const counts: Counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const section of sectionsOf(findings)) {
    if (section.severity === null) continue
    counts[section.severity] += section.lines.filter((line) => ENTRY.test(line)).length
  }
  return counts
}

/**
 * The file with its severity sections in the fixed order (critical first) and its totals line equal
 * to what the sections hold. Entries keep their order within a section, the other sections
 * (previous findings, unresolved) keep their place, and a file that is already in order is
 * returned unchanged. Not a findings file: returned as is.
 */
export function sortFindingsMarkdown(findings: string): string {
  const counts = countsFromFindings(findings)
  if (counts === null) return findings
  const sections = sectionsOf(findings)
  const firstSeverity = sections.findIndex((section) => section.severity !== null)
  const ordered = firstSeverity < 0 ? sections : [
    ...sections.slice(0, firstSeverity),
    ...sections.slice(firstSeverity).filter((section) => section.severity !== null).sort((a, b) => severityRank(a.severity!) - severityRank(b.severity!)),
    ...sections.slice(firstSeverity).filter((section) => section.severity === null),
  ]
  const text = ordered.flatMap((section) => section.lines).join('\n')
  const totals = `Totals: ${countsLine(counts)}`
  if (TOTALS.test(text)) return text.replace(TOTALS, totals)
  // No totals line: put one under the title (and its stamp, when there is one).
  const title = text.match(/^# .*\n(?:\n?(?:Reviewed|Re-review):.*\n)?/m)
  if (title === null || title.index === undefined) return text
  const at = title.index + title[0].length
  return `${text.slice(0, at)}\n${totals}\n${text.slice(at)}`
}

/** One finding as the comment lists it: the id, where it sits, its title and its plain-English line (null when the writer left it out). */
export type FindingSummary = { id: string; severity: Severity; title: string; whatThisMeans: string | null }

/** Every finding in the file, critical first, in the section order. */
export function findingSummaries(findings: string): FindingSummary[] {
  const summaries: FindingSummary[] = []
  for (const section of sectionsOf(sortFindingsMarkdown(findings))) {
    if (section.severity === null) continue
    let current: FindingSummary | null = null
    for (const line of section.lines) {
      const entry = line.match(ENTRY)
      if (entry !== null) {
        current = { id: entry[1]!, severity: section.severity, title: entry[2]!.trim(), whatThisMeans: null }
        summaries.push(current)
        continue
      }
      const meaning = line.match(MEANING)
      if (meaning !== null && current !== null && current.whatThisMeans === null) current.whatThisMeans = meaning[1]!.trim()
    }
  }
  return summaries
}

/** The ids of findings without a `**What this means:**` line: what Quinn's sign-off has to add. */
export const missingWhatThisMeans = (findings: string): string[] => findingSummaries(findings).filter((finding) => finding.whatThisMeans === null).map((finding) => finding.id)

/** The findings as a list for the PR comment: a header whose count equals the lines under it, the plain-English line first. */
export function renderFindingsList(findings: string): string {
  const summaries = findingSummaries(findings)
  const counts = countsFromFindings(findings) ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  const lines = [`## Findings (${totalFindings(counts)}: ${countsLine(counts)})`, '']
  if (summaries.length === 0) lines.push('None.')
  for (const finding of summaries) lines.push(`- **${severityHeading(finding.severity)}** · ${finding.whatThisMeans ?? finding.title} _(${finding.id}${finding.whatThisMeans === null ? '' : `: ${finding.title}`}; evidence in findings.md)_`)
  return lines.join('\n')
}
