// `kit cleanup [--yes] [--only <path>...]`: removes the working folders (`.work/<id>-<slug>/`) and the
// ticket worktrees (`.worktrees/<TYPE>-<ID>`) whose card is Released or Dropped on the board, never a
// worktree with uncommitted or unpushed work. The live Status comes from the board through the
// TicketLookup seam; the Status pulled into a ticket.md is never used to decide a deletion. Every
// candidate gets one line in a fixed order; deletions follow that order, with the worktree the process
// stands in last and nothing printed after its result.
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { appRoot, isNotionUrl, readApp, readAspira } from './aspira.js'
import { type Log } from './fs.js'
import { git, listWorktrees, repositoryRoot, type Worktree } from './git.js'
import { readWorkTicket, type ResolvedTicket } from './next.js'
import { nextStep } from './playbook.js'
import { parseHandle, ticketTypeOf, type TicketHandle } from './ticket-handle.js'
import { lookupTicket, type TicketLookup, type TicketLookupFailure, type TicketLookupResult } from './ticket-lookup.js'

/** Asks the human on a terminal; null at end of input. */
export type Ask = (prompt: string) => Promise<string | null>

export type CleanupOptions = {
  /** The project root (where aspira.json is), in the main checkout or in a ticket worktree. */
  projectRoot: string
  /** --app: the app that owns node_modules, overriding aspira.json's. */
  app?: string | undefined
  /** --yes: delete without asking. */
  yes: boolean
  /** --only (with --yes): delete only these paths, if they are still marked delete. */
  only?: string[] | undefined
  /** The board seam; the live lookup through the common folder by default. */
  lookup?: TicketLookup | undefined
  /** The terminal reader; absent when there is no terminal. */
  ask?: Ask | undefined
  log: Log
  /** Where the `kit cleanup: <cause>` lines go; stderr by default. */
  warn?: Log | undefined
}

const VERSION_SKEW = "the installed @aspiralabs/ai does not report the card's Type; install @aspiralabs/ai at the kit's version and run kit init"

type Verdict = { kind: 'delete' } | { kind: 'keep' } | { kind: 'skip'; reason: string }

type FolderCandidate = { kind: 'folder'; path: string; work: string; id: string | undefined; status: string | undefined; verdict: Verdict }
type WorktreeCandidate = { kind: 'worktree'; path: string; worktree: Worktree; handle: TicketHandle; id: string; status: string | undefined; verdict: Verdict }
type Candidate = FolderCandidate | WorktreeCandidate

const skip = (reason: string): Verdict => ({ kind: 'skip', reason })

/** Released or Dropped, matched as nextStep matches a Status. */
function isDone(status: string): boolean {
  const row = nextStep(status)
  return row !== null && row.statuses.some((name) => name === 'Released' || name === 'Dropped')
}

