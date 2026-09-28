import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { branchName, cloneCommand, parseSource, redact } from './source.ts'

const exec = promisify(execFile)

describe('parseSource', () => {
  it('classifies GitHub URLs and shorthand as remote', async () => {
    for (const input of ['https://github.com/aspiralabs/kit', 'https://github.com/aspiralabs/kit.git', 'git@github.com:aspiralabs/kit.git', 'aspiralabs/kit']) {
      const source = await parseSource(input, '/nonexistent')
      expect(source).toMatchObject({ kind: 'remote', owner: 'aspiralabs', name: 'kit', url: 'https://github.com/aspiralabs/kit.git' })
    }
  })
  it('resolves a local path to its git root and rejects non-repositories', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-source-')))
    await exec('git', ['init', '-q', dir])
    await exec('mkdir', ['-p', join(dir, 'packages/a')])
    expect(await parseSource(join(dir, 'packages/a'))).toEqual({ kind: 'local', root: dir })
    const plain = await mkdtemp(join(tmpdir(), 'sa-plain-'))
    await expect(parseSource(plain)).rejects.toThrow('Not a git repository')
    await expect(parseSource('./nope/x', dir)).rejects.toThrow('Not a directory or a GitHub repository')
  })
  it('builds a sandbox clone command with the token redactable and never a host path', async () => {
    const source = await parseSource('aspiralabs/kit', '/nonexistent')
    if (source.kind !== 'remote') throw new Error('expected remote')
    const command = cloneCommand(source, 'tok3n', '/workspace/repo', 'feat/x')
    expect(command).toContain("git clone --quiet --depth 50 --branch 'feat/x' 'https://x-access-token:tok3n@github.com/aspiralabs/kit.git' '/workspace/repo'")
    expect(redact(command, 'tok3n')).not.toContain('tok3n')
    expect(branchName(new Date('2026-09-27T20:15:30Z'))).toBe('static-analysis/20260927-201530')
  })
})
