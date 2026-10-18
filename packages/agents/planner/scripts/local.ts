import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { exitCodeFor, type RunStatus } from '@aspiralabs/agent-common/lib/run-status'
import { afterRun, attachArg, beforeRun, handleRunError, KnowledgePrerequisiteError, sessionUsageStep, UsageError, verifyRun, type DriverContext, type DriverTicketArgs } from '@aspiralabs/agent-common/lib/ticket-driver'
import { writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local plan. The ticket comes first: the `board` stage (resolve, pull, claim) is
// printed before anything else, and the driver refuses, before any model stage, when ticket.md does
// not show the Status the planner needs. Then the run loads the knowledge itself (load-knowledge,
// once per run; blocked, exit 1, without a NOTION_TOKEN), then the next phase's task (prompt and
// output file) or, once both phases are done, the exported plan with the end-of-run board actions.
// --verify is the last step: ticket.md must show the Status the end stage expected. --finish
// exports what exists as incomplete. Every step names the agent package that ran (`agent`).
const usage = 'Usage: pnpm run plan:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <absolute-spec>) [--output DIR] [--guidelines REQUIRED.md] [--force-pull] [--verify] [--finish] [--parent-run RUN:NONCE] [--attach JSON]'
const SKILL = 'planner' as const

/** The session usage report of a --local hand run: <export>/trace/session-usage.json (KIT-19, F9). */
const sessionUsageFile = (exportDir: string) => join(exportDir, 'trace', 'session-usage.json')

const agent = await agentVersion(new URL('..', import.meta.url))
let context: DriverContext = { skill: SKILL, repo: '' }
let driverArgs: DriverTicketArgs = {}
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { repo: { type: 'string' }, ticket: { type: 'string' }, 'no-ticket': { type: 'string' }, output: { type: 'string' }, guidelines: { type: 'string' }, 'force-pull': { type: 'boolean' }, verify: { type: 'boolean' }, finish: { type: 'boolean' }, 'take-recommended': { type: 'boolean' }, 'parent-run': { type: 'string' }, attach: { type: 'string' } },
  })
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new UsageError(usage)
  const repo = values.repo
  context = { skill: SKILL, repo }
  driverArgs = { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'], parentRun: values['parent-run'] }
  const outputFor = (folder: string) => values.output ?? join(folder, 'plan.review')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket, attach: attachArg(values.attach) }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    process.exitCode = verified.exitCode
  } else {
    const before = await beforeRun(context, driverArgs)
    if (before.kind === 'stage') {
      console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    } else {
      const specPath = before.kind === 'none' ? before.path : before.input!
      const outputDir = before.kind === 'ticket' ? outputFor(before.folder) : values.output
      const result = await runLocal({
        specPath,
        repoPath: repo,
        ...(outputDir === undefined ? {} : { outputDir }),
        ...(values.guidelines === undefined ? {} : { guidelinesPath: values.guidelines }),
        finish: values.finish === true, takeRecommended: values['take-recommended'] === true,
      })
      // The knowledge could not be loaded: blocked, reported and noted by handleRunError (F52).
      if (!result.pending && result.status === 'blocked') throw new KnowledgePrerequisiteError(result.reason)
      if (!result.pending) await recordAgentVersion(result.dir, agent)
      if (!result.pending && before.kind === 'ticket') {
        const status = result.status as RunStatus
        const board = await afterRun(context, before, { status, exportDir: result.dir, verifyCommand: `planner.sh local ${before.ticket.id} --verify`, sessionUsage: sessionUsageFile(result.dir) })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
        process.exitCode = board.exitCode
      } else {
        if (!result.pending) await writeBoardTrace(result.dir, before.trace)
        const report = before.kind === 'ticket' && result.pending ? await sessionUsageStep(SKILL, before.folder, sessionUsageFile(outputFor(before.folder))) : {}
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }), ...report }, null, 2))
        if (!result.pending) process.exitCode = exitCodeFor(result.status as RunStatus)
      }
    }
  }
} catch (error) {
  const result = await handleRunError(context, error, driverArgs)
  console.log(JSON.stringify({ pending: false, agent, ...result }, null, 2))
  console.error(`planner local: ${result.status}: ${result.message ?? result.reason}`)
  process.exitCode = result.exitCode
}
