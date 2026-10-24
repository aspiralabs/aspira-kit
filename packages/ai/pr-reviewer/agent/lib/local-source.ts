// Loading a PR for --local, on the host instead of in the sandbox. Same sources and the
// same diffs as load-pr: a GitHub PR's metadata and diff come from the API and its head
// is shallow-cloned for the tree; a local branch is diffed against the merge base with
// the pr.ts helpers, working tree included when it is the checked-out branch.

import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GithubPr } from './github-comment.ts'
import {
  LOCAL_BASE_FALLBACKS,
  TEMP_INDEX_SETUP,
  cachedDiffArgs,
  changedFromPatch,
  compareApiUrl,
  parseChangedFiles,
  prApiUrl,
  prMetaFromApi,
  refDiffArgs,
  type PrMeta,
} from './pr.ts'

const run = promisify(execFile)
const MAX_BUFFER = 512 * 1024 * 1024

/** The fetch signature the loader and the comment poster take, so tests can stand in for GitHub. */
export type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

/** A diff and its changed paths, before truncation. */
export type RawDiff = { patch: string; changed: string[] }

/** A local branch, resolved: where it is, what it is compared against, and whether its working tree counts. */
export type LocalBranch = {
  /** The directory that was named, absolute. */
  dir: string
  /** Its git root: where the review is written and the tree the seats read for a live review. */
  repoDir: string
  headRef: string
  headSha: string
  baseRef: string
  mergeBase: string
  /** True for the checked-out branch: its uncommitted edits and never-added files are reviewed too. */
  live: boolean
}

const git = (dir: string, args: string[], env?: NodeJS.ProcessEnv) => run('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) })

/** Resolve a local repository and branch the way load-pr does, without diffing yet. */
export async function resolveLocalBranch(path: string, branch: string | undefined, base: string | undefined): Promise<LocalBranch> {
  const dir = resolve(path)
  const info = await stat(dir).catch(() => null)
  if (info === null || !info.isDirectory()) throw new Error(`Not a directory: ${dir}`)
  const repoDir = await git(dir, ['rev-parse', '--show-toplevel']).then(
    (r) => r.stdout.trim(),
    () => {
      throw new Error(`Not a git repository: ${dir}. A local review needs git to produce a diff.`)
    },
  )
  const checkedOut = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const headRef = branch ?? checkedOut
  const headSha = await git(dir, ['rev-parse', '--verify', `${headRef}^{commit}`]).then(
    (r) => r.stdout.trim(),
    () => {
      throw new Error(`No such branch in ${dir}: ${headRef}.`)
    },
  )
  const baseRef = base ?? (await firstResolvable(dir, LOCAL_BASE_FALLBACKS.filter((ref) => ref !== headRef)))
  if (baseRef === null) throw new Error(`No base branch found in ${dir} (tried ${LOCAL_BASE_FALLBACKS.join(', ')}). Pass --base.`)
  if (baseRef === headRef) throw new Error(`Base and branch are both ${headRef} in ${dir}. Name a different base.`)
  const mergeBase = await git(dir, ['merge-base', baseRef, headSha]).then(
    (r) => r.stdout.trim(),
    () => {
      throw new Error(`\`git merge-base ${baseRef} ${headRef}\` failed in ${dir}. Do they share history?`)
    },
  )
  return { dir, repoDir, headRef, headSha, baseRef, mergeBase, live: branch === undefined || headRef === checkedOut }
}

/**
 * `base...branch`. For the checked-out branch, the working tree through a scratch index,
 * exactly as load-pr does, minus `exclude`: the review's own work and output directories,
 * which sit inside the tree they review and must not review themselves.
 */
export async function localDiff(branch: LocalBranch, exclude: string[], since?: string): Promise<RawDiff> {
  // A re-review diffs from the previous head, not from the merge base: only what changed since.
  const against = since ?? branch.mergeBase
  if (since !== undefined) {
    const known = await git(branch.dir, ['cat-file', '-e', `${since}^{commit}`]).then(
      () => true,
      () => false,
    )
    if (!known) throw new Error(`The previous review was of ${since.slice(0, 7)}, which is not a commit in ${branch.dir}. Was the branch rewritten? Review it in full instead.`)
  }
  if (!branch.live) {
    return {
      patch: (await git(branch.dir, refDiffArgs(against, branch.headSha, false))).stdout,
      changed: parseChangedFiles((await git(branch.dir, refDiffArgs(against, branch.headSha, true))).stdout),
    }
  }
  // The review's own directories are taken back out of the scratch index after the add rather
  // than excluded by pathspec: `git add` refuses a pathspec that names only ignored paths, and
  // `.work/` is ignored in every repo that has been reviewed once.
  const own = exclude
    .map((path) => relative(branch.repoDir, path))
    .filter((path) => path !== '' && !path.startsWith('..') && !isAbsolute(path))
  const indexFile = resolve(tmpdir(), `pr-review-local-index-${process.pid}-${Date.now()}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    for (const args of TEMP_INDEX_SETUP) await git(branch.dir, args, env)
    if (own.length > 0) await git(branch.repoDir, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...own], env)
    return {
      patch: (await git(branch.dir, cachedDiffArgs(against, false), env)).stdout,
      changed: parseChangedFiles((await git(branch.dir, cachedDiffArgs(against, true), env)).stdout),
    }
  } finally {
    await rm(indexFile, { force: true })
  }
}

/** The PrMeta load-pr writes for a local branch. */
export async function localMeta(branch: LocalBranch): Promise<PrMeta> {
  const subject = (await git(branch.dir, ['log', '-1', '--format=%s', branch.headSha])).stdout.trim()
  const scope = branch.live
    ? 'The working tree is included, so uncommitted edits and files that were never added are part of this diff.'
    : `${branch.headRef} is not the checked-out branch, so this is its committed history only — nothing from the working tree.`
  return {
    label: `${branch.dir} @ ${branch.headRef} vs ${branch.baseRef}`,
    title: subject === '' ? `Local changes on ${branch.headRef}` : subject,
    body: `Local review of \`${branch.headRef}\` against \`${branch.baseRef}\` in \`${branch.dir}\`, from their merge base \`${branch.mergeBase.slice(0, 7)}\`. ${scope}`,
    baseRef: `${branch.baseRef} (merge base ${branch.mergeBase.slice(0, 7)})`,
    baseSha: branch.mergeBase,
    headRef: branch.headRef,
    headSha: branch.headSha,
    author: null,
    url: null,
  }
}

/** A branch that is not checked out is read from its own commit, as load-pr's `git archive` does. */
export async function extractCommit(branch: LocalBranch, into: string): Promise<void> {
  await rm(into, { recursive: true, force: true })
  await mkdir(into, { recursive: true })
  await run('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -xf - -C "$3"', 'sh', branch.dir, branch.headSha, into], { maxBuffer: MAX_BUFFER })
}

