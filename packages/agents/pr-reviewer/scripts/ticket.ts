// The launcher's board step around a separate-process run: `start` before the agent (resolve,
// gate, pull) and `finish` after it (push the review). One shared command; this file names the skill.
import { ticketCli } from '@aspiralabs/agent-common/lib/ticket-cli'

process.exitCode = await ticketCli('pr-reviewer', process.argv.slice(2))
