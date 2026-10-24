// The run's external operations, one function per operation (TEST-007): each runs git or gh with
// an argument array (never a shell string) in the project checkout and returns what the command
// did as { code, stdout, stderr }. Nothing here throws on a failed command; a missing binary comes
// back as code 127 with the spawn error in stderr, so the caller can record the command and its
// error and stop (F33). No function here ever passes a force flag to git push (F24), and none
// removes a worktree (F50).
//
// The phases take a `System` so a caller can stand in for the boundary; the tests use the real
// `system` below against a temp repository with a fake gh on PATH.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PrChecks } from '@aspiralabs/ai/common/lib/pr-step'

export type CommandResult = { code: number; stdout: string; stderr: string }
/** Where a command runs: the checkout, and the environment whose PATH finds git and gh. */
export type SystemOptions = { cwd: string; env: NodeJS.ProcessEnv }

/** A missing binary exits like a shell would: 127, naming the spawn error. */
const NOT_FOUND = 127

/** Run one command with an argument array; never throws for a non-zero exit or a missing binary. */
function run(command: string, args: readonly string[], options: SystemOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd: options.cwd, env: options.env, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr })
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
      if (code === 'ENOENT') return resolve({ code: NOT_FOUND, stdout: '', stderr: `spawn ${command} ENOENT: ${command} is not installed or not on PATH` })
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })
}

/** A command line as it is shown in the Build Summary. */
export const shown = (command: string, args: readonly string[]): string => [command, ...args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))].join(' ')

/** A branch name the run creates a worktree on: never an option or a refspec. */
function assertPlainBranch(branch: string): void {
  if (branch === '' || branch.startsWith('-') || branch.startsWith('+') || branch.includes(':') || /\s/.test(branch)) throw new Error(`"${branch}" is not a branch name the run works on`)
}

export const GIT_ARGS = {
  currentBranch: ['rev-parse', '--abbrev-ref', 'HEAD'],
  head: ['rev-parse', 'HEAD'],
  remoteUrl: ['config', '--get', 'remote.origin.url'],
  status: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  /** F50: the push is always from the ticket's worktree, of HEAD, after the guard checked HEAD's branch. */
  push: ['push', '-u', 'origin', 'HEAD'],
  toplevel: ['rev-parse', '--show-toplevel'],
  commonDir: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  fetchMain: ['fetch', 'origin', 'main'],
  branchExists: (branch: string) => ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
  /** GIT-002: a new branch from origin/main, or (when the branch already exists) that branch. */
  worktreeAdd: (path: string, branch: string, create: boolean) => (create ? ['worktree', 'add', '-b', branch, path, 'origin/main'] : ['worktree', 'add', path, branch]),
  checkIgnore: (path: string) => ['check-ignore', '-q', '--no-index', path],
  /** A file as it is at `rev` (path from the repository root). */
  show: (rev: string, path: string) => ['show', `${rev}:${path}`],
} as const

/** The F24 fields the shared PR check (agent-common's checkPr) reads: open, same repository, on the ticket's branch, based on main, at HEAD. */
const PR_VIEW_FIELDS = 'url,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,baseRefName'

export const GH_ARGS = {
  prList: (branch: string) => ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty'],
  prCreate: (input: PrCreateInput) => ['pr', 'create', '--draft', '--base', input.base, '--head', input.head, '--title', input.title, '--body-file', input.bodyFile],
  prEdit: (url: string, bodyFile: string) => ['pr', 'edit', url, '--body-file', bodyFile],
  prReady: (url: string) => ['pr', 'ready', url],
  prView: (url: string) => ['pr', 'view', url, '--json', PR_VIEW_FIELDS],
} as const

export type PrCreateInput = { base: string; head: string; title: string; bodyFile: string }

/** The branch HEAD is on (`HEAD` when detached). */
export const gitCurrentBranch = (options: SystemOptions) => run('git', GIT_ARGS.currentBranch, options)
/** The commit HEAD points at. */
export const gitHead = (options: SystemOptions) => run('git', GIT_ARGS.head, options)
/** `git config user.name` as the checkout resolves it (the repo's config, else the user's). */
export const gitUserName = (options: SystemOptions) => run('git', ['config', 'user.name'], options)
/** origin's URL as configured. */
export const gitRemoteUrl = (options: SystemOptions) => run('git', GIT_ARGS.remoteUrl, options)
/** The working tree's changes, NUL-separated porcelain v1 with every untracked file listed. */
export const gitStatus = (options: SystemOptions) => run('git', GIT_ARGS.status, options)

/** Stage exactly `paths` and commit only them with `message`. */
export async function gitCommit(options: SystemOptions, paths: readonly string[], message: string): Promise<CommandResult> {
  if (paths.length === 0) throw new Error('gitCommit needs at least one path')
  const added = await run('git', ['add', '-A', '--', ...paths], options)
  if (added.code !== 0) return added
  return run('git', ['commit', '-m', message, '--', ...paths], options)
}

