// The counts behind a PR review verdict, shared so every reader of a findings.md agrees on them
// (specs/agents-human-lists.md F27). Moved from pr-reviewer's agent/lib/findings.ts unchanged, so
// both pr-reviewer and build-feature read the same counts (packages/ai/README.md: shared logic
// lives in a shared package, helpers in common/src/lib). Pure: text in, counts out.

import { SEVERITIES, type Counts, type Severity } from './severity.ts'

const TITLE = /^# Findings\b/m
const SECTION = /^## (.+?)\s*$/
const ENTRY = /^### \[([^\]]+)\]\s*(.*)$/

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
