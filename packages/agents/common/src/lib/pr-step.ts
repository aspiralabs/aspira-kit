// The shared PR check and the two-stage set-then-move board step (F24, F25, F26) implementor
// `--verify --pr-url` and build-feature's Step 8 both use, so a PR is never reused or set unless it
// is actually the run's own: open, same repository, on the ticket's branch, based on main, at HEAD.
//
// checkPr is the one gate: it runs `gh pr view` with the full field set through `hostPrChecks` (one
// function per operation, TEST-007) and refuses, names the field, on anything that does not match.
// When gh itself is missing or not authenticated, it blocks naming `gh auth login`; any other gh
// failure is incomplete with gh's first error line. A field `gh pr view` did not print (a caller's
// own fake gh answering fewer fields) is not re-checked: checkPr only refuses what it can see.
//
// prStep is the two-stage board step: the first call returns only a `set` action for the PR
// property and records the URL as expected (outside the board state verifyRun deletes, so a rerun
// before the board catches up does not forget it); once ticket.md reads that URL back, the move is
// returned (BOARD-005 order). A different PR already on the card, or a different pending URL,
// refuses naming both and (for a pending URL) the --replace-pending command.

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** The PR URL shape every caller validates --pr-url (and any PR a PR check runs on) against. */
export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/

/** The base branch every PR targets (duplicated from build-feature's own BASE_BRANCH: agent-common
 * does not depend on build-feature). */
const BASE_BRANCH = 'main'

/** The board move a passing PR check unlocks (STEP8_MOVE in build-feature's route.ts). */
export const STEP8_FROM = 'In Progress: Implementation'
export const STEP8_TO = 'In Review: Implementation'

type CommandResult = { code: number; stdout: string; stderr: string }
type HostOptions = { cwd: string; env: NodeJS.ProcessEnv }

const NOT_FOUND = 127

/** Run one command with an argument array; never throws for a non-zero exit or a missing binary. */
function run(command: string, args: readonly string[], options: HostOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr })
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
      if (code === 'ENOENT') return resolve({ code: NOT_FOUND, stdout: '', stderr: `spawn ${command} ENOENT: ${command} is not installed or not on PATH` })
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || error.message })
    })
  })
}

/** The four operations a PR check needs, one function per operation (TEST-007): a caller (a test,
 * or another package's own System) can stand in for the boundary. */
export type PrChecks = {
  ghPrView: (options: HostOptions, url: string) => Promise<CommandResult>
  gitHead: (options: HostOptions) => Promise<CommandResult>
  gitStatus: (options: HostOptions) => Promise<CommandResult>
  gitRemoteUrl: (options: HostOptions) => Promise<CommandResult>
}

const PR_VIEW_FIELDS = 'url,state,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,baseRefName'

/** The real boundary: `gh` and `git` on PATH. */
export const hostPrChecks: PrChecks = {
  ghPrView: (options, url) => run('gh', ['pr', 'view', url, '--json', PR_VIEW_FIELDS], options),
  gitHead: (options) => run('git', ['rev-parse', 'HEAD'], options),
  gitStatus: (options) => run('git', ['status', '--porcelain'], options),
  gitRemoteUrl: (options) => run('git', ['config', '--get', 'remote.origin.url'], options),
}

/** `gh pr view`'s JSON, loosely: a caller's own fake gh may print fewer fields than the real CLI,
 * and a field it did not print is simply not re-checked (only `state` is required). */
const prViewSchema = z.object({
  state: z.string(),
  headRefName: z.string().optional(),
  headRefOid: z.string().optional(),
  headRepository: z.unknown().optional(),
  headRepositoryOwner: z.unknown().optional(),
  isCrossRepository: z.boolean().optional(),
  baseRefName: z.string().optional(),
})
export type PrView = z.infer<typeof prViewSchema>

/** owner/name from a GitHub remote, PR or repository URL, or `owner/name` as written; null when it names none. */
function repositoryOf(value: string): string | null {
  const text = value.trim()
  const url = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(text)
  if (url !== null) return `${url[1]}/${url[2]}`.toLowerCase()
  const plain = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text)
  return plain === null ? null : `${plain[1]}/${plain[2]}`.toLowerCase()
}

