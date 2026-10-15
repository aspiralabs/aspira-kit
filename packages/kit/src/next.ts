// `kit next [<ticket>]`: what to run next for a ticket, from its Status and the Playbook table.
// The ticket is resolved live through the installed agents' board module (the one Notion client,
// run with node and amaro like the skill launchers do); without it, or when the board cannot be
// reached, the Status recorded in the ticket's working folder stands in and the output says so.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { appRoot, isNotionUrl, readAspira, readApp } from './aspira.js'
import { readJson, type Log } from './fs.js'
import { AGENTS, agentPackageDir } from './skills.js'
import { commandFor, nextStep, PLAYBOOK, type PlaybookRow } from './playbook.js'

export type ResolvedTicket = { id: string; title: string; url: string; status: string }

/** Resolves a ticket on a board; null when it cannot (the agents are not installed, no token, no network). `appDir` owns node_modules: `<projectRoot>/<app>` from aspira.json, or the root. */
export type Resolver = (board: string, ref: string, projectRoot: string, appDir: string) => ResolvedTicket | null

/** A working folder's ticket.md, read the way the agents write it: the Field/Value table and the title line. */
export function readWorkTicket(folder: string): ResolvedTicket | null {
  const file = join(folder, 'ticket.md')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const title = text.match(/^# ([^:\n]+): (.*)$/m)
  if (title === null) return null
  const field = (name: string) => text.match(new RegExp(`^\\| ${name} \\| (.*?) \\|\\s*$`, 'm'))?.[1]?.trim() ?? ''
  return { id: field('ID') || title[1]!.trim(), title: title[2]!.trim(), url: field('URL'), status: field('Status') }
}

/** Every folder under .work/ with a ticket.md. */
export function workTickets(projectRoot: string): { folder: string; ticket: ResolvedTicket }[] {
  const dir = join(projectRoot, '.work')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const folder = join(dir, entry.name)
      const ticket = readWorkTicket(folder)
      return ticket === null ? [] : [{ folder, ticket }]
    })
}

const isTicketRef = (value: string) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value) || /^\d+$/.test(value) || isNotionUrl(value)

/** The first `<ancestor of dir>/node_modules/<relative>` that exists, as Node resolution would find it. */
function findUpModule(dir: string, relative: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', relative)
    if (existsSync(candidate)) return candidate
    if (dirname(current) === current) return undefined
  }
}

/** The default resolver: the @aspiralabs/agent-common installed under the app's node_modules, run with its resolve script and the project's .env.local (the root's, then the app's, which wins). */
export const liveResolver: Resolver = (board, ref, projectRoot, appDir) => {
  const common = agentPackageDir(appDir, 'agent-common')
  if (common === undefined) return null
  const script = join(common, 'scripts', 'resolve-ticket.ts')
  // amaro is a dependency of the six agents, not of agent-common. Resolve it the way Node would from
  // an agent's real location: the first ancestor with node_modules/amaro (pnpm keeps a package's
  // dependencies two levels up from a scoped package; npm and yarn hoist them to the app's root).
  const amaro = [common, ...AGENTS.map((agent) => agentPackageDir(appDir, agent)), appDir]
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => findUpModule(realpathSync(dir), join('amaro', 'dist', 'register-strip.mjs')))
    .find((candidate) => candidate !== undefined)
  if (!existsSync(script) || amaro === undefined) {
    process.stderr.write(`kit next: ${existsSync(script) ? 'amaro (the TypeScript loader the agents ship with) is not installed' : `${script} is missing`}\n`)
    return null
  }
  const envFiles = [...new Set([join(projectRoot, '.env.local'), join(appDir, '.env.local')])].filter((file) => existsSync(file))
  const args = ['--import', amaro, '--experimental-strip-types', ...envFiles.map((file) => `--env-file=${file}`), script, ref, '--board', board]
  const run = spawnSync('node', args, { cwd: projectRoot, encoding: 'utf8' })
  if (run.status !== 0) {
    process.stderr.write(`kit next: the board resolver failed:\n${run.stderr ?? ''}`)
    return null
  }
  const fields = Object.fromEntries(run.stdout.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  if (!fields.id || !fields.status) return null
  return { id: fields.id, title: fields.title ?? '', url: fields.url ?? '', status: fields.status }
}

/**
 * A progress note's `## Ticket` fields and `## Next action` block, read with kit's own light
 * parser (kit never imports `@aspiralabs/agent-common`'s TypeScript source at runtime, PATTERN-012:
 * the note is plain markdown on disk, the same contract `progress-note.ts` there renders). Null
 * when the text has no `Status:`/`Written:` line, or no `Step:` and no `Run:` line (F29: nothing to
 * resume from, so the caller falls back as if there were no note at all).
 */
export type ProgressNoteInfo = { status: string; expectedStatus: string | null; written: string; step: string; do: string[]; run: string[]; session: string }

