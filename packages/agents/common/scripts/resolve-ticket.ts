// `kit next` runs this to read a ticket's Status through the one board module, with NOTION_TOKEN
// from the project's .env.local. Prints key=value lines; exits 1 when the board cannot answer.
import { parseArgs } from 'node:util'
import { board } from '../src/lib/board.ts'

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { board: { type: 'string' } } })
  const [ref] = positionals
  if (ref === undefined || values.board === undefined) throw new Error('Usage: resolve-ticket.ts <ticket> --board <Feature Board URL>')
  const ticket = await board({ board: values.board }).resolveTicket(ref)
  for (const [key, value] of Object.entries({ id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, pr: ticket.pr ?? '', dev: ticket.dev ?? '' })) console.log(`${key}=${value.replaceAll('\n', ' ')}`)
} catch (error) {
  console.error(`resolve-ticket: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
