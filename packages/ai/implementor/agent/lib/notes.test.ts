import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { NOTES_HEADER, bestRename, checkNotes, deleteNotesFile, identifiersIn, notesFilesIn, repoSearcher, rewriteNotes, rewriteNotesFile, searchTerm, staleIdentifiers } from './notes.ts'

const exec = promisify(execFile)
const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('identifiersIn', () => {
  it('takes the backticked tokens once each and searches by the leading name of a signature', () => {
    const notes = 'Lane A exports `priceTotal(items: Item[]): number` from `src/price.ts`. Lane B reads `priceTotal`; pass `--serial` to skip. Not a ``.'
    expect(identifiersIn(notes)).toEqual(['priceTotal(items: Item[]): number', 'src/price.ts', 'priceTotal', '--serial'])
    expect(searchTerm('priceTotal(items: Item[]): number')).toBe('priceTotal')
    expect(searchTerm('src/price.ts')).toBe('src/price.ts')
    expect(searchTerm('--serial')).toBe('--serial')
    expect(searchTerm('Badge<Props>')).toBe('Badge')
  })
})

describe('bestRename', () => {
  it('picks the candidate that shares the most of the old name, and nothing when none is close', () => {
    expect(bestRename('getPriceTotal', ['computePriceTotal', 'price', 'getItems', 'total'])).toBe('computePriceTotal')
    expect(bestRename('cartBadge', ['priceTotal', 'cart'])).toBeNull()
    expect(bestRename('src/price.ts', ['src/pricing.ts', 'src/badge.ts'])).toBe('src/pricing.ts')
    expect(bestRename('priceTotal', ['priceTotal'])).toBeNull()
  })
})

describe('rewriteNotes', () => {
  it('corrects a renamed identifier, removes the sentence of a missing one, drops an emptied line and writes the header once', () => {
    const notes = `${NOTES_HEADER('0'.repeat(40), '2026-01-01T00:00:00.000Z')}\n# Handoff\n\nLane A exports \`getPriceTotal\` from \`src/price.ts\`. Lane B reads \`cartBadge\` for the count. Keep \`--serial\` off.\n- \`cartBadge\` is memoized.\n- \`src/price.ts\` stays pure.\n`
    const findings = new Map<string, { status: 'found' } | { status: 'renamed'; to: string } | { status: 'missing' }>([
      ['getPriceTotal', { status: 'renamed', to: 'computePriceTotal' }],
      ['src/price.ts', { status: 'found' }],
      ['cartBadge', { status: 'missing' }],
      ['--serial', { status: 'found' }],
    ])
    const result = rewriteNotes(notes, findings, { sha: 'a'.repeat(40), at: '2026-10-06T00:00:00.000Z' })
    expect(result.text).toBe(`${NOTES_HEADER('a'.repeat(40), '2026-10-06T00:00:00.000Z')}\n# Handoff\n\nLane A exports \`computePriceTotal\` from \`src/price.ts\`. Keep \`--serial\` off.\n- \`src/price.ts\` stays pure.\n`)
    expect(result.corrected).toEqual([{ from: 'getPriceTotal', to: 'computePriceTotal' }])
    expect(result.removed).toEqual(['cartBadge'])
    expect(result.text.match(/Rewritten from the code at verification/g)).toHaveLength(1)
  })
})

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-notes-')))
  temps.push(dir)
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'feat/cart', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'src/price.ts'), 'export function computePriceTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n')
  await writeFile(join(repo, 'src/cli.ts'), "const serial = process.argv.includes('--serial')\nexport { serial }\n")
  await git('add', '.')
  await git('commit', '-qm', 'init')
  const sha = (await git('rev-parse', 'HEAD')).stdout.trim()
  return { dir, repo, git, sha }
}

describe('notes on a repository', () => {
  it('checks each identifier with git grep, finds the renamed one and reports the missing one', async () => {
    const { repo } = await fixture()
    const notes = 'Lane A exports `getPriceTotal(items: number[]): number` from `src/price.ts`. Lane B reads `cartBadge`. Pass `--serial`.'
    const findings = await checkNotes(notes, repoSearcher(repo))
    expect(findings.get('getPriceTotal(items: number[]): number')).toEqual({ status: 'renamed', to: 'computePriceTotal' })
    expect(findings.get('src/price.ts')).toEqual({ status: 'found' })
    expect(findings.get('cartBadge')).toEqual({ status: 'missing' })
    expect(findings.get('--serial')).toEqual({ status: 'found' })
    expect(await staleIdentifiers(notes, repoSearcher(repo))).toEqual(['getPriceTotal(items: number[]): number', 'cartBadge'])
  })

  it('rewrites a notes file in place with the SHA header, and reports a deleted one as deleted', async () => {
    const { dir, repo, sha } = await fixture()
    const work = join(dir, 'work')
    await mkdir(join(work, 'trace'), { recursive: true })
    await mkdir(join(work, 'implementation.local'), { recursive: true })
    const notes = join(work, 'handoff-notes.md')
    await writeFile(notes, '# Handoff\n\nLane A exports `getPriceTotal` from `src/price.ts`. Lane B reads `cartBadge`.\n')
    await writeFile(join(work, 'lane-notes.md'), '# Lane B notes\n')
    await writeFile(join(work, 'implementation.md'), '# Implementation\n')
    await writeFile(join(work, 'trace/notes.md'), 'not a notes file: trace output\n')
    await writeFile(join(work, 'implementation.local/handoff-notes.md'), 'not a notes file: run state\n')
    expect(await notesFilesIn(work, { exclude: ['implementation.local'] })).toEqual([notes, join(work, 'lane-notes.md')])

    const result = await rewriteNotesFile({ repo, file: notes, sha, now: () => new Date('2026-10-06T00:00:00.000Z') })
    expect(result).toEqual({ file: notes, action: 'rewritten', corrected: [{ from: 'getPriceTotal', to: 'computePriceTotal' }], removed: ['cartBadge'] })
    const text = await readFile(notes, 'utf8')
    expect(text.startsWith(`<!-- Rewritten from the code at verification · commit ${sha} · 2026-10-06T00:00:00.000Z -->\n`)).toBe(true)
    expect(text).toContain('`computePriceTotal`')
    expect(text).not.toContain('cartBadge')
    expect(await staleIdentifiers(text, repoSearcher(repo))).toEqual([])
    // A second rewrite replaces the header instead of stacking one.
    await rewriteNotesFile({ repo, file: notes, sha, now: () => new Date('2026-10-07T00:00:00.000Z') })
    expect((await readFile(notes, 'utf8')).match(/Rewritten from the code/g)).toHaveLength(1)

    expect(await deleteNotesFile(join(work, 'lane-notes.md'))).toEqual({ file: join(work, 'lane-notes.md'), action: 'deleted' })
    expect(await notesFilesIn(work, { exclude: ['implementation.local'] })).toEqual([notes])
  })
})
