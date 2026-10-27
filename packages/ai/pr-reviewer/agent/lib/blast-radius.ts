// The Blast radius check (KIT-70): the files a spec's "## Blast radius" section names, the changed files outside
// them, and the one low finding that says so. Pure: text in, text out; the caller reads the spec and the tree.

export type ChangedPath = { status: string; path: string; oldPath?: string }
export type BlastDeclaration = { declared: string[]; unresolved: string[] }
export type OutsideFiles = { files: string[]; more: number }
export type BlastCheck = { outside: OutsideFiles; specFile: string; entries: string[] }

export const BLAST_ID = 'BLAST1.1'
const MAX_LISTED = 25
const HEADING = /^## Blast radius\s*$/i
const GLOB = /[*?{}[\]]/
const PATH_LIKE = /\/|\.[A-Za-z0-9]{1,6}$/
const BLAST_ENTRY = /^### \[BLAST[^\]]*\]/

const clean = (token: string): string => token.trim().replace(/^\.\//, '').replace(/\/+$/, '')

/** The paths a spec's `## Blast radius` section names in backticks, resolved against the tracked files. */
export function parseBlastRadius(spec: string, tracked: string[], packages: Record<string, string>): BlastDeclaration {
  const files = new Set(tracked)
  const isDir = (path: string): boolean => tracked.some((file) => file.startsWith(`${path}/`))
  const declared: string[] = []
  const unresolved: string[] = []
  const add = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value)
  }

  let inSection = false
  let excludedIndent: number | null = null
  for (const line of spec.split('\n')) {
    if (/^## /.test(line)) {
      inSection = HEADING.test(line)
      excludedIndent = null
      continue
    }
    if (!inSection || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (excludedIndent !== null) {
      if (indent > excludedIndent) continue
      excludedIndent = null
    }
    if (/^\s*[-*]\s*(\*\*)?Excluded:?/i.test(line)) {
      excludedIndent = indent
      continue
    }
    let last: string | undefined
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = clean(match[1] ?? '')
      if (token === '') continue
      if (GLOB.test(token)) {
        if (PATH_LIKE.test(token)) add(unresolved, token)
        continue
      }
      const packageDir = packages[token]
      if (packageDir !== undefined) {
        add(declared, packageDir)
        continue
      }
      if (!token.includes('/') && last !== undefined) {
        const beside = `${last}/${token}`
        if (files.has(beside)) {
          add(declared, beside)
          continue
        }
      }
      if (files.has(token)) {
        add(declared, token)
        if (token.includes('/')) last = token.slice(0, token.lastIndexOf('/'))
      } else if (isDir(token)) {
        add(declared, token)
        last = token
      } else if (PATH_LIKE.test(token)) add(unresolved, token)
    }
  }
  return { declared, unresolved }
}

/** The changed paths from a unified diff: the new path of a rename, the old path of a deletion. */
export function changedFromPatch(patch: string): ChangedPath[] {
  const changed: ChangedPath[] = []
  let current: { a: string; b: string; status: string; oldPath?: string } | null = null
  const flush = () => {
    if (current === null) return
    if (current.status === 'D') changed.push({ status: 'D', path: current.a })
    else changed.push({ status: current.status, path: current.b, ...(current.oldPath === undefined ? {} : { oldPath: current.oldPath }) })
  }
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header !== null) {
      flush()
      current = { a: header[1] ?? '', b: header[2] ?? '', status: 'M' }
    } else if (current !== null) {
      if (line.startsWith('deleted file mode')) current.status = 'D'
      else if (line.startsWith('new file mode')) current.status = 'A'
      else if (line.startsWith('rename from ')) {
        current.status = 'R'
        current.oldPath = line.slice('rename from '.length)
      }
    }
  }
  flush()
  return changed
}

/** Changed files outside the declaration, ascending, 25 listed and the rest counted; null when all are inside. */
export function outsideBlastRadius(changed: ChangedPath[], declared: string[]): OutsideFiles | null {
  const inside = (path: string): boolean => declared.some((entry) => path === entry || path.startsWith(`${entry}/`))
  const outside = [...new Set(changed.map((entry) => entry.path).filter((path) => !inside(path)))].sort()
  if (outside.length === 0) return null
  return { files: outside.slice(0, MAX_LISTED), more: Math.max(0, outside.length - MAX_LISTED) }
}

function entryFor(check: BlastCheck): string[] {
  const count = check.outside.files.length + check.outside.more
  const listed = check.outside.files.map((file) => `\`${file}\``).join(', ')
  return [
    `### [${BLAST_ID}] Blast radius: ${count} changed file${count === 1 ? '' : 's'} outside the spec`,
    `**What this means:** The change touches ${count} file${count === 1 ? '' : 's'} the spec's Blast radius section does not name. Check they belong to this change.`,
    `- **Location:** \`${check.specFile}\``,
    `- **Evidence:** ${listed}${check.outside.more > 0 ? ` (+${check.outside.more} more)` : ''}`,
    `- **Declared:** ${check.entries.map((entry) => `\`${entry}\``).join(', ')}`,
    '',
  ]
}

/** findings.md with exactly one Blast radius entry under `## Low`, replacing a previous one. Totals are the sort's job. */
export function withBlastRadiusFinding(findings: string, check: BlastCheck): string {
  const kept: string[] = []
  let dropping = false
  for (const line of findings.split('\n')) {
    if (BLAST_ENTRY.test(line)) {
      dropping = true
      continue
    }
    if (dropping && /^##+ /.test(line)) dropping = false
    if (!dropping) kept.push(line)
  }
  const entry = entryFor(check)
  const low = kept.findIndex((line) => /^## Low\s*$/i.test(line))
  if (low < 0) {
    while (kept.at(-1)?.trim() === '') kept.pop()
    return [...kept, '', '## Low', '', ...entry].join('\n')
  }
  let end = kept.findIndex((line, index) => index > low && /^## /.test(line))
  if (end < 0) end = kept.length
  let bodyEnd = end
  while (bodyEnd > low + 1 && kept[bodyEnd - 1]?.trim() === '') bodyEnd -= 1
  return [...kept.slice(0, bodyEnd), ...(bodyEnd === low + 1 ? [''] : []), ...entry, ...kept.slice(end)].join('\n')
}
