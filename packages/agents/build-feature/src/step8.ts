// Step 8 (F23-F26, F33), after a 'clean' code-analyzer result: commit the analyzer's changes on the
// feature branch, push it through the guard, open a draft PR or reuse the open one, set the card's
// PR property, and only then move the card to In Review: Implementation (BOARD-005 order).
//
// - commitAnalyzerChanges: commits the paths the analyzer changed (the files its model edited, the
//   tracked files its auto-fixes changed after the gate finished, and the app .gitignore it adds its
//   output folder to) with a message citing the ticket ID. Nothing under .static-analysis/ or .work/
//   is ever staged. Anything else still changed after the commit stops the run, naming it.
// - pushGuarded: refuses unless HEAD is <prefix>/<id>-<slug> (feat/, fix/ or chore/ from the card's
//   Type, GIT-001), that branch is not the base branch, and origin is the repository the PR
//   property and aspira.json `repository` name (each when set). `git push -u origin HEAD` from the
//   ticket's worktree (F50), never forced; a rejection stops the run with git's message; an
//   up-to-date push is fine.
// - openOrReusePr: an open PR whose head is the branch is reused; otherwise `gh pr create --draft`
//   with the rendered pr-body.md. The set-pr stage is printed only when the card's PR property
//   differs; the move is requested with the PR URL as the expected property, so the driver
//   re-resolves the card and prints the move only once the property reads back.
//
// Each sub-action is recorded in run state (state.step8 and phases.step8), so a rerun after any
// partial Step 8 repeats nothing it finished. Any failure stops with the command and its error and
// no later move.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { addTaken, collectTakenDecisions } from '#src/decisions.ts'
import type { Phase, PhaseContext, PhaseResult } from '#src/driver.ts'
import { gateRecordOf } from '#src/gate.ts'
import { renderPrBody } from '#src/pr-body.ts'
import { tail } from '#src/redact.ts'
import { STEP8_MOVE } from '#src/route.ts'
import { ticketBranch } from '#src/worktree.ts'
import type { Failure, Pending, RunState } from '#src/run-state.ts'
import { GH_ARGS, GIT_ARGS, parseStatus, shown, system, type CommandResult, type System, type SystemOptions } from '#src/system.ts'

/** The branch every PR targets. */
export const BASE_BRANCH = 'main'

/** The branch a ticket is built on: <prefix>/<id>-<slug>, the prefix from the card's Type (GIT-001). */
export const featureBranch = (id: string, title: string, type: string | null): string => ticketBranch(id, title, type)

/** Folders the run never stages: the analyzer's output and the run's own work folder. */
export const isExcludedPath = (path: string): boolean => path.startsWith('.work/') || path.startsWith('.static-analysis/') || path.includes('/.static-analysis/')

const step8RecordSchema = z.object({
  /** The analyzer result whose changes were committed (analyzerKey). */
  committedFor: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  /** The HEAD the last successful push sent. */
  pushedHead: z.string().nullable().default(null),
})
type Step8Record = z.infer<typeof step8RecordSchema>

const recordOf = (state: RunState): Step8Record => {
  const parsed = step8RecordSchema.safeParse(state.phases.step8 ?? {})
  return parsed.success ? parsed.data : step8RecordSchema.parse({})
}
const withRecord = (state: RunState, patch: Partial<Step8Record>): RunState => ({ ...state, phases: { ...state.phases, step8: { ...recordOf(state), ...patch } } })

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string; failure: Failure }

const optionsOf = (context: PhaseContext): SystemOptions => ({ cwd: context.repo, env: context.env })
const errorOf = (result: CommandResult): string => tail((result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).trim(), 20)

function failed<T>(action: string, command: string, result: CommandResult, why: string): Outcome<T> {
  const error = errorOf(result)
  const message = `${why}: \`${command}\` exited ${result.code}: ${error}`
  return { ok: false, message, failure: { action, command, exitCode: result.code, output: error, message } }
}

function refused<T>(action: string, message: string): Outcome<T> {
  return { ok: false, message, failure: { action, message } }
}

// ---------------------------------------------------------------------------------------------
// Commit.
// ---------------------------------------------------------------------------------------------