const asLogin = (value: unknown): string | null => (typeof value === 'string' ? value : value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).login === 'string' ? ((value as Record<string, unknown>).login as string) : null)
const asName = (value: unknown): string | null => (typeof value === 'string' ? value : value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string' ? ((value as Record<string, unknown>).name as string) : null)

/** `owner/name`, lowercased, from headRepository/headRepositoryOwner in either gh's real (object) or a simplified fake's (string) shape; null when it cannot be resolved. */
function headRepoFullOf(repository: unknown, owner: unknown): string | null {
  const name = asName(repository)
  if (name === null) return null
  if (name.includes('/')) return name.toLowerCase()
  const login = asLogin(owner)
  return login === null ? null : `${login}/${name}`.toLowerCase()
}

export type PrCheckOk = { kind: 'ok' }
export type PrCheckProblem = { kind: 'refused' | 'blocked' | 'incomplete'; message: string; next?: string }
export type PrCheckResult = PrCheckOk | PrCheckProblem

export type CheckPrInput = {
  url: string
  /** The checkout `gh` and `git` run in. */
  repo: string
  /** The branch the PR's head must be (the ticket's own branch). */
  branch: string
  env: NodeJS.ProcessEnv
  /** The repository aspira.json names, when it does; falls back to origin's own URL. */
  aspira?: string
}

/** The shared PR check (F24): refuses (naming the field) a PR that is not open, is cross-repository,
 * is not on `branch`, does not base off main, or whose head is not HEAD; blocks on gh missing or
 * unauthenticated; is incomplete on any other gh failure. Never calls gh for a malformed --pr-url. */
export async function checkPr(input: CheckPrInput, host: PrChecks = hostPrChecks): Promise<PrCheckResult> {
  if (!PR_URL.test(input.url) || input.url.startsWith('-')) {
    return { kind: 'refused', message: `Usage: --pr-url needs a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>); got "${input.url}"` }
  }
  const options: HostOptions = { cwd: input.repo, env: input.env }
  const view = await host.ghPrView(options, input.url)
  if (view.code === NOT_FOUND || /gh auth login|not logged into|authentication required/i.test(view.stderr)) {
    return { kind: 'blocked', message: `gh is not installed or not authenticated: install it (https://cli.github.com) and run \`gh auth login\`, then try again` }
  }
  if (view.code !== 0) {
    const firstLine = (view.stderr.trim() || view.stdout.trim() || `gh pr view exited ${view.code}`).split('\n')[0]!
    return { kind: 'incomplete', message: firstLine }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(view.stdout)
  } catch {
    return { kind: 'incomplete', message: `gh pr view ${input.url} printed output that is not valid JSON` }
  }
  const data = prViewSchema.safeParse(parsed)
  if (!data.success) return { kind: 'incomplete', message: `gh pr view ${input.url} printed JSON missing the state the run needs` }
  const pr = data.data
  if (pr.state !== 'OPEN') return { kind: 'refused', message: `${input.url} is not open (state ${pr.state}): the run only works with an open PR` }

  const [remote, head] = await Promise.all([host.gitRemoteUrl(options), host.gitHead(options)])
  const originRepo = remote.code === 0 ? repositoryOf(remote.stdout.trim()) : null
  const expectedRepo = input.aspira !== undefined ? (repositoryOf(input.aspira) ?? input.aspira.toLowerCase()) : originRepo
  const headRepoFull = headRepoFullOf(pr.headRepository, pr.headRepositoryOwner)
  const crossRepo = pr.isCrossRepository === true || (headRepoFull !== null && expectedRepo !== null && headRepoFull !== expectedRepo)
  if (crossRepo) {
    return { kind: 'refused', message: `${input.url}'s headRepository${headRepoFull === null ? '' : ` (${headRepoFull})`} is not this project's own repository${expectedRepo === null ? '' : ` (${expectedRepo})`}: the run never reuses or sets a PR opened from a fork` }
  }
  if (pr.headRefName !== undefined && pr.headRefName !== input.branch) {
    return { kind: 'refused', message: `${input.url}'s headRefName is ${pr.headRefName}, not ${input.branch}: the run only works with the ticket's own branch` }
  }
  if (pr.baseRefName !== undefined && pr.baseRefName !== BASE_BRANCH) {
    return { kind: 'refused', message: `${input.url}'s baseRefName is ${pr.baseRefName}, not ${BASE_BRANCH}: the run only opens PRs against ${BASE_BRANCH}` }
  }
  if (pr.headRefOid !== undefined && pr.headRefOid !== '') {
    const sha = head.code === 0 ? head.stdout.trim() : ''
    if (sha === '' || pr.headRefOid !== sha) {
      return { kind: 'refused', message: `${input.url}'s headRefOid is ${pr.headRefOid}, not HEAD (${sha || 'unknown'}): the branch is unpushed, or ahead of what the PR shows. Push it, then try again`, next: `git push -u origin ${input.branch}` }
    }
  }
  return { kind: 'ok' }
}

// ---------------------------------------------------------------------------------------------
// The two-stage set-then-move board step.
// ---------------------------------------------------------------------------------------------

const PR_STATE_DIR = '.local/step8'
const PR_STATE_FILE = 'pr.json'
const expectedPrSchema = z.object({ url: z.string() })

/** The URL a prior `prStep` call expects the board's PR property to read back, or null when none is pending. */
export async function readExpectedPr(folder: string): Promise<string | null> {
  const raw = await readFile(join(folder, PR_STATE_DIR, PR_STATE_FILE), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed = expectedPrSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.url : null
  } catch {
    return null
  }
}

/** Records the URL `prStep` expects the board's PR property to read back next, outside the board state verifyRun deletes. */
export async function writeExpectedPr(folder: string, url: string): Promise<void> {
  const dir = join(folder, PR_STATE_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, PR_STATE_FILE), `${JSON.stringify({ url }, null, 2)}\n`)
}

