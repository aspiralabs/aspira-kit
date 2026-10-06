// Pure helpers for load-pr: source parsing, the commands that produce a diff, and
// the markdown the seats read. No eve or node imports.

import { REPO_PATH, FILES } from './review.ts'

export { REPO_PATH }

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** A diff bigger than this is noise to a reviewer and a bill to nobody's benefit. */
export const MAX_PATCH_BYTES = 1_500_000

export type PrSource =
  | { kind: 'github'; owner: string; name: string; number: number; label: string }
  | { kind: 'local'; path: string; label: string }

/**
 * Accepts a GitHub PR URL, `owner/name#123`, `owner/name/pull/123`, or a filesystem
 * path. Anything that is not recognisably a PR reference is treated as a local repo.
 */
export function parsePrSource(input: string): PrSource {
  const s = input.trim()
  const local = s.startsWith('.') || s.startsWith('/')
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)\/?/)
  if (url) return github(url)
  const hash = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?#(\d+)$/)
  if (hash && !local) return github(hash)
  const short = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)\/?$/)
  if (short && !local) return github(short)
  return { kind: 'local', path: s, label: s }
}

function github(match: RegExpMatchArray): PrSource {
  const [, owner = '', name = '', number = ''] = match
  return { kind: 'github', owner, name, number: Number.parseInt(number, 10), label: `${owner}/${name}#${number}` }
}

export function prApiUrl(owner: string, name: string, number: number): string {
  return `https://api.github.com/repos/${owner}/${name}/pulls/${number}`
}

export type PrMeta = {
  label: string
  title: string
  body: string
  baseRef: string
  baseSha: string
  headRef: string
  headSha: string
  author: string | null
  url: string | null
}

/** The fields load-pr needs out of the GitHub PR payload, which is much larger. */
export function prMetaFromApi(owner: string, name: string, number: number, payload: unknown): PrMeta {
  const pr = payload as {
    title?: string
    body?: string | null
    html_url?: string
    user?: { login?: string } | null
    base?: { ref?: string; sha?: string }
    head?: { ref?: string; sha?: string }
  }
  const baseRef = pr.base?.ref
  const headSha = pr.head?.sha
  if (baseRef === undefined || headSha === undefined) {
    throw new Error(`GitHub returned no base ref or head sha for ${owner}/${name}#${number}.`)
  }
  return {
    label: `${owner}/${name}#${number}`,
    title: pr.title ?? `${owner}/${name}#${number}`,
    body: pr.body ?? '',
    baseRef,
    baseSha: pr.base?.sha ?? '',
    headRef: pr.head?.ref ?? `pull/${number}/head`,
    headSha,
    author: pr.user?.login ?? null,
    url: pr.html_url ?? null,
  }
}

/**
 * Clone, fetch both sides of the PR, and write the diff and the changed paths inside
 * the sandbox. A blobless partial clone keeps a large repo from costing a minute.
 * The token stays inside the command; it never reaches a tool result.
 */
export function clonePrCommand(source: Extract<PrSource, { kind: 'github' }>, meta: PrMeta, token: string | undefined): string {
  const url = `https://github.com/${source.owner}/${source.name}.git`
  const authed = token ? url.replace('https://', `https://x-access-token:${token}@`) : url
  return [
    'set -e',
    `rm -rf ${REPO_PATH}`,
    `git clone --filter=blob:none --quiet ${shellQuote(authed)} ${REPO_PATH}`,
    `cd ${REPO_PATH}`,
    `git fetch --quiet origin pull/${source.number}/head:__pr refs/heads/${meta.baseRef}:__base`,
    'MB=$(git merge-base __base __pr)',
    `git diff --patch --no-color "$MB" __pr > ${FILES.patch}`,
    `git diff --name-only "$MB" __pr > ${FILES.changed}`,
    'git checkout --quiet __pr',
    'git log -1 --format=%h __pr',
  ].join('\n')
}

/**
 * Where a local review's base comes from when the person did not name one. `main`
 * first: a local review compares a branch against main, and a stale `origin/main`
 * would silently review commits the branch never added.
 */
export const LOCAL_BASE_FALLBACKS = ['main', 'master', 'origin/main', 'origin/master', 'origin/HEAD']

/**
 * Diff against the merge base, not against the base branch tip: what this branch
 * changed, not what moved on main since.
 *
 * `--cached` against a scratch index (see `TEMP_INDEX_SETUP`) rather than a plain
 * working-tree diff, because a plain one silently omits untracked files — and a
 * file you have written but not yet added is exactly the code a local review is
 * for. Staging it into a throwaway index gets it into the diff without touching
 * the index the person is actually using.
 */
export function cachedDiffArgs(against: string, nameOnly: boolean): string[] {
  return ['diff', '--cached', '--no-color', ...(nameOnly ? ['--name-only'] : ['--patch']), against]
}

/** Run against GIT_INDEX_FILE pointed at a scratch file: seed from HEAD, then stage the worktree. */
export const TEMP_INDEX_SETUP: string[][] = [
  ['read-tree', 'HEAD'],
  ['add', '-A', '.'],
]

/**
 * `main...branch` for a branch that is not checked out: committed history only,
 * straight out of the object database. The working tree belongs to whatever branch
 * *is* checked out, so it has no business in this diff.
 */
export function refDiffArgs(mergeBase: string, ref: string, nameOnly: boolean): string[] {
  return ['diff', '--no-color', ...(nameOnly ? ['--name-only'] : ['--patch']), mergeBase, ref]
}

/** The tree at a commit, for the seats to read around the diff. Tracked files only — that is all a commit has. */
export function archiveArgs(ref: string): string[] {
  return ['archive', '--format=tar.gz', ref]
}

