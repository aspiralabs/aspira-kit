import { describe, expect, it } from 'vitest'
import { HUNK_CONTEXT_LINES, MAX_FULL_FILE_CHARS, buildPacket, hunkRanges, packetTokens, truncateForRead } from './packet.ts'
import { SEATS, openingPrompt, turnPrompt, verifyPrompt, type PrContext } from './review.ts'

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

// A fixture PR: one small file changed, one large file with two hunks far apart, one deleted file.
const SMALL = 'export const a = 2\nexport const b = 3\n'
const LARGE = lines(3000, 'const x =')
const PATCH = [
  'diff --git a/small.ts b/small.ts',
  '--- a/small.ts',
  '+++ b/small.ts',
  '@@ -1,2 +1,2 @@',
  '-export const a = 1',
  '+export const a = 2',
  ' export const b = 3',
  'diff --git a/big.ts b/big.ts',
  '--- a/big.ts',
  '+++ b/big.ts',
  '@@ -100,3 +100,4 @@',
  ' const x = 100',
  '+const x = 101',
  ' const x = 102',
  ' const x = 103',
  '@@ -2500,2 +2501,2 @@',
  '-const x = 2500',
  '+const x = 2500 // changed',
  ' const x = 2501',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export const gone = true',
  '',
].join('\n')
const CHANGED = ['small.ts', 'big.ts', 'gone.ts']
const REQUIRED = '# Agent Instructions\n\nREV-001 Read the rules.\n'

const fixture = () =>
  buildPacket({
    label: 'o/n#1',
    description: '# Change a\n\n- Base: main (abc1234)\n',
    patch: PATCH,
    changed: CHANGED,
    files: new Map([
      ['small.ts', SMALL],
      ['big.ts', LARGE],
      ['gone.ts', null],
    ]),
    required: REQUIRED,
  })

describe('hunkRanges', () => {
  it('reads the new-file line ranges of each hunk for one path', () => {
    expect(hunkRanges(PATCH, 'big.ts')).toEqual([
      { start: 100, end: 103 },
      { start: 2501, end: 2502 },
    ])
    expect(hunkRanges(PATCH, 'small.ts')).toEqual([{ start: 1, end: 2 }])
    expect(hunkRanges(PATCH, 'missing.ts')).toEqual([])
  })
})

describe('buildPacket', () => {
  it('holds the diff, every changed path, the description and the required reading', () => {
    const packet = fixture()
    expect(packet.text).toContain('# Review packet: o/n#1')
    expect(packet.text).toContain(REQUIRED.trim())
    expect(packet.text).toContain('# Change a')
    expect(packet.text).toContain('- `small.ts`\n- `big.ts`\n- `gone.ts`')
    expect(packet.text).toContain('+export const a = 2')
    expect(packet.chars).toBe(packet.text.length)
    expect(packet.tokens).toBe(packetTokens(packet.chars))
  })

  it('includes a small changed file in full, numbered, and a deleted one as deleted', () => {
    const packet = fixture()
    expect(packet.full).toEqual(['small.ts'])
    expect(packet.missing).toEqual(['gone.ts'])
    expect(packet.text).toContain('### small.ts (2 lines)')
    expect(packet.text).toContain('1 | export const a = 2\n')
    expect(packet.text).toContain('2 | export const b = 3\n')
    expect(packet.text).toContain('### gone.ts\n\nDeleted by this change')
  })

  it(`includes a file over ${MAX_FULL_FILE_CHARS} characters as its changed hunks with ${HUNK_CONTEXT_LINES} lines of context, a line count and a pointer`, () => {
    const packet = fixture()
    expect(LARGE.length).toBeGreaterThan(MAX_FULL_FILE_CHARS)
    expect(packet.excerpted).toEqual(['big.ts'])
    const section = packet.text.slice(packet.text.indexOf('### big.ts'))
    expect(section).toMatch(/^### big\.ts \(3,000 lines, [\d,]+ characters: the changed hunks with 60 lines of context; read_files for the rest\)/)
    // First hunk: lines 100–103 plus 60 either side.
    expect(section).toContain('40 | const x = 40\n')
    expect(section).toContain('163 | const x = 163\n')
    expect(section).not.toContain('39 | const x = 39\n')
    expect(section).not.toContain('164 | const x = 164\n')
    // Second hunk: lines 2501–2502 plus 60 either side.
    expect(section).toContain('2441 | const x = 2441\n')
    expect(section).toContain('2562 | const x = 2562\n')
    expect(section).not.toContain('2563 | const x = 2563\n')
    expect(section).toContain('… lines 164–2,440 not shown …')
    expect(section).toContain('… lines 2,563–3,000 not shown …')
  })

  it('says it is complete for changed files and that reads are for unchanged files', () => {
    expect(fixture().text).toContain('complete for the changed files')
    expect(fixture().text).toContain('unchanged files only')
  })

  it('points at files past the packet cap instead of inflating the prompt', () => {
    const packet = buildPacket({
      label: 'o/n#1',
      description: '',
      patch: PATCH,
      changed: CHANGED,
      files: new Map([
        ['small.ts', SMALL],
        ['big.ts', LARGE],
        ['gone.ts', null],
      ]),
      required: null,
      maxChars: 2000,
    })
    expect(packet.omitted).toEqual(['big.ts'])
    expect(packet.text).toContain('## Not in the packet')
    expect(packet.text).toContain('- `big.ts` (3,000 lines)')
    expect(packet.text).not.toContain('101 | const x = 101\n')
  })

  it('is one string shared by every seat prompt and by Quinn, at the start of each', () => {
    const packet = fixture()
    const pr: PrContext = { label: 'o/n#1', repoPath: '/workspace/repo', packet: packet.text }
    const prompts = [...SEATS.map((seat) => openingPrompt(seat, pr)), ...SEATS.map((seat) => turnPrompt(seat, 2, pr)), verifyPrompt(1, pr)]
    for (const prompt of prompts) {
      expect(prompt.startsWith(packet.text)).toBe(true)
      // The same object, not a copy: one cache prefix for every call that carries it.
      expect(prompt.slice(0, packet.text.length)).toBe(pr.packet)
    }
    expect(openingPrompt('ava', { ...pr, packet: null })).not.toContain('# Review packet')
  })
})

describe('truncateForRead', () => {
  it('returns a small file whole, numbered', () => {
    const read = truncateForRead(SMALL)
    expect(read).toEqual({ text: '1 | export const a = 2\n2 | export const b = 3\n', lines: 2, truncated: false })
  })

  it('cuts a large file at a line boundary with a pointer', () => {
    const read = truncateForRead(LARGE)
    expect(read.truncated).toBe(true)
    expect(read.lines).toBe(3000)
    expect(read.text.length).toBeLessThanOrEqual(MAX_FULL_FILE_CHARS + 200)
    expect(read.text).toMatch(/\n… truncated at [\d,]+ characters; the file has 3,000 lines\. Use search to find the lines you need, then read_file for that range\.\n$/)
    expect(read.text).not.toContain('3000 | ')
  })
})
