// F50: one worktree per ticket. A run works the ticket in `.worktrees/<TYPE>-<ID>` at the main
// repository's root (GIT-002, BOARD-011), on `<prefix>/<id>-<slug>` with the prefix from the card's
// Type (GIT-001). This module names both, finds where the driver is running (the main checkout or
// one of its worktrees), and prepares a new worktree: `git fetch origin main`, the GIT-002
// `git worktree add`, `.worktrees/` in .git/info/exclude when .gitignore does not list it, then the
// project's install and build. It carries the ticket's `.work/` folder over without overwriting
// anything there. It never removes a worktree (that is `kit cleanup`, KIT-13).
//
// Every git and project command goes through the system wrappers (system.ts).

import { existsSync } from 'node:fs'
import { appendFile, cp, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { slug } from '@aspiralabs/agent-common/lib/ticket'
import { tail } from '#src/redact.ts'
import { stateDirOf } from '#src/run-state.ts'
import { GIT_ARGS, packageManagerOf, shown, system, type CommandResult, type System, type SystemOptions } from '#src/system.ts'

/** The card's Type: the worktree folder's TYPE and the branch prefix. */
export const TICKET_TYPES = {
  Feature: { dir: 'FEATURE', prefix: 'feat' },
  Bug: { dir: 'BUG', prefix: 'fix' },
  Chore: { dir: 'CHORE', prefix: 'chore' },
} as const
export type TicketType = (typeof TICKET_TYPES)[keyof typeof TICKET_TYPES]

/** The Type's naming, or null when the card's Type is empty or not one of Feature, Bug and Chore. */
export function ticketTypeOf(type: string | null | undefined): TicketType | null {
  const wanted = (type ?? '').trim().toLowerCase()
  const key = (Object.keys(TICKET_TYPES) as (keyof typeof TICKET_TYPES)[]).find((name) => name.toLowerCase() === wanted)
  return key === undefined ? null : TICKET_TYPES[key]
}

/** `<prefix>/<id>-<slug>` (GIT-001). A card whose Type is unknown gets feat/, which the worktree gate never lets a run reach. */
export function ticketBranch(id: string, title: string, type: string | null | undefined): string {
  const prefix = ticketTypeOf(type)?.prefix ?? TICKET_TYPES.Feature.prefix
  return `${prefix}/${id.toLowerCase()}${slug(title) === '' ? '' : `-${slug(title)}`}`
}

/** `.worktrees/<TYPE>-<ID>` relative to the main repository's root. */
export const worktreePath = (type: TicketType, id: string): string => join('.worktrees', `${type.dir}-${id.toUpperCase()}`)

/** Where the driver runs: the top of its working tree and the main repository's root. */
export type Place = { top: string; main: string; commonDir: string }

/** The place of `repo`, or null when it is not inside a git repository. */
export async function locate(repo: string, env: NodeJS.ProcessEnv, sys: System = system): Promise<Place | null> {
  const options = { cwd: repo, env }
  const top = await sys.gitToplevel(options)
  const common = await sys.gitCommonDir(options)
  if (top.code !== 0 || common.code !== 0) return null
  const commonDir = await realpath(common.stdout.trim()).catch(() => common.stdout.trim())
  return { top: await realpath(top.stdout.trim()).catch(() => top.stdout.trim()), main: dirname(commonDir), commonDir }
}

/** The ticket's worktree that already exists under the main root (any Type), or null. */
export function existingWorktree(place: Place, id: string): string | null {
  for (const type of Object.values(TICKET_TYPES)) {
    const path = join(place.main, worktreePath(type, id))
    if (existsSync(path)) return path
  }
  return null
}

/** The ticket's worktree `place` is inside, or null when it runs anywhere else (the main checkout). */
export function insideWorktree(place: Place, id: string): string | null {
  return Object.values(TICKET_TYPES)
    .map((type) => join(place.main, worktreePath(type, id)))
    .find((path) => path === place.top) ?? null
}

/** .gitignore lists .worktrees/ (as `.worktrees`, `.worktrees/` or rooted). */
async function gitignoreLists(main: string): Promise<boolean> {
  const text = await readFile(join(main, '.gitignore'), 'utf8').catch(() => '')
  return text.split('\n').some((line) => /^\/?\.worktrees\/?(\*\*?)?$/.test(line.trim()))
}

/** Add `.worktrees/` to .git/info/exclude when .gitignore does not list it and exclude does not yet. Returns whether it added it. */
export async function excludeWorktrees(place: Place): Promise<boolean> {
  if (await gitignoreLists(place.main)) return false
  const file = join(place.commonDir, 'info', 'exclude')
  const text = await readFile(file, 'utf8').catch(() => '')
  if (text.split('\n').some((line) => /^\/?\.worktrees\/?$/.test(line.trim()))) return false
  await appendFile(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}.worktrees/\n`)
  return true
}

const packageSchema = z.looseObject({ scripts: z.record(z.string(), z.unknown()).optional() })

/** The project's install and build: pnpm install && pnpm build for a pnpm workspace with a build script, else the package manager's install. */
export async function installCommands(dir: string): Promise<{ command: string; args: string[] }[]> {
  const raw = await readFile(join(dir, 'package.json'), 'utf8').catch(() => null)
  if (raw === null) return []
  let scripts: Record<string, unknown> = {}
  try {
    const parsed = packageSchema.safeParse(JSON.parse(raw))
    scripts = parsed.success ? (parsed.data.scripts ?? {}) : {}
  } catch {
    scripts = {}
  }
  if (existsSync(join(dir, 'pnpm-workspace.yaml')) && typeof scripts.build === 'string') {
    return [
      { command: 'pnpm', args: ['install'] },
      { command: 'pnpm', args: ['build'] },
    ]
  }
  return [{ command: packageManagerOf([dir]), args: ['install'] }]
}

/** Copy the ticket's `.work/<id>-<slug>/` into the worktree, overwriting nothing and leaving the run state behind. */
export async function carryTicketFolder(folder: string, worktree: string): Promise<string> {
  const target = join(worktree, '.work', basename(folder))
  if (existsSync(folder)) {
    const runState = stateDirOf(folder)
    await cp(folder, target, { recursive: true, force: false, errorOnExist: false, filter: (source) => source !== runState && !source.startsWith(`${runState}/`) })
  }
  return target
}

export type Prepared = { ok: true; worktree: string; branch: string; created: boolean; ran: string[] } | { ok: false; message: string; command: string; exitCode: number; output: string }

const errorOf = (result: CommandResult): string => tail((result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).trim(), 20)

/** Make the ticket's worktree (or reuse it), exclude .worktrees/, and run the install and build in a new one. */
export async function prepareWorktree(input: { place: Place; id: string; title: string; type: TicketType; cardType: string; env: NodeJS.ProcessEnv }, sys: System = system): Promise<Prepared> {
  const { place, id, title, type, env } = input
  const path = worktreePath(type, id)
  const worktree = join(place.main, path)
  const branch = ticketBranch(id, title, input.cardType)
  const options: SystemOptions = { cwd: place.main, env }
  const fail = (command: string, result: CommandResult, why: string): Prepared => {
    const output = errorOf(result)
    return { ok: false, message: `${why}: \`${command}\` exited ${result.code}: ${output}`, command, exitCode: result.code, output }
  }
  if (existsSync(worktree)) return { ok: true, worktree, branch, created: false, ran: [] }
  const fetched = await sys.gitFetchMain(options)
  if (fetched.code !== 0) return fail(shown('git', GIT_ARGS.fetchMain), fetched, `the run could not fetch origin/main to start ${path} from it`)
  const exists = (await sys.gitBranchExists(options, branch)).code === 0
  const added = await sys.gitWorktreeAdd(options, path, branch, !exists)
  if (added.code !== 0) {
    const why = exists ? `the worktree ${path} could not be added on the existing branch ${branch} (when it is checked out in ${relative(place.main, place.top) || 'the main checkout'}, switch that checkout to main first)` : `the worktree ${path} could not be added`
    return fail(shown('git', GIT_ARGS.worktreeAdd(path, branch, !exists)), added, why)
  }
  await excludeWorktrees(place)
  const ran: string[] = []
  for (const { command, args } of await installCommands(worktree)) {
    const result = await sys.projectCommand({ cwd: worktree, env }, command, args)
    const line = shown(command, args)
    if (result.code !== 0) return fail(line, result, `the project's install and build failed in ${path}; the worktree is kept`)
    ran.push(line)
  }
  return { ok: true, worktree, branch, created: true, ran }
}
