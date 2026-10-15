// The launcher's board step around a separate-process run: `start` before the agent (resolve,
// gate, pull) and `finish` after it (push the review). One shared command; this file names the skill
// and passes the per-agent model map, so the run telemetry carries each reviewer's model (S3-5).
import { ticketCli } from '@aspiralabs/agent-common/lib/ticket-cli'
import { MODELS } from '../agent/lib/models.ts'

process.exitCode = await ticketCli('pr-reviewer', process.argv.slice(2), undefined, undefined, undefined, MODELS)
