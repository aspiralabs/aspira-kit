import { describe, expect, it } from 'vitest'
import { formatSearchOutput, searchCommand } from './search.ts'

describe('searchCommand', () => {
  it('greps the tree with two lines of context, skipping build output, and treats no match as success', () => {
    const command = searchCommand("it's", ['*.ts', '*.tsx'], '/workspace/repo')
    expect(command).toBe(`cd '/workspace/repo' && grep -rnI -E -C 2 --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=.output --exclude-dir=.turbo --exclude-dir=coverage --exclude-dir=.work --exclude-dir=.eve --include='*.ts' --include='*.tsx' -e 'it'\\''s' . ; test $? -le 1`)
    expect(searchCommand('x', undefined, '/r')).not.toContain('--include')
  })
})

describe('formatSearchOutput', () => {
  it('drops the ./ prefix and says when nothing matched', () => {
    expect(formatSearchOutput('./a.ts:3:foo\n./a.ts-4-bar\n')).toEqual({ text: 'a.ts:3:foo\na.ts-4-bar\n', truncated: false, empty: false })
    expect(formatSearchOutput('')).toEqual({ text: 'No matches.', truncated: false, empty: true })
  })
  it('cuts past the cap at a line boundary with a pointer', () => {
    const out = formatSearchOutput(Array.from({ length: 100 }, (_, i) => `./f.ts:${i}:match`).join('\n'), 200)
    expect(out.truncated).toBe(true)
    expect(out.text.endsWith('… cut at 200 characters. Narrow the pattern or add globs.\n')).toBe(true)
    expect(out.text.length).toBeLessThan(300)
  })
})