export type PrStepTicket = { id: string; status: string; pr: string | null }

export type PrStepInput = {
  url: string
  repo: string
  branch: string
  /** The ticket's own working folder (.work/<id>-<slug>), where the pending URL is recorded. */
  folder: string
  ticket: PrStepTicket
  env: NodeJS.ProcessEnv
  aspira?: string
  /** Replaces a different pending URL already recorded for this ticket, instead of refusing. */
  replacePending?: boolean
}

export type PrStepResult =
  | { kind: 'set'; url: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'ready' }
  | { kind: 'refused'; message: string; next?: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'incomplete'; message: string }

/**
 * The shared set-then-move board step (F25, F26): the PR check first (so a bad PR never reaches the
 * board), then the first call sets the PR property and records the expected URL; once ticket.md
 * reads it back, the move is returned (BOARD-005 order: the set is requested, re-read, then the
 * move, never both at once). Already moved with that PR is `ready`, no action. A different PR
 * already on the card, or a different pending URL, refuses naming both (and, for a pending URL, the
 * `--replace-pending` command).
 */
export async function prStep(input: PrStepInput, host: PrChecks = hostPrChecks): Promise<PrStepResult> {
  const checked = await checkPr({ url: input.url, repo: input.repo, branch: input.branch, env: input.env, ...(input.aspira === undefined ? {} : { aspira: input.aspira }) }, host)
  if (checked.kind !== 'ok') return checked
  const { ticket } = input
  if (ticket.pr === input.url) {
    if (ticket.status === STEP8_TO) return { kind: 'ready' }
    return { kind: 'move', from: STEP8_FROM, to: STEP8_TO }
  }
  if (ticket.pr !== null) {
    return { kind: 'refused', message: `${ticket.id}'s PR property already reads ${ticket.pr}, not ${input.url}: confirm which one is right before the run sets it` }
  }
  const expected = await readExpectedPr(input.folder)
  if (expected === null || expected === input.url) {
    await writeExpectedPr(input.folder, input.url)
    return { kind: 'set', url: input.url }
  }
  if (input.replacePending !== true) {
    return { kind: 'refused', message: `${input.url} does not match the pending PR ${expected} already recorded for ${ticket.id}. Run again with --pr-url ${input.url} --replace-pending to replace it` }
  }
  await writeExpectedPr(input.folder, input.url)
  return { kind: 'set', url: input.url }
}
