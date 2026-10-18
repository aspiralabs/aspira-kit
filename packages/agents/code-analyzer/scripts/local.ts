import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { exitCodeFor } from '@aspiralabs/agent-common/lib/run-status'
import { TicketArgumentError } from '@aspiralabs/agent-common/lib/ticket'
import { afterRun, attachArg, beforeRun, handleRunError, sessionUsageStep, verifyRun, UsageError, type DriverTicketArgs } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local run. The ticket comes first: the `board` stage (resolve, pull) is printed
// before anything else, and the driver refuses, before any model stage, when ticket.md does not show
// a Status the analyzer runs from. Then the knowledge stage until the guidelines are in place, each
// fix stage's tasks (prompt and output file per batch), then the exported run with the board trace.
// The analyzer makes no move and pushes nothing. Every step names the agent package that ran (`agent`).
const usage = 'Usage: pnpm run local --repo <absolute-repo> (--ticket [ID | URL] [<dir>] | --no-ticket <absolute-repo-path>) [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--force-pull] [--verify] [--finish] [--parent-run RUN:NONCE] [--attach JSON]'
const REFUSED = 3
const SKILL = 'code-analyzer' as const

/** The session usage report of a --local hand run: <export>/session-usage.json, beside board.json, so the export gets no trace/ folder (KIT-19, F9; decision D5). */
const sessionUsageFile = (exportDir: string) => join(exportDir, 'session-usage.json')

const agent = await agentVersion(new URL('..', import.meta.url))
let context = { skill: SKILL, repo: '' }
let ticketArgs: DriverTicketArgs = {}
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ticket: { type: 'string' },
      'no-ticket': { type: 'boolean' },
      knowledge: { type: 'string' },
      guidelines: { type: 'string' },
      output: { type: 'string' },
      'max-rounds': { type: 'string' },
      'fix-warnings': { type: 'boolean' },
      'no-fix': { type: 'boolean' },
      'force-pull': { type: 'boolean' },
      verify: { type: 'boolean' },
      finish: { type: 'boolean' },
      'parent-run': { type: 'string' },
      attach: { type: 'string' },
    },
  })
  const [positional, ...extra] = positionals
  if (values.repo === undefined || extra.length > 0 || (values['no-ticket'] === true && positional === undefined) || (values['no-ticket'] === true && values.ticket !== undefined)) throw new UsageError(usage)
  context = { skill: SKILL, repo: values.repo }
  const source = positional ?? values.repo
  const rounds = values['max-rounds']
  const progress = (message: string) => console.error(`${new Date().toISOString()} ${message}`)
  ticketArgs = { positional: values['no-ticket'] === true ? source : values.ticket, noTicket: values['no-ticket'] === true, forcePull: values['force-pull'], parentRun: values['parent-run'] }
  const outputFor = () => values.output ?? join(resolve(source), '.static-analysis')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket, attach: attachArg(values.attach) }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    if (!verified.verified) process.exitCode = 1
  } else {
    const before = await beforeRun(context, ticketArgs)
    if (before.kind === 'stage') {
      console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    } else {
      const result = await runLocal(
        {
          source,
          ticket: before.kind === 'ticket' ? before.ticket.id : null,
          ...(values.knowledge === undefined ? {} : { knowledge: values.knowledge }),
          ...(values.guidelines === undefined ? {} : { guidelines: values.guidelines }),
          ...(values.output === undefined ? {} : { output: values.output }),
          ...(rounds === undefined ? {} : { maxRounds: Number(rounds) }),
          ...(values['fix-warnings'] === true ? { fixWarnings: true } : {}),
          noFix: values['no-fix'] === true,
          finish: values.finish === true,
        },
        { progress },
      )
      if (!result.pending) await recordAgentVersion(result.dir, agent)
      if (!result.pending && before.kind === 'ticket') {
        const board = await afterRun(context, before, { status: result.status, reasonCode: result.reasonCode, exportDir: result.dir, verifyCommand: `code-analyzer.sh local ${before.ticket.id} ${source} --verify`, sessionUsage: sessionUsageFile(result.dir) })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (!result.pending) await writeBoardTrace(result.dir, before.trace)
        const report = before.kind === 'ticket' && result.pending ? await sessionUsageStep(SKILL, before.folder, sessionUsageFile(outputFor())) : {}
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }), ...report }, null, 2))
      }
      if (!result.pending) process.exitCode = exitCodeFor(result.status)
    }
  }
} catch (error) {
  if (error instanceof FlowRefused || error instanceof TicketArgumentError) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'board', reason: error.message }, null, 2))
    console.error(`code-analyzer local: refused: ${error.message}`)
    process.exitCode = REFUSED
  } else {
    const result = await handleRunError(context, error, ticketArgs)
    console.log(JSON.stringify({ pending: false, status: result.status, reason: result.reason, agent }, null, 2))
    console.error(`code-analyzer local: ${result.status}: ${result.reason}`)
    process.exitCode = result.exitCode
  }
}
