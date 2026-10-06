// The review packet: the identical cached prefix every seat and Quinn start with. It is an index
// of the change, not the change: the pull request, the required reading, and one line per changed
// file with its path, its added and deleted lines, an area tag from its path, and the symbols its
// hunks touch. No hunks and no file bodies: a seat picks the files its lens needs from the index
// and fetches their hunks with read_diff and their surroundings with read_files, once each, into
// its own context only. Pure: no eve, no node imports, so it is tested on fixtures.

/** read_files and read_diff cut one file past this many characters, with a pointer. */
export const MAX_FULL_FILE_CHARS = 40_000
/** Symbols listed per file in the index; the rest are counted. */
export const MAX_SYMBOLS_PER_FILE = 12

export type PacketInput = {
  label: string
  /** pr.md as the seats read it: title, base and head, description, changed paths. */
  description: string
  patch: string
  changed: string[]
  /** REQUIRED.md from the knowledge folder, or null when the guidelines were not loaded. */
  required: string | null
  /** A re-review: the previous findings.md, which the seats rule on against the delta. */
  previousFindings?: string | null
}

export type Area = 'api' | 'db-migration' | 'web-ui' | 'mobile' | 'lib' | 'test' | 'e2e' | 'docs' | 'config' | 'infra'

export type PacketStats = {
  chars: number
  /** chars / 4: an estimate, since the packet is sent to two model families. */
  tokens: number
  /** Changed files in the index. */
  files: number
  /** How many files carry each area tag. */
  areas: Partial<Record<Area, number>>
}

export type Packet = PacketStats & { text: string }

/** One line of the index. */
export type IndexEntry = { path: string; additions: number; deletions: number; area: Area; symbols: string[]; moreSymbols: number }

export const packetTokens = (chars: number): number => Math.ceil(chars / 4)

const num = (n: number): string => n.toLocaleString('en-US')

/**
 * Area by path, first rule that matches. Tests and e2e come before the app they live in, config
 * and docs before the code they sit beside, mobile before web-ui (both are .tsx), lib is the rest.
 */
export const AREA_RULES: readonly [RegExp, Area][] = [
  [/(^|\/)e2e\/|\.e2e\.|playwright/i, 'e2e'],
  [/\.(test|spec)\.|(^|\/)(__tests__|tests?|__mocks__)\/|(^|\/)msw(\.|\/)/i, 'test'],
  [/(^|\/)migrations?\/|\.sql$|schema\.prisma$/i, 'db-migration'],
  [/^infra\/|\.tf$|(^|\/)Dockerfile|docker-compose|^\.github\//i, 'infra'],
  [/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json)$|eslint|prettier|\.config\.|(^|\/)\.env|\.(ya?ml|toml|json)$/i, 'config'],
  [/\.(md|mdx)$|^docs\//i, 'docs'],
  [/(^|\/)api\/|(^|\/)routes?\/|(^|\/)route\.ts$|(^|\/)server\//i, 'api'],
  [/^apps\/mobile\//i, 'mobile'],
  [/\.tsx$|(^|\/)components\/|(^|\/)app\/|\.css$/i, 'web-ui'],
]

export function areaOf(path: string): Area {
  for (const [pattern, area] of AREA_RULES) if (pattern.test(path)) return area
  return 'lib'
}

const ID = String.raw`([A-Za-z_$][\w$]*)`
const QUOTED = String.raw`['"\x60]([^'"\x60]+)['"\x60]`

/**
 * The symbol a code line declares, or null. Declarations only: a function, class, exported
 * value or type, a route, a SQL or Prisma object, a YAML top-level key, a Markdown heading, a
 * test's describe title. Plain statements and nested locals are not symbols.
 */
export function symbolOf(line: string, options: { nested?: boolean } = {}): string | null {
  const indent = line.match(/^\s*/)?.[0].length ?? 0
  const text = line.trim()
  if (text === '') return null
  let m: RegExpMatchArray | null
  // TypeScript and JavaScript.
  if ((m = text.match(new RegExp(String.raw`^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+${ID}`)))) return m[1] ?? null
  if ((m = text.match(new RegExp(String.raw`^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+${ID}`)))) return m[1] ?? null
  if ((m = text.match(new RegExp(String.raw`^export\s+(?:declare\s+)?(?:type|interface|enum|namespace)\s+${ID}`)))) return m[1] ?? null
  if ((m = text.match(new RegExp(String.raw`^(?:(?:router|app|server)\.)(get|post|put|patch|delete|all)\(\s*${QUOTED}`, 'i')))) return `${(m[1] ?? '').toUpperCase()} ${m[2] ?? ''}`
  if ((m = text.match(new RegExp(String.raw`^export\s+(?:const|let|var)\s+${ID}`)))) return m[1] ?? null
  if ((m = text.match(/^export\s*\{\s*([^}]+?)\s*\}/))) return (m[1] ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/).at(-1) ?? '').filter((part) => part !== '').join(', ')
  if ((m = text.match(new RegExp(String.raw`^export\s+default\s+${ID}\s*$`)))) return m[1] ?? null
  // Top-level declarations only: a `const` two spaces in is a local of the function around it. A
  // hunk header's context is a declaration wherever it sits, so headers pass `nested`.
  if (indent === 0 || options.nested === true) {
    if ((m = text.match(new RegExp(String.raw`^(?:type|interface|enum)\s+${ID}`)))) return m[1] ?? null
    if ((m = text.match(new RegExp(String.raw`^(?:const|let|var)\s+${ID}\s*(?::[^=]+)?=`)))) return m[1] ?? null
    if ((m = text.match(new RegExp(String.raw`^describe\(\s*${QUOTED}`)))) return `describe ${m[1] ?? ''}`
  }
  // SQL.
  if ((m = text.match(/^(?:CREATE|DROP|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|TYPE|FUNCTION|VIEW|TRIGGER|SCHEMA|EXTENSION)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:CONCURRENTLY\s+)?"?([\w.]+)"?/i))) return `${(m[1] ?? '').toUpperCase()} ${m[2] ?? ''}`
  // Prisma.
  if ((m = text.match(new RegExp(String.raw`^(model|enum|generator|datasource|view)\s+${ID}\s*\{`)))) return `${m[1] ?? ''} ${m[2] ?? ''}`
  // Markdown headings.
  if ((m = text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/))) return (m[1] ?? '').slice(0, 60)
  // YAML and JSON top-level keys.
  if (indent === 0 && (m = text.match(/^([A-Za-z_][\w.-]*):(?:\s|$)/))) return m[1] ?? null
  if (indent <= 2 && (m = text.match(/^"([^"]+)":/))) return m[1] ?? null
  return null
}