/** Reads `progress.md`'s text. Exported for the tests; `next` never reads a path itself. */
export function readProgressNote(text: string): ProgressNoteInfo | null {
  const lines = text.split('\n')
  const field = (prefix: string): string | undefined => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim()
  const status = field('Status: ')
  const written = field('Written: ')
  if (status === undefined || written === undefined) return null
  const expectedRaw = field('Expected Status: ')
  const expectedStatus = expectedRaw === undefined || expectedRaw === '(none)' ? null : expectedRaw
  const actionStart = lines.findIndex((line) => line.trim() === '## Next action')
  const action = actionStart === -1 ? [] : lines.slice(actionStart + 1)
  const step = action.find((line) => line.startsWith('Step: '))?.slice('Step: '.length).trim()
  const run = action.filter((line) => line.startsWith('Run: ')).map((line) => line.slice('Run: '.length).trim())
  if (step === undefined && run.length === 0) return null
  const doLines = action.filter((line) => line.startsWith('Do: ')).map((line) => line.slice('Do: '.length).trim())
  const session = action.find((line) => line.startsWith('Session: '))?.slice('Session: '.length).trim() ?? ''
  return { status, expectedStatus, written, step: step ?? '', do: doLines, run, session }
}

/** The folders that might hold this ticket's `progress.md`: the main `.work/<slug>` folder, and the
 * same slug under every ticket worktree's own `.work` folder (`.worktrees/<name>/.work/<slug>`,
 * F28). The first entry is always the main folder. */
export function noteFolders(projectRoot: string, slug: string): string[] {
  const worktreesDir = join(projectRoot, '.worktrees')
  const worktreeFolders = existsSync(worktreesDir)
    ? readdirSync(worktreesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(worktreesDir, entry.name, '.work', slug))
    : []
  return [join(projectRoot, '.work', slug), ...worktreeFolders]
}

type NoteCandidate = { folder: string; isWorktree: boolean; note: ProgressNoteInfo }

/** The note to use among `folders` (every one that has a readable `progress.md`): the later
 * `Written:` wins, the non-main (worktree) folder wins a tie. Null when none has a usable note. */
function bestNote(folders: readonly string[], mainFolder: string): NoteCandidate | null {
  const candidates = folders
    .map((folder) => {
      const file = join(folder, 'progress.md')
      return { folder, isWorktree: folder !== mainFolder, text: existsSync(file) ? readFileSync(file, 'utf8') : null }
    })
    .flatMap((entry): NoteCandidate[] => {
      const note = entry.text === null ? null : readProgressNote(entry.text)
      return note === null ? [] : [{ folder: entry.folder, isWorktree: entry.isWorktree, note }]
    })
  return candidates.reduce<NoteCandidate | null>((best, candidate) => {
    if (best === null || candidate.note.written > best.note.written) return candidate
    if (candidate.note.written < best.note.written) return best
    return candidate.isWorktree ? candidate : best
  }, null)
}

const hasCommand = (row: PlaybookRow): row is PlaybookRow & { command: string } => row.command !== null

/** The launcher form of any Playbook agent's slash command: `.claude/skills/aspira-<agent>/scripts/
 * <agent>.sh local <ID>`, with `--app <dir>`, `--verify` and `--pr-url <url>` (Step 8's PR-open
 * commands) optionally after it. */
const LAUNCHER_SHAPE = /^\.claude\/skills\/aspira-[a-z][a-z-]*\/scripts\/[a-z][a-z-]*\.sh local [A-Za-z0-9-]+( --app [^\s]+)?( --verify)?( --pr-url \S+)?( --replace-pending)?$/

/**
 * The Run-line shapes a progress note's Next action may use (F28): every Playbook slash command
 * (`<ID>` and `<app-dir>` wildcarded), kit's own launcher form, and whatever extra shell-command
 * shapes (`git push`, `gh pr create`, ...) `progress-note-shapes.json` names in the installed
 * `@aspiralabs/agent-common` — read as plain JSON (PATTERN-012), never agent-common's TypeScript.
 */
export function loadNoteShapes(appDir: string): RegExp[] {
  const builtin: RegExp[] = [
    ...PLAYBOOK.filter(hasCommand).map((row) => new RegExp(`^${row.command.replaceAll('<ID>', '[A-Za-z0-9-]+').replaceAll('<app-dir>', '[\\w./-]+')}$`)),
    LAUNCHER_SHAPE,
  ]
  const dir = agentPackageDir(appDir, 'agent-common')
  const file = dir === undefined ? undefined : join(dir, 'src', 'lib', 'progress-note-shapes.json')
  const shapes = file === undefined ? undefined : readJson<{ commands?: unknown }>(file)
  const commands = Array.isArray(shapes?.commands) ? shapes.commands.filter((pattern): pattern is string => typeof pattern === 'string') : []
  return [...builtin, ...commands.map((pattern) => new RegExp(pattern))]
}

type NoteMatch = { ok: true } | { ok: false; reason: string }

