import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { branchName, cloneCommand, parseRepo, pushCommand, pushGuard, redact } from './github.ts'

const exec = promisify(execFile)

describe('parseRepo', () => {
  it('accepts GitHub URLs, git@ URLs and owner/name', () => {
    for (const input of ['https://github.com/aspiralabs/kit', 'https://github.com/aspiralabs/kit.git', 'git@github.com:aspiralabs/kit.git', ' aspiralabs/kit ']) {
      expect(parseRepo(input)).toEqual({ owner: 'aspiralabs', name: 'kit', url: 'https://github.com/aspiralabs/kit.git', label: 'aspiralabs/kit' })
    }
  })
  it('rejects local paths and other hosts', () => {
    for (const input of ['/Users/me/repo', './repo', '../a/b', 'https://gitlab.com/a/b', 'kit']) expect(() => parseRepo(input)).toThrow('Not a GitHub repository')
  })
})

describe('branchName', () => {
  const now = new Date('2026-09-27T20:49:05.123Z')
  it('builds implement/<slug>-<timestamp>', () => {
    expect(branchName('My Recipes Library!', now)).toBe('implement/my-recipes-library-20260927-204905')
    expect(branchName(undefined, now)).toBe('implement/20260927-204905')
  })
})

describe('pushGuard', () => {
  it('pushes only the checked-out implement/ branch the checkout created', () => {
    expect(pushGuard('implement/x-1', 'implement/x-1')).toBeNull()
    expect(pushGuard('main', 'implement/x-1')).toContain('refusing to push')
    expect(pushGuard('main', 'main')).toContain('not under implement/')
  })
})

describe('token handling', () => {
  const repo = parseRepo('aspiralabs/kit')
  it('redacts the token from command output', () => {
    expect(redact(`fatal: https://x-access-token:tok3n@github.com/aspiralabs/kit.git`, 'tok3n')).not.toContain('tok3n')
    expect(pushCommand(repo, 'tok3n', 'implement/x')).toContain("'HEAD:refs/heads/implement/x'")
  })
  it('clones, strips the token from origin and checks out the new branch', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-clone-')))
    const origin = join(dir, 'origin')
    await exec('git', ['init', '-q', '-b', 'main', origin])
    await exec('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    // A file:// URL stands in for GitHub; the token-bearing URL is what cloneCommand would embed.
    const local = { ...repo, url: `file://${origin}` }
    const root = join(dir, 'repo with space')
    const { stdout } = await exec('bash', ['-c', cloneCommand(local, undefined, root, 'implement/x-1')])
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect((await exec('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('implement/x-1')
    const command = cloneCommand(repo, 'tok3n', '/workspace/repo', 'implement/x-1')
    expect(command).toContain('x-access-token:tok3n@')
    expect(command).toContain("git remote set-url origin 'https://github.com/aspiralabs/kit.git'")
    expect(await readFile(join(root, '.git/config'), 'utf8')).not.toContain('x-access-token')
  })
})
