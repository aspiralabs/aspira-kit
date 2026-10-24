// The git operations the kit needs, each run as `git -C <dir> ...` and returned as a typed result
// instead of throwing. Porcelain output is parsed by its documented line grammar.
import { spawnSync } from 'node:child_process'

export type GitResult = { status: number; stdout: string; stderr: string }

export type Worktree = { path: string; head: string | undefined; branch: string | undefined; locked: boolean; bare: boolean; detached: boolean }

/** Run `git -C <dir> <args>`. A git that cannot start reports status -1 with the error in stderr. */
export function git(dir: string, args: readonly string[]): GitResult {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (run.error !== undefined) return { status: -1, stdout: '', stderr: run.error.message }
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr }
}

/** The top level of the working tree that holds `dir`; undefined outside a git repository. */
export function repositoryRoot(dir: string): string | undefined {
  const run = git(dir, ['rev-parse', '--show-toplevel'])
  const root = run.stdout.trim()
  return run.status === 0 && root !== '' ? root : undefined
}

/**
 * `git worktree list --porcelain`: one record per worktree, records separated by a blank line, each
 * starting `worktree <path>` followed by `HEAD <sha>`, `branch <ref>`, `detached`, `bare` and
 * `locked [<reason>]` lines. Unknown lines are skipped.
 */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = []
  let current: Worktree | undefined
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: undefined, branch: undefined, locked: false, bare: false, detached: false }
      worktrees.push(current)
      continue
    }
    if (current === undefined || line === '') continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true
    else if (line === 'bare') current.bare = true
    else if (line === 'detached') current.detached = true
  }
  return worktrees
}

/** Every worktree of the repository that holds `dir`, the main checkout first; undefined outside a git repository. */
export function listWorktrees(dir: string): Worktree[] | undefined {
  const run = git(dir, ['worktree', 'list', '--porcelain'])
  return run.status === 0 ? parseWorktreeList(run.stdout) : undefined
}

/** The main checkout's root (the first entry of the worktree list), from any of its worktrees; undefined outside a git repository. */
export function mainCheckoutRoot(dir: string): string | undefined {
  return listWorktrees(dir)?.[0]?.path
}

/** Whether `path` is ignored by the repository at `dir`'s ignore rules, whether or not it is tracked. */
export function isGitIgnored(dir: string, path: string): boolean {
  return git(dir, ['check-ignore', '-q', '--no-index', '--', path]).status === 0
}
