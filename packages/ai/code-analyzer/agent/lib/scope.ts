// The scope of a ticket run (KIT-48): the files the branch changed, so auto-fix and the model fix
// stay inside the ticket's change and a diagnostic in a file the branch never touched is a note,
// never a fix or a reason to end the run incomplete. A run with no ticket, no base branch or no
// git history keeps the whole tree in scope, and says so.

import { relative, resolve } from 'node:path'
import { readEffectiveAspira } from '@aspiralabs/ai/common/lib/aspira-config'
import type { Diagnostic } from './diagnostics.ts'
import type { Executor } from './executor.ts'

/** The files in scope, relative to the analyzed directory, and the base they were diffed against. */
export type Scope = { base: string; files: string[] }

/** `git status --porcelain` entries that name a file still on disk (no deletions), root-relative. */
const statusPaths = (stdout: string): string[] =>
  stdout.split('\n').flatMap((line) => {
    if (line.length < 4) return []
    const code = line.slice(0, 2)
    if (code.includes('D')) return []
    const path = line.slice(3).trim()
    // A rename shows `old -> new`; the new path is the file on disk.
    return [path.includes(' -> ') ? path.split(' -> ').pop()! : path]
  })

/** The kit's own folders: the ticket's pulled pages, ticket worktrees and the codebase map are never in scope, so no fix rewrites them (KIT-72). */
const KIT_FOLDERS = /^(?:\.work|\.worktrees|\.codebase-map)\//

/** The analyzed directory's path under the git root, '' at the root. */
const prefixOf = (gitRoot: string, root: string): string => {
  const rel = relative(resolve(gitRoot), resolve(root))
  return rel === '' || rel.startsWith('..') ? '' : rel.replaceAll('\\', '/')
}

/** The base branch of the repos entry the analyzed directory belongs to (aspira.json `baseBranch`, KIT-68 A11); `main` anywhere else, or when it is not a plain branch name. */
function baseBranchOf(executor: Executor): string {
  if (executor.kind !== 'host') return 'main'
  try {
    const base = readEffectiveAspira(executor.root).config.baseBranch
    // The name reaches `bash -c`: anything but a plain branch name falls back to main (review AVA1.1).
    return typeof base === 'string' && /^[A-Za-z0-9._/-]+$/.test(base) && !base.startsWith('-') && !base.includes('..') ? base : 'main'
  } catch {
    return 'main'
  }
}

/**
 * The branch's changed files under the analyzed directory: the diff against the merge base with
 * `origin/<base>` (or `<base>`; `main` unless the repos entry names another), plus every tracked or untracked change in the working tree, minus
 * deletions. Null, with the reason, when there is no base to diff against.
 */
export async function changedScope(executor: Executor, gitRoot: string): Promise<{ scope: Scope | null; note: string | null }> {
  const git = (command: string) => executor.run(command, { timeoutMs: 60_000 })
  let base: string | null = null
  const baseBranch = baseBranchOf(executor)
  for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
    const found = await git(`git rev-parse --verify -q ${candidate}`)
    if (found.exitCode === 0) { base = candidate; break }
  }
  if (base === null) return { scope: null, note: `Scope: the whole tree; no main branch to diff the ticket branch against (origin/${baseBranch} or ${baseBranch})` }
  const mergeBase = await git(`git merge-base ${base} HEAD`)
  if (mergeBase.exitCode !== 0) return { scope: null, note: `Scope: the whole tree; git merge-base ${base} HEAD failed: ${(mergeBase.stderr || mergeBase.stdout).trim().slice(-200)}` }
  const diff = await git(`git diff --name-only --diff-filter=ACMR ${mergeBase.stdout.trim()} HEAD`)
  const status = await git('git status --porcelain --untracked-files=all')
  if (diff.exitCode !== 0 || status.exitCode !== 0) return { scope: null, note: 'Scope: the whole tree; the changed files could not be listed' }
  const prefix = prefixOf(gitRoot, executor.root)
  const under = (path: string): string | null => {
    if (prefix === '') return path
    return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null
  }
  const files = [...new Set([...diff.stdout.split('\n'), ...statusPaths(status.stdout)].map((line) => line.trim()).filter(Boolean).filter((path) => !KIT_FOLDERS.test(path)).map(under).filter((path): path is string => path !== null))].sort()
  return { scope: { base, files }, note: null }
}

/** Whether a diagnostic names a file in scope. Everything is in scope when there is no scope. */
export const inScope = (diagnostic: Diagnostic, scope: Scope | null): boolean => scope === null || scope.files.includes(diagnostic.file.replace(/^\.\//, ''))

/** The diagnostics split by scope: `targets` the run fixes, `untouched` the pre-existing ones it reports. */
export function partition(diagnostics: Diagnostic[], scope: Scope | null): { targets: Diagnostic[]; untouched: Diagnostic[] } {
  if (scope === null) return { targets: diagnostics, untouched: [] }
  const targets: Diagnostic[] = []
  const untouched: Diagnostic[] = []
  for (const diagnostic of diagnostics) (inScope(diagnostic, scope) ? targets : untouched).push(diagnostic)
  return { targets, untouched }
}

/** The scope's files under an analyzer's cwd, relative to it, matching `exts` (a regex on the file name). */
export function filesFor(scope: Scope, cwd: string, exts: RegExp): string[] {
  const prefix = cwd === '' || cwd === '.' ? '' : `${cwd.replace(/\/+$/, '')}/`
  return scope.files.filter((file) => file.startsWith(prefix) && exts.test(file)).map((file) => file.slice(prefix.length))
}

/** One line for the report and the detection notes. */
export function scopeNote(scope: Scope, untouched: Diagnostic[]): string {
  const files = new Set(untouched.map((diagnostic) => diagnostic.file)).size
  const left = untouched.length ? `; ${untouched.length} pre-existing diagnostic${untouched.length === 1 ? '' : 's'} in ${files} untouched file${files === 1 ? '' : 's'} left as they are` : ''
  return `Scope: the ${scope.files.length} file${scope.files.length === 1 ? '' : 's'} the ticket branch changed against ${scope.base}${left}`
}