/** Each changed file's section of a unified diff, from its `diff --git` line to the next one. */
export function splitPatch(patch: string): Map<string, string> {
  const sections = new Map<string, string>()
  let path: string | null = null
  let lines: string[] = []
  const flush = () => {
    if (path !== null) sections.set(path, `${lines.join('\n')}\n`)
  }
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header !== null) {
      flush()
      path = header[2] ?? null
      lines = [line]
      continue
    }
    if (path !== null) lines.push(line)
  }
  flush()
  return sections
}

/** The index entries, in the order of `changed`, from the patch alone. */
export function indexEntries(patch: string, changed: string[]): IndexEntry[] {
  const sections = splitPatch(patch)
  return changed.map((path) => {
    const section = sections.get(path) ?? ''
    let additions = 0
    let deletions = 0
    const symbols: string[] = []
    const seen = new Set<string>()
    const add = (symbol: string | null) => {
      if (symbol === null || seen.has(symbol)) return
      seen.add(symbol)
      symbols.push(symbol)
    }
    for (const line of section.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/)
      if (hunk !== null) {
        add(symbolOf(hunk[1] ?? '', { nested: true }))
        continue
      }
      if (line.startsWith('+')) {
        additions += 1
        add(symbolOf(line.slice(1)))
      } else if (line.startsWith('-')) {
        deletions += 1
        add(symbolOf(line.slice(1)))
      }
    }
    return { path, additions, deletions, area: areaOf(path), symbols: symbols.slice(0, MAX_SYMBOLS_PER_FILE), moreSymbols: Math.max(0, symbols.length - MAX_SYMBOLS_PER_FILE) }
  })
}

/** One index line: path, counts, area, symbols. Never a hunk line: it starts with a list dash and a space. */
export function renderIndexEntry(entry: IndexEntry): string {
  const symbols = entry.symbols.length === 0 ? '' : ` · ${entry.symbols.join(', ')}${entry.moreSymbols > 0 ? ` (+${entry.moreSymbols} more)` : ''}`
  return `- \`${entry.path}\` +${entry.additions}/-${entry.deletions} · ${entry.area}${symbols}`
}

const AREA_LEGEND =
  'Area tags: api (routes and the API layer), db-migration (schema and migrations), web-ui (web pages and components), mobile (the mobile app), lib (shared logic), test (unit and integration tests), e2e (browser tests), docs, config (manifests, lockfiles, settings), infra (deployment).'

