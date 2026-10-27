// A local review that cannot say what it reviews stops instead of producing an empty review (KIT-68 F8, T32).
// With pullRequest false the reviewer reads the ticket's worktree branch against the repos entry's base, so a base
// that does not exist or a branch with no commits beyond it must end the run naming both, not review nothing.
// Real git in a temp repository: resolveLocalBranch and localDiff are the local source's two steps.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { localDiff, resolveLocalBranch } from './local-source.ts'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], { encoding: 'utf8' }).trim()

/** A repository on main with one commit, plus `ticket/with-commit` one commit ahead and `ticket/empty` at main. */
function repository(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'local-source-base-')))
  temps.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  git(dir, 'branch', 'ticket/empty')
  git(dir, 'switch', '-q', '-c', 'ticket/with-commit')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'work')
  git(dir, 'switch', '-q', 'main')
  return dir
}

/** The local review source as the reviewer runs it: resolve the branch, then diff it. */
async function source(dir: string, branch: string, base: string) {
  const resolved = await resolveLocalBranch(dir, branch, base)
  return localDiff(resolved, [])
}

describe('T32 F8: a local review stops when it has nothing to review', () => {
  it('stops with a message naming the branch and the base when an explicit base does not exist', async () => {
    const dir = repository()
    const failure = await source(dir, 'ticket/with-commit', 'develop-missing').then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect({
      stopped: failure !== null,
      branch: failure?.includes('ticket/with-commit') ?? false,
      base: failure?.includes('develop-missing') ?? false,
      // The base does not exist: the message says so, not only that a merge base could not be computed.
      says: /does not exist|no such|not found|unknown/i.test(failure ?? ''),
    }).toEqual({ stopped: true, branch: true, base: true, says: true })
  })

  it('stops with a message naming the branch and the base when the branch has no commits beyond the base', async () => {
    const dir = repository()
    const outcome = await source(dir, 'ticket/empty', 'main').then(
      (diff) => ({ stopped: false as const, patch: diff.patch, changed: diff.changed }),
      (error: unknown) => ({ stopped: true as const, message: error instanceof Error ? error.message : String(error) }),
    )
    expect(outcome.stopped).toBe(true)
    const message = outcome.stopped ? outcome.message : ''
    expect({
      branch: message.includes('ticket/empty'),
      base: message.includes('main'),
      says: /no commits|nothing to review|empty|no changes/i.test(message),
    }).toEqual({ branch: true, base: true, says: true })
  })

  it('still reviews a branch that is ahead of its base (the default path)', async () => {
    const dir = repository()
    const diff = await source(dir, 'ticket/with-commit', 'main')
    expect(diff.changed).toEqual(['b.txt'])
  })
})
