// F50: one worktree per ticket. A run works the ticket in `.worktrees/<TYPE>-<ID>` at the main
// repository's root (GIT-002, BOARD-011), on `<prefix>/<id>-<slug>` with the prefix from the card's
// Type (GIT-001). This module names both, finds where the driver is running (the main checkout or
// one of its worktrees), and prepares a new worktree: `git fetch origin main`, the GIT-002
// `git worktree add`, `.worktrees/` in .git/info/exclude when .gitignore does not list it, then the
// project's install and build. It carries the ticket's `.work/` folder over without overwriting
// anything there. It never removes a worktree (that is `kit cleanup`, KIT-13).
//
// Every git and project command goes through the system wrappers (system.ts).

import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { appendFile, cp, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { tail } from '@aspiralabs/ai/common/lib/redact'
import { TICKET_TYPES, ticketBranch, ticketTypeOf, type TicketType } from '@aspiralabs/ai/common/lib/ticket-branch'
import { stateDirOf } from '#build-feature/run-state.ts'
import { GIT_ARGS, packageManagerOf, shown, system, type CommandResult, type System, type SystemOptions } from '#build-feature/system.ts'

/** Re-exported so existing build-feature imports of this module keep compiling; the definitions now live in agent-common. */
export { TICKET_TYPES, ticketBranch, ticketTypeOf, type TicketType }

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

/** Link `<from>/<dir>/.env.local` to the same place under `to` for each dir; a missing source or an occupied target is skipped. Returns one line per link made. */
export function linkEnvLocal(from: string, to: string, dirs: readonly string[]): string[] {
  const made: string[] = []
  for (const dir of dirs) {
    const source = join(from, dir, '.env.local')
    const target = join(to, dir, '.env.local')
    if (!existsSync(source) || !existsSync(join(to, dir))) continue
    try { lstatSync(target); continue } catch { /* nothing at the target: link it */ }
    try { symlinkSync(source, target); made.push(`ln -s ${source} ${target}`) } catch { /* a link is a convenience; the install says what is missing */ }
  }
  return made
}

const errorOf = (result: CommandResult): string => tail((result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).trim(), 20)

const resourceKeys = z.looseObject({
  app: z.string().optional(),
  database: z.looseObject({ envVars: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).default([]) }).optional(),
  tunnel: z.looseObject({}).optional(),
  webhooks: z.array(z.looseObject({ secretEnvVar: z.string().optional() })).optional(),
})

/**
 * Whether an existing worktree still lacks something its aspira.json asks the kit to make: a database variable
 * in the app's .env.development.local, the tunnel config, a webhook secret. A project with none of those keys
 * (a placeholder dev url alone is `kit worktree`'s) and a worktree that has them all are not pending.
 */
export async function isolationPending(worktree: string): Promise<boolean> {
  const raw = await readFile(join(worktree, 'aspira.json'), 'utf8').catch(() => null)
  if (raw === null) return false
  let config: z.infer<typeof resourceKeys>
  try {
    config = resourceKeys.parse(JSON.parse(raw))
  } catch {
    return false
  }
  const webhooks = config.webhooks ?? []
  if (config.database === undefined && config.tunnel === undefined && webhooks.length === 0) return false
  const app = config.app === undefined || config.app === '' ? '.' : config.app
  const text = await readFile(join(worktree, app, '.env.development.local'), 'utf8').catch(() => '')
  const has = (name: string): boolean => new RegExp(`^\\s*${name}\\s*=\\s*\\S`, 'm').test(text)
  if (config.database?.envVars.some((entry) => !has(typeof entry === 'string' ? entry : entry.name))) return true
  if ((config.tunnel !== undefined || webhooks.length > 0) && !existsSync(join(worktree, app, '.aspira', 'cloudflared.yml')) && !existsSync(join(worktree, '.aspira', 'cloudflared.yml'))) return true
  return webhooks.some((hook) => !has(hook.secretEnvVar ?? 'STRIPE_WEBHOOK_SECRET'))
}