/** Build the packet. Deterministic: the same input is the same string, which is what makes it a cache prefix. */
export function buildPacket(input: PacketInput): Packet {
  const entries = indexEntries(input.patch, input.changed)
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0)
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0)
  const areas: Partial<Record<Area, number>> = {}
  for (const entry of entries) areas[entry.area] = (areas[entry.area] ?? 0) + 1

  const head = [
    `# Review packet: ${input.label}`,
    '',
    `This packet was built once, before round 1, and every seat and Quinn get the same one. It is an index of the change, not the change: the pull request, the required reading, and one line per changed file with its path, its added and deleted lines, an area tag, and the symbols its hunks touch. No diff hunks and no file bodies are here. Choose the files your lens needs from the index, fetch their hunks with one \`read_diff(paths)\` call and the surrounding code with one \`read_files(paths)\` call, and do not fetch what you will not review: what you fetch lives in your own context only.`,
    '',
  ]
  const sections: string[] = []
  if (input.required !== null && input.required.trim() !== '') sections.push(`## Required reading\n\n${input.required.trim()}\n`)
  sections.push(`## Pull request\n\n${input.description.trim() === '' ? '_No description._' : input.description.trim()}\n`)
  if (input.previousFindings !== undefined && input.previousFindings !== null) {
    sections.push(`## Previous findings\n\nThe fix list of the previous review of this change. This is a re-review: the diff is only what changed since, and these are what it has to answer.\n\n${input.previousFindings.trim()}\n`)
  }
  const areaCounts = Object.entries(areas)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, count]) => `${area} ${count}`)
    .join(', ')
  sections.push(
    `## Changed files (${num(entries.length)} file${entries.length === 1 ? '' : 's'}, +${num(additions)}/-${num(deletions)}; ${areaCounts})\n\n${AREA_LEGEND}\n\nOne line per file: path, added/deleted lines, area, then the symbols the hunks touch (declarations and route names; up to ${MAX_SYMBOLS_PER_FILE}).\n\n${entries.map(renderIndexEntry).join('\n')}\n`,
  )

  const text = `${head.join('\n')}\n${sections.join('\n')}`
  return { text, chars: text.length, tokens: packetTokens(text.length), files: entries.length, areas }
}

const splitLines = (content: string): string[] => {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** `  12 | code`, right-aligned to the widest line number in the file. */
export function numberLines(lines: string[], start: number, width: number): string {
  return lines.map((line, i) => `${String(start + i).padStart(width)} | ${line}`).join('\n') + (lines.length > 0 ? '\n' : '')
}

/**
 * One file as read_files returns it: numbered, and cut at a line boundary past the cap with a
 * pointer, so a seat never pastes 200k characters into its context by accident.
 */
export function truncateForRead(content: string, maxChars: number = MAX_FULL_FILE_CHARS): { text: string; lines: number; truncated: boolean } {
  const lines = splitLines(content)
  const width = String(lines.length).length
  const whole = numberLines(lines, 1, width)
  if (whole.length <= maxChars) return { text: whole, lines: lines.length, truncated: false }
  const cut = whole.slice(0, maxChars)
  const kept = cut.slice(0, cut.lastIndexOf('\n') + 1)
  return {
    text: `${kept}… truncated at ${num(kept.length)} characters; the file has ${num(lines.length)} lines. Use search to find the lines you need, then read_file for that range.\n`,
    lines: lines.length,
    truncated: true,
  }
}

export type DiffRead = { path: string; hunks?: string; truncated?: boolean; error?: string }

/**
 * What read_diff returns: each requested file's section of the patch, cut at a line boundary
 * past the cap with a pointer. A path the diff does not change says so, with the hint a seat
 * needs: the index names the paths it can ask for.
 */
export function hunksFor(patch: string, paths: string[], maxChars: number = MAX_FULL_FILE_CHARS): DiffRead[] {
  const sections = splitPatch(patch)
  return paths.map((path) => {
    const section = sections.get(path)
    if (section === undefined) return { path, error: `not in the diff: ${path}. The index in the packet lists every changed path; copy one from there.` }
    if (section.length <= maxChars) return { path, hunks: section, truncated: false }
    const cut = section.slice(0, maxChars)
    const kept = cut.slice(0, cut.lastIndexOf('\n') + 1)
    return { path, hunks: `${kept}… truncated at ${num(kept.length)} of ${num(section.length)} characters of this file's hunks. read_files the file at HEAD for the rest, or search within it.\n`, truncated: true }
  })
}
