// The launcher's board step around a separate-process run: `start` before the agent (resolve, gate,
// pull, mark, claim) and `finish` after it (ticks, page replace, Idea summary, move). One shared
// command; this file names the skill.
import { ticketCli } from '@aspiralabs/agent-common/lib/ticket-cli'

process.exitCode = await ticketCli('groomer', process.argv.slice(2))