/** Whether `note` is usable for `liveStatus` (F28): its Status (or, for a `--verify` Next action,
 * its Expected Status) must equal the live Status, and every Run line must match one of `shapes`. */
function noteMatches(note: ProgressNoteInfo, liveStatus: string, shapes: readonly RegExp[]): NoteMatch {
  const verifying = note.run.some((line) => line.includes('--verify'))
  const compareTo = verifying ? note.expectedStatus : note.status
  if (compareTo === null || compareTo.trim().toLowerCase() !== liveStatus.trim().toLowerCase()) {
    const label = verifying ? 'Expected Status' : 'Status'
    return { ok: false, reason: `progress.md is older than the board: its ${label} is "${compareTo ?? '(none)'}", the board's Status is "${liveStatus}"; rerun the step it names` }
  }
  const unrecognised = note.run.find((line) => !shapes.some((shape) => shape.test(line)))
  if (unrecognised !== undefined) return { ok: false, reason: `progress.md's Run line does not match a known command shape, so it was not used: ${unrecognised}` }
  return { ok: true }
}

/** Print the next step for a ticket. Exit 0 with a step, 1 when the ticket or the board cannot be found, 2 for a bad argument. `app` (--app) overrides the one in aspira.json. */
export function next(projectRoot: string, ref: string | undefined, log: Log, resolve: Resolver = liveResolver, app?: string): number {
  const config = readAspira(projectRoot)
  if (!isNotionUrl(config?.board)) {
    log('no aspira.json with a Feature Board here; run kit init --board <Feature Board URL>')
    return 1
  }
  const folders = workTickets(projectRoot)
  let wanted: string
  let localEntry: { folder: string; ticket: ResolvedTicket } | null = null
  if (ref !== undefined && ref !== '') {
    if (!isTicketRef(ref)) {
      log(`not a ticket: ${ref} (an ID such as NOM-4, or a Notion page URL)`)
      return 2
    }
    wanted = ref
    localEntry = folders.find((entry) => entry.ticket.id.toLowerCase() === ref.toLowerCase() || (isNotionUrl(ref) && entry.ticket.url.replace(/-/g, '').endsWith(ref.replace(/-/g, '').replace(/^.*\//, '').replace(/\?.*$/, '')))) ?? null
  } else if (folders.length === 1) {
    wanted = folders[0]!.ticket.id
    localEntry = folders[0]!
  } else if (folders.length === 0) {
    log('no ticket given and no folder under .work/ holds a ticket.md; name the ticket: kit next <ID>')
    return 1
  } else {
    log(`no ticket given and ${folders.length} folders under .work/ hold a ticket.md: ${folders.map((entry) => entry.folder).join(', ')}; name the ticket`)
    return 1
  }
  const appDir = appRoot(projectRoot, app ?? readApp(projectRoot))
  const live = resolve(config.board, wanted, projectRoot, appDir)
  const ticket = live ?? localEntry?.ticket ?? null
  if (ticket === null) {
    log(`cannot resolve ${wanted}: the board did not answer (see the error above; NOTION_TOKEN goes in .env.local at the project root or in the app's) and no working folder holds it`)
    return 1
  }
  const row = nextStep(ticket.status)
  log(`ticket   ${ticket.id} ${ticket.title}${ticket.url ? ` (${ticket.url})` : ''}`)
  log(`status   ${ticket.status}${live === null ? ' (as pulled into the working folder; the board did not answer)' : ''}`)
  if (row === null) {
    log(`next     unknown: the Playbook has no row for "${ticket.status}"`)
    return 1
  }

  // Before the Status table: a progress note already written for this ticket (F28). The later
  // Written: wins across the main checkout and every ticket worktree; the note is used only when
  // its Status (or, for a --verify Next action, its Expected Status) matches the live Status and
  // every Run line is a known command shape. A note with no usable Next action (F29), or none of
  // this ticket's folders having one, is silently the same as no note at all.
  let usedNote: NoteCandidate | null = null
  let noteReason: string | null = null
  if (localEntry !== null) {
    const candidate = bestNote(noteFolders(projectRoot, basename(localEntry.folder)), localEntry.folder)
    if (candidate !== null) {
      const match = noteMatches(candidate.note, ticket.status, loadNoteShapes(appDir))
      if (match.ok) usedNote = candidate
      else noteReason = match.reason
    }
  }
  if (usedNote !== null) {
    if (usedNote.isWorktree) log(`note     read from the worktree's progress.md (${usedNote.folder})`)
    log(`next     ${usedNote.note.step}`)
    for (const line of usedNote.note.do) log(`do       ${line}`)
    for (const line of usedNote.note.run) log(`run      ${line}`)
    log(`session  ${usedNote.note.session}`)
    return 0
  }
  log(`next     ${row.step}`)
  log(`run      ${commandFor(row, ticket.id) ?? 'by hand, on the board'}`)
  log(`who      ${row.who}`)
  if (noteReason !== null) log(`note     ${noteReason}`)
  return 0
}