/** The analyzer result the run is on: the last code-analyzer step it recorded. */
const analyzerKey = (state: RunState): string | null => {
  const last = state.steps.filter((step) => step.step === 'code-analyzer').at(-1)
  return last === undefined ? null : `${last.runId}:${last.endedAt}:${last.nonce ?? ''}`
}

const roundsSchema = z.looseObject({ editedFiles: z.array(z.string()) })

/** The files the analyzer's model edited, repository-relative. */
async function editedFiles(repo: string, app: string): Promise<Outcome<string[]>> {
  const file = join(repo, app, '.static-analysis/rounds.json')
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return refused('commit', `the code-analyzer left no ${join(app, '.static-analysis/rounds.json')}, so the run cannot tell which files it changed`)
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return refused('commit', `${join(app, '.static-analysis/rounds.json')} is not valid JSON, so the run cannot tell which files the analyzer changed`)
  }
  const parsed = roundsSchema.safeParse(json)
  if (!parsed.success) return refused('commit', `${join(app, '.static-analysis/rounds.json')} has no editedFiles list, so the run cannot tell which files the analyzer changed`)
  const prefix = app === '.' || app === '' ? '' : `${app.replace(/\/+$/, '')}/`
  return { ok: true, value: parsed.data.editedFiles.map((path) => `${prefix}${path.replace(/^\.\//, '')}`) }
}

/** The changed paths outside the excluded folders. */
async function changedPaths(sys: System, options: SystemOptions): Promise<Outcome<{ path: string; untracked: boolean }[]>> {
  const status = await sys.gitStatus(options)
  if (status.code !== 0) return failed('git status', shown('git', GIT_ARGS.status), status, 'the run could not read the working tree')
  return { ok: true, value: parseStatus(status.stdout).filter((entry) => !isExcludedPath(entry.path)) }
}

/**
 * Commit the analyzer's changes once per analyzer result, citing the ticket ID, never staging
 * .static-analysis/ or .work/; then anything still changed stops the run, naming it.
 */
export async function commitAnalyzerChanges(context: PhaseContext, state: RunState, sys: System = system): Promise<Outcome<RunState>> {
  const options = optionsOf(context)
  const app = context.aspira.app ?? '.'
  const key = analyzerKey(state)
  let next = state
  if (key !== null && recordOf(state).committedFor !== key) {
    const edited = await editedFiles(context.repo, app)
    if (!edited.ok) return edited
    const changed = await changedPaths(sys, options)
    if (!changed.ok) return changed
    const before = new Set(gateRecordOf(state)?.dirtyBefore ?? [])
    const gitignore = app === '.' || app === '' ? '.gitignore' : `${app.replace(/\/+$/, '')}/.gitignore`
    const analyzer = new Set([...edited.value, gitignore])
    const paths = changed.value.filter((entry) => analyzer.has(entry.path) || (!entry.untracked && !before.has(entry.path))).map((entry) => entry.path)
    let commit: string | null = null
    if (paths.length > 0) {
      const message = `${context.id}: apply the code-analyzer fixes`
      const committed = await sys.gitCommit(options, paths, message)
      if (committed.code !== 0) return failed('commit', shown('git', ['commit', '-m', message, '--', ...paths]), committed, 'the analyzer changes could not be committed')
      const head = await sys.gitHead(options)
      commit = head.code === 0 ? head.stdout.trim() : null
    }
    next = withRecord(next, { committedFor: key, commit })
  }
  const left = await changedPaths(sys, options)
  if (!left.ok) return left
  if (left.value.length > 0) {
    const names = left.value.map((entry) => entry.path)
    return refused('commit', `the working tree has changes outside the analyzer's fixes: ${names.join(', ')}. The run stops before the push; commit or remove them, then resume`)
  }
  return { ok: true, value: next }
}

// ---------------------------------------------------------------------------------------------
// Push.
// ---------------------------------------------------------------------------------------------

/** owner/name from a GitHub remote, PR or repository URL, or `owner/name` as written; null when it names none. */
export function repositoryOf(value: string): string | null {
  const text = value.trim()
  const url = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(text)
  if (url !== null) return `${url[1]}/${url[2]}`.toLowerCase()
  const plain = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text)
  return plain === null ? null : `${plain[1]}/${plain[2]}`.toLowerCase()
}

