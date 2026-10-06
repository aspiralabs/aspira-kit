// The launcher's board step around a separate-process run: `start` before the agent (resolve,
// gate, pull, claim) and `finish` after it (push, move). One shared command; this file names the skill.
import { ticketCli } from '@aspiralabs/agent-common/lib/ticket-cli'

process.exitCode = await ticketCli('spec-writer', process.argv.slice(2))
