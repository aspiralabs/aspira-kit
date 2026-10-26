// Looks a ticket up on the board through the installed agents' board module: the resolve script that
// the common folder of @aspiralabs/ai ships, run with node and amaro like the skill launchers do, with the
// project's .env.local. `kit next`, `kit cleanup` and `kit worktree` share it. Every way of not getting
// a ticket comes back as a reason with a one-line detail; this module writes nothing itself, so each
// caller prints the detail under its own command name.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ResolvedTicket } from './next.js'
import { aiPackageDir } from './skills.js'

/** Why there is no ticket. `cause` says whose side failed: the kit's install ('kit') or the board and its resolver ('board'). */
export type TicketLookupFailure = { reason: 'unknown ID' | 'board unreachable' | 'no Status on the card'; detail: string; cause: 'kit' | 'board' }

export type TicketLookupResult = { ticket: ResolvedTicket } | TicketLookupFailure

/** Looks up `ref` on `board`. `appDir` owns node_modules: `<projectRoot>/<app>` from aspira.json, or the root. Injected in tests. */
export type TicketLookup = (board: string, ref: string, projectRoot: string, appDir: string) => TicketLookupResult

/** The resolve script's key=value output. Older scripts print no type= or folder=; extra keys (pr, dev) are dropped. */
const ResolvedOutput = z.object({
  id: z.string().min(1),
  title: z.string(),
  url: z.string(),
  status: z.string(),
  type: z.string().optional(),
  folder: z.string().optional(),
})
type ResolvedOutput = z.infer<typeof ResolvedOutput>

/** The resolve script's `error=` line on failure: `unknown` when the board has no such ticket. */
const FailedOutput = z.object({ error: z.enum(['unknown', 'unreachable']) })

/** Lines folded into one, for a detail that prints as a single line. */
const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('; ')

/** key=value lines as a record; the first `=` splits, so values may hold `=`. */
function parseFields(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  return fields
}

/** The first `<ancestor of dir>/node_modules/<relative>` that exists, as Node resolution would find it. */
function findUpModule(dir: string, relative: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', relative)
    if (existsSync(candidate)) return candidate
    if (dirname(current) === current) return undefined
  }
}

/** The ticket from validated output; type and folder only when the script printed them ('' stays ''). */
function toTicket(output: ResolvedOutput): ResolvedTicket {
  const ticket: ResolvedTicket = { id: output.id, title: output.title, url: output.url, status: output.status }
  if (output.type !== undefined) ticket.type = output.type
  if (output.folder !== undefined) ticket.folder = output.folder
  return ticket
}

const kitFailure = (detail: string): TicketLookupFailure => ({ reason: 'board unreachable', detail, cause: 'kit' })

/** The default lookup: the common folder of the running kit (aiPackageDir: the global @aspiralabs/ai), run with its resolve script and the project's .env.local (the root's, then the app's, which wins). */
export const lookupTicket: TicketLookup = (board, ref, projectRoot, appDir) => {
  const ai = aiPackageDir()
  if (ai === undefined) {
    return kitFailure('@aspiralabs/ai is not found as the running kit (install it globally: pnpm add -g @aspiralabs/ai)')
  }
  const common = join(ai, 'common')
  const script = join(common, 'scripts', 'resolve-ticket.ts')
  if (!existsSync(script)) return kitFailure(`${script} is missing (the installed @aspiralabs/ai has no resolve script; update @aspiralabs/ai)`)
  // amaro is a dependency of @aspiralabs/ai. Resolve it the way Node would from its real location: the first ancestor with node_modules/amaro (pnpm keeps a package's
  // dependencies two levels up from a scoped package; npm and yarn hoist them to the app's root).
  const amaro = [common, ai, appDir]
    .map((dir) => findUpModule(realpathSync(dir), join('amaro', 'dist', 'register-strip.mjs')))
    .find((candidate) => candidate !== undefined)
  if (amaro === undefined) return kitFailure('amaro (the TypeScript loader the agents ship with) is not installed')
  const envFiles = [...new Set([join(projectRoot, '.env.local'), join(appDir, '.env.local')])].filter((file) => existsSync(file))
  const args = ['--import', amaro, '--experimental-strip-types', ...envFiles.map((file) => `--env-file=${file}`), script, ref, '--board', board]
  const run = spawnSync('node', args, { cwd: projectRoot, encoding: 'utf8' })
  if (run.error !== undefined) return kitFailure(`could not run the board resolver with node: ${run.error.message}`)
  const stdout = run.stdout
  const stderr = oneLine(run.stderr)
  const fields = parseFields(stdout)
  if (run.status !== 0) {
    const failed = FailedOutput.safeParse(fields)
    const said = stderr || oneLine(stdout) || `exit code ${String(run.status)}`
    if (failed.success && failed.data.error === 'unknown') return { reason: 'unknown ID', detail: said, cause: 'board' }
    return { reason: 'board unreachable', detail: `the board resolver failed: ${said}`, cause: 'board' }
  }
  const output = ResolvedOutput.safeParse(fields)
  if (!output.success) {
    return { reason: 'board unreachable', detail: `the board resolver printed no ticket: "${oneLine(stdout)}"${stderr ? ` (stderr: ${stderr})` : ''}`, cause: 'board' }
  }
  if (output.data.status.trim() === '') return { reason: 'no Status on the card', detail: `${output.data.id} has no Status on the board`, cause: 'board' }
  return { ticket: toTicket(output.data) }
}
