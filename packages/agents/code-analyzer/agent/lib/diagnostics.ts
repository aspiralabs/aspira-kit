export type Severity = 'error' | 'warning'
export type Diagnostic = { tool: string; file: string; line: number | null; column: number | null; message: string; rule: string | null; severity: Severity }

export const fingerprint = (d: Diagnostic): string => `${d.tool}|${d.file}|${d.line ?? ''}|${d.rule ?? ''}|${d.message.slice(0, 120)}`
export const errors = (all: Diagnostic[]): Diagnostic[] => all.filter((d) => d.severity === 'error')

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

export type Batch = { files: string[]; diagnostics: Diagnostic[] }

/** Groups by file, largest first, then packs files into batches so one model call
 * sees related diagnostics together without an unbounded context. */
export function batch(diagnostics: Diagnostic[], limits = { files: 5, diagnostics: 40, batches: 8 }): Batch[] {
  const byFile = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d])
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const batches: Batch[] = []
  let current: Batch = { files: [], diagnostics: [] }
  for (const [file, list] of files) {
    const overflow = current.files.length >= limits.files || (current.diagnostics.length > 0 && current.diagnostics.length + list.length > limits.diagnostics)
    if (overflow) { batches.push(current); current = { files: [], diagnostics: [] } }
    current.files.push(file)
    current.diagnostics.push(...list.slice(0, limits.diagnostics))
  }
  if (current.files.length) batches.push(current)
  return batches.slice(0, limits.batches)
}

export const sameSet = (a: Diagnostic[], b: Diagnostic[]): boolean => {
  if (a.length !== b.length) return false
  const left = new Set(a.map(fingerprint))
  return b.every((d) => left.has(fingerprint(d)))
}
