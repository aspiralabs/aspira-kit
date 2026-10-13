// `kit next`, `kit cleanup` and `kit worktree` run this to read a ticket through the one board module, with
// NOTION_TOKEN from the project's .env.local. Prints key=value lines (id, title, url, status, pr, dev, type, folder).
// On failure it exits 1 with the reason on stderr and one stdout line: `error=unknown` when the board answered that
// it has no such ticket, `error=unreachable` for anything else (usage, token, network, Notion).
import { parseArgs } from 'node:util'
import { BoardError, NOT_FOUND, board } from '../src/lib/board.ts'
import { workFolderName } from '../src/lib/ticket.ts'

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { board: { type: 'string' } } })
  const [ref] = positionals
  if (ref === undefined || values.board === undefined) throw new Error('Usage: resolve-ticket.ts <ticket> --board <Feature Board URL>')
  const ticket = await board({ board: values.board }).resolveTicket(ref)
  const fields = { id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, pr: ticket.pr ?? '', dev: ticket.dev ?? '', type: ticket.type ?? '', folder: workFolderName(ticket) }
  for (const [key, value] of Object.entries(fields)) console.log(`${key}=${value.replaceAll('\n', ' ')}`)
} catch (error) {
  console.error(`resolve-ticket: ${error instanceof Error ? error.message : String(error)}`)
  console.log(`error=${error instanceof BoardError && error.code === NOT_FOUND ? 'unknown' : 'unreachable'}`)
  process.exitCode = 1
}
