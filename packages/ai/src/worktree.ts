// `kit worktree <ID>`: gives a ticket its own git worktree the GIT-002 way. It looks the card up
// live (TicketLookup, injected in tests), refuses a card it cannot place (no answer, version skew,
// no or unknown Type, Released or Dropped), fetches origin, then creates or reuses the worktree at
// `<main checkout root>/.worktrees/<HANDLE>-<ID>` on the ticket's GIT-001 branch, links the main
// checkout's .env.local files into it, and runs install and build where `kit init` would. Every git
// command runs as `git -C <main checkout root>`, so it behaves the same from inside another worktree.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { appRoot, isNotionUrl, readApp, readAspira } from './aspira.js'
import { readJson, type Log } from './fs.js'
import { git, listWorktrees, mainCheckoutRoot, repositoryRoot, type Worktree } from './git.js'
import type { ResolvedTicket } from './next.js'
import { nextStep } from './playbook.js'
import { KIT_VERSION, packageManager, workspaceDirOf } from './stacks/next.js'
import { isTicketRef, ticketTypeOf, type TicketTypeRow } from './ticket-handle.js'
import { lookupTicket, type TicketLookup } from './ticket-lookup.js'

export type WorktreeOptions = {
  /** The project root (where aspira.json is), in the main checkout or in any of its worktrees. */
  projectRoot: string
  /** `--app`: overrides the app recorded in aspira.json. */
  app?: string | undefined
  /** The ticket: an ID such as KIT-13, or a Notion page URL. */
  ref: string
  /** Looks the ticket up on the board; the installed agents' resolver by default. */
  lookup?: TicketLookup
  /** `--install`: run install and build even on a reused branch this machine did not make under today's name. */
  install?: boolean | undefined
  log: Log
}

/** A ticket the kit can place: its ID, Type row (handle and branch prefix) and working-folder name. */
type Placed = { id: string; row: TicketTypeRow; folder: string }

/** The package.json fields this command reads: only whether a build script exists. */
const PackageScripts = z.object({ scripts: z.record(z.string(), z.unknown()).optional() })

/** Statuses whose card gets no worktree: the Playbook has no build step left and cleanup would remove it (Q5.7). */
const FINISHED = ['Released', 'Dropped']

/** How many trailing lines of a failed install or build to show. */
const TAIL_LINES = 15

const say = (log: Log, message: string): void => log(`kit worktree: ${message}`)

/** Lines folded into one, for git's message on a single line. */
const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('; ')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `path` with symlinks resolved when it exists, so git's paths and ours compare equal. */
const canonical = (path: string): string => (existsSync(path) ? realpathSync(path) : path)

/** Why the kit cannot give this ticket a worktree, or the ticket placed: its handle row and folder. */
function placeTicket(ticket: ResolvedTicket, ref: string): { refusal: string } | Placed {
  const { id, type, folder, status } = ticket
  if (type === undefined || folder === undefined) {
    return { refusal: `the installed @aspiralabs/ai does not report the card's Type; install @aspiralabs/ai at the kit's version${KIT_VERSION === undefined ? '' : ` (${KIT_VERSION})`} and run kit init` }
  }
  const row = ticketTypeOf(type)
  if (row === undefined) {
    if (type.trim() === '') return { refusal: `${id} has no Type on the board; set Type to Feature, Bug or Chore (BOARD-011), which gives the card its handle and branch prefix` }
    return { refusal: `Type ${type.trim()} has no handle or branch prefix (BOARD-011)` }
  }
  if (!isTicketRef(id)) return { refusal: `the board resolved ${ref} to "${id}", which is not a ticket ID` }
  if (folder.trim() === '') return { refusal: `the board resolver printed an empty working-folder name for ${id}; update @aspiralabs/ai` }
  const isFinished = nextStep(status)?.statuses.some((candidate) => FINISHED.includes(candidate)) ?? false
  if (isFinished) return { refusal: `${id}'s Status is ${status.trim()}: a Released or Dropped card gets no worktree (kit cleanup would remove it)` }
  return { id, row, folder: folder.trim() }
}

/** Short branch names under `prefix` (refs/heads/ or refs/remotes/origin/), without origin/HEAD. */
function refsUnder(main: string, prefix: string): string[] {
  const run = git(main, ['for-each-ref', '--format=%(refname)', prefix])
  if (run.status !== 0) return []
  return run.stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .filter((name) => name !== 'HEAD')
}