/** `git push -u origin HEAD` from the worktree: never forced. */
export const gitPush = (options: SystemOptions) => run('git', GIT_ARGS.push, options)

/** The top of the working tree the command runs in (a worktree's own root inside a worktree). */
export const gitToplevel = (options: SystemOptions) => run('git', GIT_ARGS.toplevel, options)
/** The main repository's .git directory, absolute, from the checkout or any of its worktrees. */
export const gitCommonDir = (options: SystemOptions) => run('git', GIT_ARGS.commonDir, options)
/** `git fetch origin main`, so a new worktree starts from the current origin/main. */
export const gitFetchMain = (options: SystemOptions) => run('git', GIT_ARGS.fetchMain, options)
/** Exit 0 when the local branch exists. */
export const gitBranchExists = (options: SystemOptions, branch: string) => run('git', GIT_ARGS.branchExists(branch), options)
/** `git worktree add` (GIT-002). The run never removes a worktree. */
export function gitWorktreeAdd(options: SystemOptions, path: string, branch: string, create: boolean): Promise<CommandResult> {
  assertPlainBranch(branch)
  return run('git', GIT_ARGS.worktreeAdd(path, branch, create), options)
}
/** Exit 0 when `path` is gitignored (by the files, not the index). */
export const gitCheckIgnore = (options: SystemOptions, path: string) => run('git', GIT_ARGS.checkIgnore(path), options)
/** A file's contents at `rev`; non-zero when the revision or the file is not there. */
export const gitShowFile = (options: SystemOptions, rev: string, path: string) => run('git', GIT_ARGS.show(rev, path), options)
/** A project command such as `pnpm install` (the worktree's install and build). */
export const projectCommand = (options: SystemOptions, command: string, args: readonly string[]) => run(command, args, options)

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

/** The package manager one directory's lock files name, or null when it has none. */
function packageManagerIn(dir: string): PackageManager | null {
  const has = (name: string) => existsSync(join(dir, name))
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  return null
}

/** The package manager a project uses: the first of `dirs` (the app's, then the repository's) with a lock file decides; npm when none has one. */
export function packageManagerOf(dirs: readonly string[]): PackageManager {
  for (const dir of dirs) {
    const manager = packageManagerIn(dir)
    if (manager !== null) return manager
  }
  return 'npm'
}

/** The URL of an open PR whose head is `branch`, or empty stdout when there is none. */
export const ghPrList = (options: SystemOptions, branch: string) => run('gh', GH_ARGS.prList(branch), options)
/** Open a draft PR; stdout ends with its URL. */
export const ghPrCreate = (options: SystemOptions, input: PrCreateInput) => run('gh', GH_ARGS.prCreate(input), options)
/** Replace a PR's description with the file's contents. */
export const ghPrEdit = (options: SystemOptions, url: string, bodyFile: string) => run('gh', GH_ARGS.prEdit(url, bodyFile), options)
/** Mark a draft PR ready for review. */
export const ghPrReady = (options: SystemOptions, url: string) => run('gh', GH_ARGS.prReady(url), options)
/** A PR's full F24 fields as gh reads them back. */
export const ghPrView = (options: SystemOptions, url: string) => run('gh', GH_ARGS.prView(url), options)

/** The boundary agent-common's shared `checkPr`/`prStep` run through (TEST-007): built from this
 * module's own git/gh functions, so step8.ts calls the agent-common helper through the same
 * boundary its tests already stand in for. */
export const prChecks: PrChecks = {
  ghPrView,
  gitHead,
  gitStatus,
  gitRemoteUrl,
}

/** One changed path from `git status --porcelain=v1 -z`: untracked, or a change to a tracked file. */
export type StatusEntry = { path: string; untracked: boolean }

/** The entries of NUL-separated porcelain v1 output; a rename's old path is skipped. */
export function parseStatus(stdout: string): StatusEntry[] {
  const fields = stdout.split('\0')
  const entries: StatusEntry[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    entries.push({ path: field.slice(3), untracked: xy === '??' })
    if (xy.includes('R') || xy.includes('C')) index += 1
  }
  return entries
}

/** Every external operation, so a phase can be handed a stand-in for the boundary. */
export const system = {
  gitCurrentBranch,
  gitHead,
  gitUserName,
  gitRemoteUrl,
  gitStatus,
  gitCommit,
  gitPush,
  gitToplevel,
  gitCommonDir,
  gitFetchMain,
  gitBranchExists,
  gitWorktreeAdd,
  gitCheckIgnore,
  gitShowFile,
  projectCommand,
  ghPrList,
  ghPrCreate,
  ghPrEdit,
  ghPrReady,
  ghPrView,
}
export type System = typeof system