/** A message's non-empty lines, trimmed and joined into one line. */
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('; ')

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Whether `path` is `dir` or below it. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** realpath, or the resolved path when it does not exist. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export async function cleanup(opts: CleanupOptions): Promise<number> {
  const { log } = opts
  const warn: Log = opts.warn ?? ((line) => process.stderr.write(`${line}\n`))
  const lookup = opts.lookup ?? lookupTicket
  const projectRoot = real(opts.projectRoot)
  const config = readAspira(projectRoot)
  if (!isNotionUrl(config?.board)) {
    log('no aspira.json with a Feature Board here; run kit init --board <Feature Board URL>')
    return 1
  }
  const board = config.board
  const appDir = appRoot(projectRoot, opts.app ?? readApp(projectRoot))

  // Where things are: the git top level holding the project, the main checkout, and the project's path below the top level.
  const top = repositoryRoot(projectRoot)
  const worktrees = top === undefined ? undefined : listWorktrees(projectRoot)
  const mainRoot = worktrees?.[0]?.path
  const inGit = top !== undefined && mainRoot !== undefined
  const projectRel = inGit ? relative(real(top), projectRoot) : ''

  // The board, once per distinct ID; after a kit-side failure no further lookups.
  const answers = new Map<string, TicketLookupResult>()
  const warned = new Set<string>()
  let kitFailure: TicketLookupFailure | undefined
  const lookUp = (id: string): TicketLookupResult => {
    const key = id.toUpperCase()
    const known = answers.get(key)
    if (known !== undefined) return known
    const result = kitFailure ?? lookup(board, id, projectRoot, appDir)
    answers.set(key, result)
    if (!('ticket' in result)) {
      if (result.cause === 'kit') kitFailure = result
      if (result.reason === 'board unreachable' && !warned.has(result.detail)) {
        warned.add(result.detail)
        warn(`kit cleanup: ${result.detail}`)
      }
    }
    return result
  }

  /** Every directory under one checkout's .work/, by name, judged on its own card. */
  const foldersIn = (work: string): FolderCandidate[] => {
    if (!existsSync(work)) return []
    return readdirSync(work, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry): FolderCandidate => {
        const path = join(work, entry.name)
        const base = { kind: 'folder' as const, path, work }
        if (lstatSync(path).isSymbolicLink()) return { ...base, id: undefined, status: undefined, verdict: skip('symlink') }
        if (!existsSync(join(path, 'ticket.md'))) return { ...base, id: undefined, status: undefined, verdict: skip('no ticket.md') }
        let ticket: ResolvedTicket | null
        try {
          ticket = readWorkTicket(path)
        } catch {
          ticket = null
        }
        if (ticket === null || ticket.id === '') return { ...base, id: undefined, status: undefined, verdict: skip('ticket.md unreadable') }
        const id = ticket.id
        if (!entry.name.startsWith(`${id.toLowerCase()}-`)) return { ...base, id, status: undefined, verdict: skip(`folder name does not match ticket.md ID ${id}`) }
        const result = lookUp(id)
        if (!('ticket' in result)) return { ...base, id, status: undefined, verdict: skip(result.reason) }
        const status = result.ticket.status
        return { ...base, id, status, verdict: isDone(status) ? { kind: 'delete' } : { kind: 'keep' } }
      })
  }

  const candidates: Candidate[] = []
  if (inGit) {
    candidates.push(...foldersIn(join(mainRoot, projectRel, '.work')))
  } else {
    candidates.push(...foldersIn(join(projectRoot, '.work')))
  }

  // Ticket worktrees: exactly <main checkout>/.worktrees/<TYPE>-<ID>.
  const ticketWorktrees: { worktree: Worktree; handle: TicketHandle; id: string }[] = []
  if (inGit && worktrees !== undefined) {
    const holder = join(mainRoot, '.worktrees')
    for (const worktree of worktrees.slice(1)) {
      if (worktree.bare || dirname(worktree.path) !== holder) continue
      const parsed = parseHandle(basename(worktree.path))
      if (parsed === undefined) continue
      ticketWorktrees.push({ worktree, handle: parsed.handle, id: parsed.id })
    }
    ticketWorktrees.sort((a, b) => (a.worktree.path < b.worktree.path ? -1 : a.worktree.path > b.worktree.path ? 1 : 0))
  }

  let fetched: boolean | undefined
  const fetchOnce = (): boolean => {
    if (fetched === undefined && mainRoot !== undefined) {
      const run = git(mainRoot, ['fetch', '--all', '--prune', '--quiet'])
      fetched = run.status === 0
      if (!fetched) warn(`kit cleanup: git fetch failed: ${firstLine(run.stderr) || `exit code ${String(run.status)}`}`)
    }
    return fetched === true
  }

  for (const { worktree, handle, id } of ticketWorktrees) {
    candidates.push(...foldersIn(join(worktree.path, projectRel, '.work')))
    const base = { kind: 'worktree' as const, path: worktree.path, worktree, handle, id }
    const result = lookUp(id)
    if (!('ticket' in result)) {
      candidates.push({ ...base, status: undefined, verdict: skip(result.reason) })
      continue
    }
    const { status, type } = result.ticket
    const judged = (verdict: Verdict): WorktreeCandidate => ({ ...base, status, verdict })
    if (!isDone(status)) {
      candidates.push(judged({ kind: 'keep' }))
      continue
    }
    if (type === undefined) {
      candidates.push(judged(skip(VERSION_SKEW)))
      continue
    }
    if (type.trim() === '') {
      candidates.push(judged(skip('no Type on the card (BOARD-011)')))
      continue
    }
    if (ticketTypeOf(type)?.handle !== handle) {
      candidates.push(judged(skip(`Type mismatch: the card's Type is ${type.trim()}, the worktree's is ${handle}`)))
      continue
    }
    const porcelain = git(worktree.path, ['status', '--porcelain'])
    if (porcelain.status !== 0) {
      candidates.push(judged(skip(`git status failed: ${firstLine(porcelain.stderr)}`)))
      continue
    }
    if (porcelain.stdout.trim() !== '') {
      candidates.push(judged(skip('uncommitted changes')))
      continue
    }
    if (!fetchOnce()) {
      candidates.push(judged(skip('fetch failed')))
      continue
    }
    const branch = worktree.branch ?? 'a detached HEAD'
    if (worktree.head === undefined) {
      candidates.push(judged(skip(`no HEAD for ${branch}`)))
      continue
    }
    const unpushed = git(mainRoot ?? worktree.path, ['rev-list', '--max-count=1', worktree.head, '--not', '--remotes'])
    if (unpushed.status !== 0) {
      candidates.push(judged(skip(`could not check for unpushed commits on ${branch}: ${firstLine(unpushed.stderr)}`)))
      continue
    }
    if (unpushed.stdout.trim() !== '') {
      candidates.push(judged(skip(`unpushed commits on ${branch}`)))
      continue
    }
    candidates.push(judged({ kind: 'delete' }))
  }

  // The listing.
  for (const candidate of candidates) {
    const verdict = candidate.verdict.kind === 'skip' ? `skip (${candidate.verdict.reason})` : candidate.verdict.kind
    log(`${candidate.path}  ${candidate.id ?? '-'}  ${candidate.status ?? '-'}  ${verdict}`)
  }
  if (!inGit) log(`worktrees skipped: ${projectRoot} is not a git repository`)

  if (candidates.length === 0) {
    log('nothing to clean')
    return 0
  }
  const marked = candidates.filter((candidate) => candidate.verdict.kind === 'delete')
  if (marked.length === 0) {
    log('nothing to delete')
    return 0
  }

  let chosen = marked
  if (opts.yes) {
    if (opts.only !== undefined) {
      const confirmed = new Set(opts.only.map((path) => real(path)))
      chosen = marked.filter((candidate) => confirmed.has(real(candidate.path)) || confirmed.has(resolve(candidate.path)))
      for (const candidate of marked) if (!chosen.includes(candidate)) log(`not confirmed  ${candidate.path}`)
    }
  } else {
    const folders = marked.filter((candidate) => candidate.kind === 'folder').length
    const prompt = `Delete ${folders} folders and remove ${marked.length - folders} worktrees? [y/N] `
    if (opts.ask === undefined) {
      log(`nothing was deleted: no terminal to confirm on; rerun with --yes to delete the ${marked.length} marked delete`)
      return 0
    }
    const answer = await opts.ask(prompt)
    if (answer === null || !/^(y|yes)$/i.test(answer.trim())) {
      log('nothing was deleted')
      return 0
    }
  }

  // The worktree the process stands in goes last.
  const here = real(process.cwd())
  const current = chosen.find((candidate): candidate is WorktreeCandidate => candidate.kind === 'worktree' && isInside(here, real(candidate.path)))
  let failed = false

  for (const candidate of chosen) {
    if (candidate.kind !== 'folder') continue
    const outcome = deleteFolder(candidate)
    if (outcome.startsWith('failed')) failed = true
    log(outcome)
  }
  const removals = chosen.filter((candidate): candidate is WorktreeCandidate => candidate.kind === 'worktree' && candidate !== current)
  if (current !== undefined) removals.push(current)
  for (const candidate of removals) {
    if (!removeWorktree(candidate, mainRoot ?? candidate.path, log)) failed = true
  }
  return failed ? 1 : 0
}

