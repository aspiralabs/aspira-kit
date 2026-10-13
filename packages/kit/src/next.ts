// `kit next [<ticket>]`: what to run next for a ticket, from its Status and the Playbook table.
// The ticket is resolved live through the installed agents' board module (the one Notion client,
// run with node and amaro like the skill launchers do); without it, or when the board cannot be
// reached, the Status recorded in the ticket's working folder stands in and the output says so.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appRoot, isNotionUrl, readAspira, readApp } from './aspira.js'
import { type Log } from './fs.js'
import { commandFor, nextStep } from './playbook.js'
import { isTicketRef } from './ticket-handle.js'
import { lookupTicket } from './ticket-lookup.js'

export { isTicketRef }

/** A ticket on the board. `type` and `folder` come from the resolve script when it prints them: undefined when it does not, '' for an empty Type. */
export type ResolvedTicket = { id: string; title: string; url: string; status: string; type?: string; folder?: string }

/** Where liveResolver writes its one warning line: process.stderr, or a capture in tests. */
export type Writer = { write: (chunk: string) => unknown }

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

/** The default resolver: lookupTicket, with the ticket or null. Each null writes exactly one line, `kit next: <why>`, to `writer`. */
export function liveResolver(board: string, ref: string, projectRoot: string, appDir: string, writer: Writer = process.stderr): ResolvedTicket | null {
  const result = lookupTicket(board, ref, projectRoot, appDir)
  if ('ticket' in result) return result.ticket
  writer.write(`kit next: ${result.detail}\n`)
  return null
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
  let local: ResolvedTicket | null = null
  if (ref !== undefined && ref !== '') {
    if (!isTicketRef(ref)) {
      log(`not a ticket: ${ref} (an ID such as NOM-4, or a Notion page URL)`)
      return 2
    }
    wanted = ref
    local = folders.find((entry) => entry.ticket.id.toLowerCase() === ref.toLowerCase() || (isNotionUrl(ref) && entry.ticket.url.replace(/-/g, '').endsWith(ref.replace(/-/g, '').replace(/^.*\//, '').replace(/\?.*$/, ''))))?.ticket ?? null
  } else if (folders.length === 1) {
    wanted = folders[0]!.ticket.id
    local = folders[0]!.ticket
  } else if (folders.length === 0) {
    log('no ticket given and no folder under .work/ holds a ticket.md; name the ticket: kit next <ID>')
    return 1
  } else {
    log(`no ticket given and ${folders.length} folders under .work/ hold a ticket.md: ${folders.map((entry) => entry.folder).join(', ')}; name the ticket`)
    return 1
  }
  const live = resolve(config.board, wanted, projectRoot, appRoot(projectRoot, app ?? readApp(projectRoot)))
  const ticket = live ?? local
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
  log(`next     ${row.step}`)
  log(`run      ${commandFor(row, ticket.id) ?? 'by hand, on the board'}`)
  log(`who      ${row.who}`)
  return 0
}