/** Directories never worth shipping into the sandbox, for local trees that are not git repos. */
export const LOCAL_EXCLUDES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.output',
  '.eve',
  '.turbo',
  'coverage',
  '.packs',
  '*.debate',
  '.work',
]

/**
 * A path a model handed back from a tool result. A JSON null round-trips through a model as
 * the string "null", and an empty value as "", so both mean no path, not a directory name.
 */
export function optionalPath(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return undefined
  return trimmed
}

/**
 * Reviews live in the repo they reviewed, inside the ticket's working folder
 * (`.work/<ticket>/pr-review/`), which git never sees. `.work/` is the one per-ticket
 * working folder every Aspira project has; `kit init` ignores it.
 */
export const REVIEW_DIR = '.work'
export const IGNORE_PATTERN = `${REVIEW_DIR}/`
export const REVIEW_SUBDIR = 'pr-review'

/** The ticket folder a branch maps to: the branch without its type prefix (feat/, fix/, …), as a slug. */
export function ticketFolder(branch: string): string {
  const name = branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : branch
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'review' : slug
}

/**
 * True when nothing in this .gitignore already covers the review directory. Exact
 * matches only: a broad pattern that happens to catch it is not something to guess at.
 */
export function needsIgnoreRule(gitignore: string): boolean {
  return !gitignore
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === IGNORE_PATTERN || line === REVIEW_DIR || line === `/${IGNORE_PATTERN}` || line === `/${REVIEW_DIR}`)
}

/** Appended to the reviewed repo's .gitignore, once, with a line saying who did it. */
export function ignoreRule(existing: string): string {
  const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return `${separator}# per-ticket working folders (pulled from the Notion ticket, never committed)\n${IGNORE_PATTERN}\n`
}

/** The changed paths of a pasted diff, read off its `diff --git` headers. */
export function changedFromPatch(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (match?.[2] !== undefined) paths.add(match[2])
  }
  return [...paths]
}

export function parseChangedFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export type PatchStats = { files: number; additions: number; deletions: number; bytes: number; truncated: boolean }

export function patchStats(patch: string, files: number, truncated = false): PatchStats {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { files, additions, deletions, bytes: Buffer.byteLength(patch, 'utf8'), truncated }
}

/**
 * Which of the changed paths actually survived truncation. The seats are told that
 * every finding cites a path from changed_files.txt, so that file must list what is
 * in the patch and nothing else — otherwise the rule sends them after files they
 * cannot read. The dropped ones are named in pr.md instead, as not reviewed.
 */
export function splitChanged(changed: string[], patch: string, truncated: boolean): { reviewed: string[]; dropped: string[] } {
  if (!truncated) return { reviewed: changed, dropped: [] }
  const present = new Set(changedFromPatch(patch))
  return {
    reviewed: changed.filter((path) => present.has(path)),
    dropped: changed.filter((path) => !present.has(path)),
  }
}

/** Cut a runaway diff at a file boundary so the seats never read half a hunk. */
export function truncatePatch(patch: string, maxBytes = MAX_PATCH_BYTES): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) return { patch, truncated: false }
  const cut = patch.slice(0, maxBytes)
  const lastFile = cut.lastIndexOf('\ndiff --git ')
  const kept = lastFile > 0 ? cut.slice(0, lastFile) : cut
  return {
    patch: `${kept}\n\n[diff truncated at ${maxBytes} bytes — the remaining files were not reviewed]\n`,
    truncated: true,
  }
}

/** /workspace/pr.md: the first thing every seat reads. */
export function renderPrMeta(meta: PrMeta, stats: PatchStats, changed: string[], dropped: string[] = []): string {
  const lines = [
    `# ${meta.title}`,
    '',
    `- Review target: ${meta.label}`,
    `- Base: ${meta.baseRef}${meta.baseSha ? ` (${meta.baseSha.slice(0, 7)})` : ''}`,
    `- Head: ${meta.headRef}${meta.headSha ? ` (${meta.headSha.slice(0, 7)})` : ''}`,
  ]
  if (meta.author !== null) lines.push(`- Author: ${meta.author}`)
  if (meta.url !== null) lines.push(`- URL: ${meta.url}`)
  lines.push(`- Diff: ${stats.files} file${stats.files === 1 ? '' : 's'}, +${stats.additions}/-${stats.deletions}`)
  if (stats.truncated) {
    lines.push(
      `- **The diff hit the ${MAX_PATCH_BYTES}-byte cap. ${dropped.length} of ${changed.length + dropped.length} changed files are not in it and were not reviewed.**`,
    )
  }
  lines.push('', '## Description', '', meta.body.trim() === '' ? '_No description._' : meta.body.trim(), '', '## Changed files', '')
  lines.push(...changed.slice(0, 200).map((path) => `- \`${path}\``))
  if (changed.length > 200) lines.push(`- _…and ${changed.length - 200} more, see \`${FILES.changed}\`._`)
  if (dropped.length > 0) {
    // Named, not hidden: a review that silently skipped a third of the diff is worse
    // than one that says so. They are kept out of changed_files.txt because a seat
    // that cites one is citing something it cannot read.
    lines.push(
      '',
      '## Not reviewed',
      '',
      `These changed files fell outside the ${MAX_PATCH_BYTES}-byte cap. They are not in the patch and not in \`${FILES.changed}\`. Do not raise findings about them; say in your position that they went unreviewed.`,
      '',
      ...dropped.slice(0, 100).map((path) => `- \`${path}\``),
    )
    if (dropped.length > 100) lines.push(`- _…and ${dropped.length - 100} more._`)
  }
  return `${lines.join('\n')}\n`
}
