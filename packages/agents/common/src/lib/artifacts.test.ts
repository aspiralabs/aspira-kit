import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeArtifacts } from './artifacts'

// The file system is the boundary: every case writes real folders under a temp directory.

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'artifacts-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const GROOM = { marker: 'trace/groom.json' }

describe('writeArtifacts with an own-directory marker', () => {
  it('replaces a folder holding the marker it is given and archives the previous run under trace/history/run-*', async () => {
    const output = join(root, 'groom')
    await writeArtifacts(output, { 'trace/groom.json': '{"round":1}\n', 'run-analysis.md': 'first run\n' }, undefined, GROOM)
    await writeArtifacts(output, { 'trace/groom.json': '{"round":2}\n', 'run-analysis.md': 'second run\n' }, undefined, GROOM)
    expect(await readFile(join(output, 'trace/groom.json'), 'utf8')).toBe('{"round":2}\n')
    const runs = (await readdir(join(output, 'trace/history'))).filter((name) => name.startsWith('run-'))
    expect(runs).toHaveLength(1)
    expect(await readFile(join(output, 'trace/history', runs[0]!, 'trace/groom.json'), 'utf8')).toBe('{"round":1}\n')
    expect(await readFile(join(output, 'trace/history', runs[0]!, 'run-analysis.md'), 'utf8')).toBe('first run\n')
  })

  it('refuses a folder without that marker and leaves it as it was', async () => {
    const output = join(root, 'groom')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'notes.md'), 'a person\'s notes\n')
    await expect(writeArtifacts(output, { 'trace/groom.json': '{}\n' }, undefined, GROOM)).rejects.toThrow('Refusing to replace a directory without trace/groom.json')
    expect(await readdir(output)).toEqual(['notes.md'])
  })

  it('the default marker still refuses a folder that holds only trace/groom.json', async () => {
    const output = join(root, 'review')
    await mkdir(join(output, 'trace'), { recursive: true })
    await writeFile(join(output, 'trace/groom.json'), '{}\n')
    await expect(writeArtifacts(output, { 'trace/review.json': '{}\n' })).rejects.toThrow('Refusing to replace a directory without trace/review.json')
  })
})