const headers = (token: string | undefined, accept: string) => ({
  accept,
  'user-agent': 'aspiralabs-pr-reviewer',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
})

/** The PR's metadata, from the GitHub API. */
export async function fetchPrMeta(pr: GithubPr, token: string | undefined, request: Fetch): Promise<PrMeta> {
  const response = await request(prApiUrl(pr.owner, pr.name, pr.number), { headers: headers(token, 'application/vnd.github+json') })
  if (!response.ok) {
    const hint = response.status === 404 && token === undefined ? ' (private repo? set GITHUB_TOKEN or run `gh auth login`)' : ''
    throw new Error(`GitHub API ${response.status} for ${pr.owner}/${pr.name}#${pr.number}${hint}`)
  }
  return prMetaFromApi(pr.owner, pr.name, pr.number, await response.json())
}

/**
 * The PR's diff against its merge base, from the GitHub API, with the changed paths read off it.
 * With `since`, the diff from that commit to the head instead: a re-review reads only the delta.
 */
export async function fetchPrDiff(pr: GithubPr, token: string | undefined, request: Fetch, since?: { sha: string; headSha: string }): Promise<RawDiff> {
  const url = since === undefined ? prApiUrl(pr.owner, pr.name, pr.number) : compareApiUrl(pr.owner, pr.name, since.sha, since.headSha)
  const response = await request(url, { headers: headers(token, 'application/vnd.github.diff') })
  if (!response.ok) {
    const hint = response.status === 406 ? ' (GitHub does not serve diffs this large through the API)' : since !== undefined && response.status === 404 ? ` (the previous head ${since.sha.slice(0, 7)} is not in the repository any more; was the branch rewritten?)` : ''
    throw new Error(`GitHub API ${response.status} fetching the diff of ${pr.owner}/${pr.name}#${pr.number}${hint}`)
  }
  const patch = await response.text()
  return { patch, changed: changedFromPatch(patch) }
}

/**
 * A depth-1 clone of the PR head into `into`, checked out detached, for the seats to read.
 * The token travels as an HTTP header in the environment: never in argv, the remote URL or
 * .git/config. Fails if the fetched head is not the one the API reported.
 */
export async function cloneHead(pr: GithubPr, headSha: string, into: string, url: string, token: string | undefined): Promise<void> {
  await rm(into, { recursive: true, force: true })
  await mkdir(into, { recursive: true })
  const auth = token
    ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
    : {}
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...auth }
  try {
    await git(into, ['init', '-q'], env)
    await git(into, ['fetch', '--depth', '1', '--no-tags', '-q', url, `pull/${pr.number}/head`], env)
    await git(into, ['checkout', '-q', '--detach', 'FETCH_HEAD'], env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cloning the head of ${pr.owner}/${pr.name}#${pr.number} failed: ${token ? message.replaceAll(token, '***') : message}`)
  }
  const cloned = (await git(into, ['rev-parse', 'HEAD'])).stdout.trim()
  if (cloned !== headSha) throw new Error(`The head of ${pr.owner}/${pr.name}#${pr.number} moved while loading (${cloned.slice(0, 7)}, not ${headSha.slice(0, 7)}). Run again.`)
}

/** GITHUB_TOKEN, else what `gh auth token` prints, else nothing. */
export async function defaultGithubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN
  if (env !== undefined && env !== '') return env
  const gh = await run('gh', ['auth', 'token']).then(
    (r) => r.stdout.trim(),
    () => '',
  )
  return gh === '' ? undefined : gh
}

async function firstResolvable(dir: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const ok = await git(dir, ['rev-parse', '--verify', '--quiet', ref]).then(
      () => true,
      () => false,
    )
    if (ok) return ref
  }
  return null
}