/** Delete one working folder after checking it is still a directory inside its .work/; the result line. */
function deleteFolder(candidate: FolderCandidate): string {
  const { path, work } = candidate
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return `already gone  ${path}`
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `failed  ${path}: no longer a directory`
  const inside = relative(real(work), real(path))
  if (inside === '' || inside.startsWith('..') || inside.includes(sep)) return `failed  ${path}: resolves outside ${work}`
  try {
    accessSync(work, constants.W_OK)
    rmSync(path, { recursive: true })
  } catch (error) {
    return existsSync(path) ? `failed  ${path}: ${errorMessage(error)}` : `already gone  ${path}`
  }
  return `deleted  ${path}`
}

/** `git worktree remove` (never --force), then `git branch -d` on its branch; false on a failed removal. */
function removeWorktree(candidate: WorktreeCandidate, mainRoot: string, log: Log): boolean {
  const { path, worktree } = candidate
  if (!existsSync(path)) {
    log(`already gone  ${path}`)
    return true
  }
  const removed = git(mainRoot, ['worktree', 'remove', path])
  if (removed.status !== 0) {
    log(`failed  ${path}: ${firstLine(removed.stderr) || `git worktree remove exited ${String(removed.status)}`}`)
    return false
  }
  log(`removed  ${path}`)
  if (worktree.branch !== undefined) {
    const branch = git(mainRoot, ['branch', '-d', worktree.branch])
    log(branch.status === 0 ? `branch deleted  ${worktree.branch}` : `branch kept  ${worktree.branch}: ${firstLine(branch.stderr)}`)
  }
  return true
}