/** Whether the push is allowed: HEAD on the ticket branch, not the base, origin the named repository. */
async function guard(context: PhaseContext, sys: System): Promise<Outcome<string>> {
  const options = optionsOf(context)
  const expected = featureBranch(context.id, context.card.title, context.card.type)
  const current = await sys.gitCurrentBranch(options)
  if (current.code !== 0) return failed('push', shown('git', GIT_ARGS.currentBranch), current, 'the run could not read the current branch')
  const branch = current.stdout.trim()
  if (expected === BASE_BRANCH || branch === BASE_BRANCH) return refused('push', `HEAD is on ${branch}, the base branch ${BASE_BRANCH}: the run never pushes the base branch, only ${expected}`)
  if (branch !== expected) return refused('push', `HEAD is on ${branch}, not ${expected}: the run pushes only from ${expected}`)
  const remote = await sys.gitRemoteUrl(options)
  if (remote.code !== 0) return failed('push', shown('git', GIT_ARGS.remoteUrl), remote, 'the run could not read origin')
  const origin = repositoryOf(remote.stdout)
  const named = [
    ...(context.card.pr === null ? [] : [{ where: 'the PR property', value: context.card.pr }]),
    ...(context.aspira.repository === undefined || context.aspira.repository === '' ? [] : [{ where: 'aspira.json repository', value: context.aspira.repository }]),
  ]
  for (const { where, value } of named) {
    const repository = repositoryOf(value)
    if (repository === null || repository !== origin) return refused('push', `origin is ${origin ?? remote.stdout.trim()}, not ${repository ?? value}, the repository ${where} names: the run will not push there`)
  }
  return { ok: true, value: branch }
}

/** Push the ticket branch through the guard; a push that is already up to date is fine, a rejection stops. */
export async function pushGuarded(context: PhaseContext, state: RunState, sys: System = system): Promise<Outcome<RunState>> {
  const allowed = await guard(context, sys)
  if (!allowed.ok) return allowed
  const options = optionsOf(context)
  const head = await sys.gitHead(options)
  if (head.code !== 0) return failed('push', shown('git', GIT_ARGS.head), head, 'the run could not read HEAD')
  const sha = head.stdout.trim()
  if (state.step8.pushed && recordOf(state).pushedHead === sha) return { ok: true, value: state }
  const pushed = await sys.gitPush(options)
  if (pushed.code !== 0) return failed('git push', shown('git', GIT_ARGS.push), pushed, 'the push was rejected; the run never forces a push')
  return { ok: true, value: withRecord({ ...state, step8: { ...state.step8, pushed: true } }, { pushedHead: sha }) }
}

// ---------------------------------------------------------------------------------------------
// The PR.
// ---------------------------------------------------------------------------------------------

/** The implementor's assumptions are decisions taken after Ready: Plan; list them even when the build ran in an earlier session. */
async function withImplementorDecisions(context: PhaseContext, state: RunState): Promise<RunState> {
  if (state.takenKeys.some((entry) => entry.step === 'implementor')) return state
  const runId = state.steps.filter((step) => step.step === 'implementor').at(-1)?.runId ?? context.runId
  const collected = await collectTakenDecisions('implementor', { folder: context.folder, runId })
  return collected.ok ? addTaken(state, collected.taken) : state
}

/** Render pr-body.md for the run state; returns its path. */
export async function writePrBody(context: PhaseContext, state: RunState): Promise<string> {
  const file = join(context.dir, 'pr-body.md')
  await mkdir(context.dir, { recursive: true })
  await writeFile(file, await renderPrBody({ ticket: { id: context.id, title: context.card.title, url: context.card.url }, state, repo: context.repo }))
  return file
}

/** Rewrite the PR description from the run state (after a fix push and at the end of the run, F26). */
export async function rewritePrBody(context: PhaseContext, state: RunState, sys: System = system): Promise<Outcome<RunState>> {
  const url = state.step8.prUrl
  if (url === null) return refused('gh pr edit', 'the run has no PR to rewrite the description of')
  const next = await withImplementorDecisions(context, state)
  const body = await writePrBody(context, next)
  const edited = await sys.ghPrEdit(optionsOf(context), url, body)
  if (edited.code !== 0) return failed('gh pr edit', shown('gh', GH_ARGS.prEdit(url, body)), edited, 'the PR description could not be rewritten')
  return { ok: true, value: next }
}

const PR_URL = /^https:\/\/\S+\/pull\/\d+$/