/** The last `count` non-empty lines of a command's output, for a failure report. */
function tail(output: string, count: number): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-count)
}

/** Whether `dir`'s package.json has a build script. */
function hasBuildScript(dir: string): boolean {
  const parsed = PackageScripts.safeParse(readJson<unknown>(join(dir, 'package.json')))
  return parsed.success && typeof parsed.data.scripts?.build === 'string'
}

/** Run `<pm> <args>` in `dir`; true when it exits 0, else the failure and its output's tail are logged. */
function runStep(log: Log, step: 'install' | 'build', dir: string, pm: string, args: readonly string[]): boolean {
  const command = `${pm} ${args.join(' ')}`
  log(`${step.padEnd(8)} ${dir}: ${command}`)
  const run = spawnSync(pm, args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (run.error === undefined && run.status === 0) return true
  const why = run.error === undefined ? `exit code ${String(run.status)}` : run.error.message
  say(log, `${step} failed in ${dir} (${command}: ${why})`)
  for (const line of tail(`${run.stdout ?? ''}\n${run.stderr ?? ''}`, TAIL_LINES)) log(`  ${line}`)
  return false
}

/** Link `<from>/<dir>/.env.local` to the same place under `to`; a missing source or an occupied target is skipped and said. */
function linkEnvLocal(log: Log, from: string, to: string, dir: string): void {
  const source = join(from, dir, '.env.local')
  const target = join(to, dir, '.env.local')
  if (!existsSync(source)) {
    log(`skip     ${source} (the main checkout has none)`)
    return
  }
  if (!existsSync(join(to, dir))) {
    log(`skip     ${target} (${join(to, dir)} is not in the worktree)`)
    return
  }
  try {
    lstatSync(target)
    log(`keep     ${target} (already there)`)
    return
  } catch {
    // No file at the target: link it below.
  }
  try {
    symlinkSync(source, target)
    log(`link     ${target} -> ${source}`)
  } catch (error) {
    say(log, `could not link ${target} -> ${source}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Create or reuse the ticket's worktree at `<main checkout root>/.worktrees/<HANDLE>-<ID>` (GIT-002) on
 * its `<prefix>/<folder>` branch (GIT-001), link .env.local, install and build. Ends with the worktree's
 * path and branch on their own lines. Exit 0 when the worktree was created or already existed, 1 when
 * it refuses or install or build fails (the worktree stays), 2 for a ref that is not a ticket.
 */
export function worktree(options: WorktreeOptions): number {
  const { projectRoot, ref, log } = options
  const lookup = options.lookup ?? lookupTicket
  if (!isTicketRef(ref)) {
    log(`not a ticket: ${ref} (an ID such as KIT-13, or a Notion page URL)`)
    return 2
  }
  const config = readAspira(projectRoot)
  if (!isNotionUrl(config?.board)) {
    log('no aspira.json with a Feature Board here; run kit init --board <Feature Board URL>')
    return 1
  }
  const appOption = options.app ?? readApp(projectRoot)
  const app = appOption === undefined || appOption === '.' ? undefined : appOption

  // 1. The card, live.
  const result = lookup(config.board, ref, projectRoot, appRoot(projectRoot, app))
  if (!('ticket' in result)) {
    say(log, `cannot resolve ${ref}: ${result.reason} (${result.detail})`)
    return 1
  }
  const placed = placeTicket(result.ticket, ref)
  if ('refusal' in placed) {
    say(log, placed.refusal)
    return 1
  }
  const { id, row, folder } = placed

  // 2. Where: under the main checkout, at the same project path inside the worktree.
  const main = mainCheckoutRoot(projectRoot)
  const top = repositoryRoot(projectRoot)
  if (main === undefined || top === undefined) {
    say(log, `${projectRoot} is not in a git repository`)
    return 1
  }
  const projectPath = relative(canonical(top), canonical(projectRoot))
  const mainProject = join(main, projectPath)
  const target = join(main, '.worktrees', `${row.handle}-${id}`)
  const wanted = `${row.prefix}/${folder}`
  log(`ticket   ${id} ${result.ticket.title} (${row.type}, ${result.ticket.status.trim()})`)

  // 3. Fresh refs; a failed fetch goes on with the last-fetched ones.
  const fetch = git(main, ['fetch', 'origin'])
  if (fetch.status === 0) log(`fetch    origin (in ${main})`)
  else say(log, `git fetch origin failed (${oneLine(fetch.stderr)}); continuing with the last-fetched refs, so origin/main and origin/${wanted} may be stale`)

  // 4. The worktree or its branch already there.
  const worktrees: Worktree[] = listWorktrees(main) ?? []
  const registered = worktrees.find((entry) => canonical(entry.path) === canonical(target))
  if (existsSync(target)) {
    if (registered === undefined) {
      say(log, `${target} exists but is not a registered worktree; move or remove it, then rerun`)
      return 1
    }
    log(`exists   ${target} (already a worktree${registered.branch === undefined ? '' : ` on ${registered.branch}`})`)
    log(target)
    log(registered.branch ?? '(detached HEAD)')
    return 0
  }
  const matchesTicket = new RegExp(`^(feat|fix|chore)/${escapeRegExp(id.toLowerCase())}-`)
  const local = refsUnder(main, 'refs/heads/').filter((name) => matchesTicket.test(name))
  const remote = refsUnder(main, 'refs/remotes/origin/').filter((name) => matchesTicket.test(name))
  const matches = [...new Set([...local, ...remote])].toSorted()
  if (matches.length > 1) {
    say(log, `${String(matches.length)} branches match ${id}, so none is picked: ${matches.map((name) => (local.includes(name) ? name : `origin/${name}`)).join(', ')}; delete or rename all but one, then rerun`)
    return 1
  }
  const [existing] = matches
  // A branch from origin only, or one under another name, may hold scripts nobody here has read; install and
  // build would run them with .env.local linked in, so they wait for --install (AVA1.1).
  let unreviewed = false
  let branch = wanted
  let addArgs = ['worktree', 'add', '-b', wanted, target, 'origin/main']
  if (existing !== undefined) {
    const elsewhere = worktrees.find((entry) => entry.branch === existing)
    if (elsewhere !== undefined) {
      say(log, `branch ${existing} is checked out in ${elsewhere.path}; switch that checkout to another branch, then rerun`)
      return 1
    }
    const isLocal = local.includes(existing)
    const startPoint = isLocal ? existing : `origin/${existing}`
    branch = existing
    unreviewed = !isLocal || existing !== wanted
    log(`branch   reusing ${startPoint}${existing === wanted ? '' : ` (differs from ${wanted}, the name the card's title gives today)`}`)
    const last = git(main, ['log', '-1', '--format=%h %s', startPoint])
    if (last.status === 0) log(`commit   ${last.stdout.trim()}`)
    addArgs = isLocal ? ['worktree', 'add', target, existing] : ['worktree', 'add', '--track', '-b', existing, target, startPoint]
  } else {
    log(`branch   ${wanted} (new, from origin/main)`)
  }
  const add = git(main, addArgs)
  if (add.status !== 0) {
    say(log, `git worktree add failed: ${oneLine(add.stderr) || `exit code ${String(add.status)}`}${existsSync(target) ? `; ${target} exists` : ''}`)
    return 1
  }
  log(`created  ${target} on ${branch}`)

  // 5. The main checkout's .env.local files, linked (the root's, then the app's).
  const worktreeProject = join(target, projectPath)
  const envDirs = app === undefined ? [''] : ['', app]
  for (const dir of envDirs) linkEnvLocal(log, mainProject, worktreeProject, dir)

  // 6. Install and build where kit init installs.
  const workDir = workspaceDirOf(worktreeProject, app)
  if (!existsSync(join(workDir, 'package.json'))) {
    log(`skip     install and build (no package.json in ${workDir})`)
  } else if (unreviewed && options.install !== true) {
    const pm = packageManager(workDir)
    log(`skip     install and build: ${branch} was not made here under today's name, so its scripts are unread; read its last commit above, then run ${pm} install and ${pm} run build in ${workDir}, or rerun with --install`)
  } else {
    const pm = packageManager(workDir)
    if (!runStep(log, 'install', workDir, pm, ['install'])) {
      say(log, `the worktree stays at ${target} on ${branch}`)
      return 1
    }
    if (!hasBuildScript(workDir)) {
      log(`build    skipped (${join(workDir, 'package.json')} has no build script)`)
    } else if (!runStep(log, 'build', workDir, pm, ['run', 'build'])) {
      say(log, `the worktree stays at ${target} on ${branch}`)
      return 1
    }
  }

  // 7. The values /aspira-worktree switches the session to.
  log(target)
  log(branch)
  return 0
}
