// The review packet: everything a seat needs about the changed files, built once by load-pr
// (or the --local driver) and put at the start of every prompt, so the seats stop reading
// changed files one call at a time and every call shares one cache prefix. Pure: no eve, no
// node imports, so it is tested on a fixture.

/** A changed file longer than this goes in as its changed hunks with context, not in full. */
export const MAX_FULL_FILE_CHARS = 40_000
/** Lines of context around each changed hunk of a large file. */
export const HUNK_CONTEXT_LINES = 60
/**
 * The packet as a whole is capped too: past this, changed files are listed with a pointer
 * instead of their text. Roughly 100k tokens, so the prompt leaves room for the review.
 */
export const MAX_PACKET_CHARS = 400_000

export type PacketInput = {
  label: string
  /** pr.md as the seats read it: title, base and head, description, changed paths. */
  description: string
  patch: string
  changed: string[]
  /** Each changed path's content at HEAD; null when the file is gone or unreadable. */
  files: Map<string, string | null>
  /** REQUIRED.md from the knowledge folder, or null when the guidelines were not loaded. */
  required: string | null
  /** A re-review: the previous findings.md, which the seats rule on against the delta. */
  previousFindings?: string | null
  maxChars?: number
}

export type PacketStats = {
  chars: number
  /** chars / 4: an estimate, since the packet is sent to two model families. */
  tokens: number
  /** Changed files included in full. */
  full: string[]
  /** Changed files over the size cap, included as their changed hunks with context. */
  excerpted: string[]
  /** Changed files past the packet cap, listed with a pointer only. */
  omitted: string[]
  /** Changed paths with no content at HEAD: deleted, or unreadable. */
  missing: string[]
}

export type Packet = PacketStats & { text: string }

export type LineRange = { start: number; end: number }

export const packetTokens = (chars: number): number => Math.ceil(chars / 4)

const num = (n: number): string => n.toLocaleString('en-US')

/** The new-file line ranges of every hunk that touches `path`, in patch order. */
export function hunkRanges(patch: string, path: string): LineRange[] {
  const ranges: LineRange[] = []
  let inFile = false
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header !== null) {
      inFile = header[2] === path
      continue
    }
    if (!inFile) continue
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk?.[1] === undefined) continue
    const start = Number.parseInt(hunk[1], 10)
    const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10)
    // A pure deletion has a zero-length new range; show the line it now sits before.
    ranges.push({ start, end: start + Math.max(count, 1) - 1 })
  }
  return ranges
}

/** `start..end` widened by `context` lines each side, clamped to the file, and merged where they touch. */
export function widenRanges(ranges: LineRange[], context: number, lineCount: number): LineRange[] {
  const widened = ranges
    .map(({ start, end }) => ({ start: Math.max(1, start - context), end: Math.min(lineCount, end + context) }))
    .filter(({ start, end }) => start <= end)
    .toSorted((a, b) => a.start - b.start)
  const merged: LineRange[] = []
  for (const range of widened) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
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

/** The lines in `ranges`, numbered, with a marker for every gap. */
export function excerpt(content: string, ranges: LineRange[]): string {
  const lines = splitLines(content)
  const width = String(lines.length).length
  const parts: string[] = []
  let cursor = 1
  for (const { start, end } of ranges) {
    if (start > cursor) parts.push(`… lines ${num(cursor)}–${num(start - 1)} not shown …\n`)
    parts.push(numberLines(lines.slice(start - 1, end), start, width))
    cursor = end + 1
  }
  if (cursor <= lines.length) parts.push(`… lines ${num(cursor)}–${num(lines.length)} not shown …\n`)
  return parts.join('')
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

/** Build the packet. Deterministic: the same input is the same string, which is what makes it a cache prefix. */
export function buildPacket(input: PacketInput): Packet {
  const maxChars = input.maxChars ?? MAX_PACKET_CHARS
  const full: string[] = []
  const excerpted: string[] = []
  const omitted: string[] = []
  const missing: string[] = []

  const head = [
    `# Review packet: ${input.label}`,
    '',
    `This packet was built once, before round 1, and every seat and Quinn get the same one. It is complete for the changed files: the diff, every changed file at HEAD (a file over ${num(MAX_FULL_FILE_CHARS)} characters as its changed hunks with ${HUNK_CONTEXT_LINES} lines of context), the changed paths, the pull request, and the required reading. Do not read a changed file again; it is below. Reads are for unchanged files only: the code a changed file calls, the callers it has, the test beside it.`,
    '',
  ]
  const sections: string[] = []
  if (input.required !== null && input.required.trim() !== '') sections.push(`## Required reading\n\n${input.required.trim()}\n`)
  sections.push(`## Pull request\n\n${input.description.trim() === '' ? '_No description._' : input.description.trim()}\n`)
  if (input.previousFindings !== undefined && input.previousFindings !== null) {
    sections.push(`## Previous findings\n\nThe fix list of the previous review of this change. This is a re-review: the diff below is only what changed since, and these are what it has to answer.\n\n${input.previousFindings.trim()}\n`)
  }
  sections.push(`## Changed paths\n\n${input.changed.map((path) => `- \`${path}\``).join('\n')}\n`)
  sections.push(`## Diff\n\n\`\`\`diff\n${input.patch.trim()}\n\`\`\`\n`)

  const fileSections: string[] = []
  const pointers: string[] = []
  let used = head.join('\n').length + sections.join('\n').length
  for (const path of input.changed) {
    const content = input.files.get(path) ?? null
    if (content === null) {
      missing.push(path)
      fileSections.push(`### ${path}\n\nDeleted by this change, or not readable at HEAD. The diff above is all there is.\n`)
      continue
    }
    const lines = splitLines(content)
    let section: string
    let kind: 'full' | 'excerpted'
    if (content.length <= MAX_FULL_FILE_CHARS) {
      kind = 'full'
      section = `### ${path} (${num(lines.length)} line${lines.length === 1 ? '' : 's'})\n\n\`\`\`\n${numberLines(lines, 1, String(lines.length).length)}\`\`\`\n`
    } else {
      kind = 'excerpted'
      const ranges = widenRanges(hunkRanges(input.patch, path), HUNK_CONTEXT_LINES, lines.length)
      section = `### ${path} (${num(lines.length)} lines, ${num(content.length)} characters: the changed hunks with ${HUNK_CONTEXT_LINES} lines of context; read_files for the rest)\n\n\`\`\`\n${excerpt(content, ranges)}\`\`\`\n`
    }
    if (used + section.length > maxChars) {
      omitted.push(path)
      pointers.push(`- \`${path}\` (${num(lines.length)} lines)`)
      continue
    }
    used += section.length
    if (kind === 'full') full.push(path)
    else excerpted.push(path)
    fileSections.push(section)
  }
  sections.push(`## Changed files at HEAD\n\n${fileSections.join('\n')}`)
  if (pointers.length > 0) {
    sections.push(`## Not in the packet\n\nThese changed files did not fit the ${num(maxChars)}-character packet cap. Their diff is above; read them with read_files when a finding needs the surrounding code.\n\n${pointers.join('\n')}\n`)
  }

  const text = `${head.join('\n')}\n${sections.join('\n')}`
  return { text, chars: text.length, tokens: packetTokens(text.length), full, excerpted, omitted, missing }
}