type Failed = Extract<Prepared, { ok: false }>

/** Run the kit's isolation in an existing ticket worktree: ok, or a failure naming the step (the worktree is kept; a rerun resumes). */
export async function isolateIn(input: { place: Place; id: string; worktree: string; env: NodeJS.ProcessEnv; onlyIfPending?: boolean }, sys: System = system): Promise<{ ok: true } | Failed> {
  if (input.onlyIfPending === true && !(await isolationPending(input.worktree))) return { ok: true }
  const result = await sys.isolateWorktree({ main: input.place.main, worktree: input.worktree, ticket: input.id, env: input.env })
  if (result.ok) return { ok: true }
  const command = `isolation: ${result.step}`
  return { ok: false, message: `the worktree's isolation failed at the ${result.step} step: ${result.reason}; the worktree is kept, rerun the run to resume it`, command, exitCode: 1, output: tail(result.reason, 20) }
}

/** Make the ticket's worktree (or reuse it), exclude .worktrees/, and run the install and build in a new one, in the project's `app` directory from aspira.json when it names one (KIT-21). */
export async function prepareWorktree(input: { place: Place; id: string; title: string; type: TicketType; cardType: string; env: NodeJS.ProcessEnv; app?: string; skipIsolation?: boolean }, sys: System = system): Promise<Prepared> {
  const { place, id, title, type, env } = input
  const path = worktreePath(type, id)
  const worktree = join(place.main, path)
  const branch = ticketBranch(id, title, input.cardType)
  const options: SystemOptions = { cwd: place.main, env }
  const fail = (command: string, result: CommandResult, why: string): Prepared => {
    const output = errorOf(result)
    return { ok: false, message: `${why}: \`${command}\` exited ${result.code}: ${output}`, command, exitCode: result.code, output }
  }
  if (existsSync(worktree)) {
    // A rerun completes missing isolation instead of returning (KIT-67 F1); a merged ticket's is never rebuilt.
    if (input.skipIsolation !== true) {
      const isolated = await isolateIn({ place, id, worktree, env, onlyIfPending: true }, sys)
      if (!isolated.ok) return isolated
    }
    return { ok: true, worktree, branch, created: false, ran: [] }
  }
  const fetched = await sys.gitFetchMain(options)
  if (fetched.code !== 0) return fail(shown('git', GIT_ARGS.fetchMain), fetched, `the run could not fetch origin/main to start ${path} from it`)
  const exists = (await sys.gitBranchExists(options, branch)).code === 0
  const added = await sys.gitWorktreeAdd(options, path, branch, !exists)
  if (added.code !== 0) {
    const why = exists ? `the worktree ${path} could not be added on the existing branch ${branch} (when it is checked out in ${relative(place.main, place.top) || 'the main checkout'}, switch that checkout to main first)` : `the worktree ${path} could not be added`
    return fail(shown('git', GIT_ARGS.worktreeAdd(path, branch, !exists)), added, why)
  }
  await excludeWorktrees(place)
  // The main checkout's .env.local files, linked in (the root's, then the app's), as kit worktree does (KIT-49):
  // the install and the first step need the project's keys, and a worktree has none of its own.
  const linked = linkEnvLocal(place.main, worktree, ['', ...(input.app === undefined || input.app === '.' ? [] : [input.app])])
  const ran: string[] = [...linked]
  // Isolation after the worktree exists and before the install, so the install and build see the branch's own environment (KIT-67).
  const isolated = await isolateIn({ place, id, worktree, env }, sys)
  if (!isolated.ok) return isolated
  const installDir = join(worktree, input.app ?? '.')
  for (const { command, args } of await installCommands(installDir)) {
    const result = await sys.projectCommand({ cwd: installDir, env }, command, args)
    const line = shown(command, args)
    if (result.code !== 0) return fail(line, result, `the project's install and build failed in ${path}; the worktree is kept`)
    ran.push(line)
  }
  return { ok: true, worktree, branch, created: true, ran }
}