/** Reuse the open PR whose head is the branch, or open a draft PR with the rendered body. */
export async function openOrReusePr(context: PhaseContext, state: RunState, sys: System = system): Promise<Outcome<RunState>> {
  const options = optionsOf(context)
  const branch = featureBranch(context.id, context.card.title, context.card.type)
  const listed = await sys.ghPrList(options, branch)
  if (listed.code !== 0) return failed('gh pr list', shown('gh', GH_ARGS.prList(branch)), listed, 'the run could not look up an open PR for the branch')
  const open = listed.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  if (PR_URL.test(open)) return { ok: true, value: { ...state, step8: { ...state.step8, prUrl: open } } }
  const next = await withImplementorDecisions(context, state)
  const bodyFile = await writePrBody(context, next)
  const input = { base: BASE_BRANCH, head: branch, title: `${context.id}: ${context.card.title}`, bodyFile }
  const created = await sys.ghPrCreate(options, input)
  if (created.code !== 0) return failed('gh pr create', shown('gh', GH_ARGS.prCreate(input)), created, 'the draft PR could not be opened')
  const url = created.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  if (!PR_URL.test(url)) return refused('gh pr create', `\`${shown('gh', GH_ARGS.prCreate(input))}\` printed no PR URL: ${tail(created.stdout.trim(), 5)}`)
  return { ok: true, value: { ...next, step8: { ...next.step8, prUrl: url } } }
}

// ---------------------------------------------------------------------------------------------
// The phase.
// ---------------------------------------------------------------------------------------------

const stopWith = (state: RunState, outcome: { message: string; failure: Failure }): PhaseResult => ({ kind: 'stop', state, message: outcome.message, failure: outcome.failure })

/** The move, requested with the PR URL as the property the re-resolve must read back (BOARD-005). */
const moveAfter = (context: PhaseContext, state: RunState, url: string): PhaseResult => ({ kind: 'move', state, from: STEP8_MOVE.from, to: STEP8_MOVE.to, expect: { status: context.card.status, pr: url, dev: context.card.dev } })

async function step8Next(context: PhaseContext, state: RunState, sys: System = system): Promise<PhaseResult> {
  if (context.card.status !== STEP8_MOVE.from) return { kind: 'done', state }
  const allowed = await guard(context, sys)
  if (!allowed.ok) return stopWith(state, allowed)
  const committed = await commitAnalyzerChanges(context, state, sys)
  if (!committed.ok) return stopWith(state, committed)
  const pushed = await pushGuarded(context, committed.value, sys)
  if (!pushed.ok) return stopWith(committed.value, pushed)
  const pr = await openOrReusePr(context, pushed.value, sys)
  if (!pr.ok) return stopWith(pushed.value, pr)
  const url = pr.value.step8.prUrl!
  if (context.card.pr === url) return moveAfter(context, { ...pr.value, step8: { ...pr.value.step8, prPropertySet: true } }, url)
  return {
    kind: 'stage',
    state: { ...pr.value, step8: { ...pr.value.step8, prPropertySet: false } },
    stage: 'set-pr',
    body: {
      url,
      notion: [{ op: 'write', target: 'ticket' }],
      instructions: `Set ${context.id}'s PR property on the Feature Board to ${url} (the PR property only), then write {"nonce", "done": true}, or {"nonce", "error"} when it fails, to the output file.`,
    },
    data: { url },
  }
}

const setPrAnswer = z.union([z.object({ nonce: z.string(), done: z.literal(true) }), z.object({ nonce: z.string(), error: z.string().min(1) })])

async function step8Accept(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<PhaseResult> {
  const url = String(pending.data?.url ?? state.step8.prUrl ?? '')
  const parsed = setPrAnswer.safeParse(answer)
  if (!parsed.success || 'error' in parsed.data) {
    const message = `setting ${context.id}'s PR property to ${url} failed: ${parsed.success && 'error' in parsed.data ? parsed.data.error : 'the answer did not say it was done'}`
    return { kind: 'stop', state, message, failure: { action: 'set-pr', message } }
  }
  return moveAfter(context, { ...state, step8: { ...state.step8, prPropertySet: true } }, url)
}

/** The driver's Step 8 phase (PHASE_MODULES.step8). */
export const step8Phase: Phase = {
  next: (context, state) => step8Next(context, state),
  accept: step8Accept,
}
