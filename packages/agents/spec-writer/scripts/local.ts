import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { USAGE_EXIT, exitCodeFor, reportHead, type RunStatus } from '@aspiralabs/agent-common/lib/run-status'
import { afterRun, attachArg, beforeRun, handleRunError, sessionUsageStep, UsageError, verifyRun, type DriverContext, type DriverTicketArgs } from '@aspiralabs/agent-common/lib/ticket-driver'
import { writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local run. The ticket comes first: the `board` stage (resolve, pull, claim) is
// printed before anything else, and the driver refuses, before any model stage, when ticket.md does
// not show the Status the writer needs. Then the run loads the guidelines itself (load-knowledge,
// once per run; blocked, exit 1, without a NOTION_TOKEN), then the pending phases (prompt and output file per phase) or, once
// every phase output is present, the finished report with the end-of-run board actions: the written
// spec is copied to the working folder's spec.md, the file pushed to the ticket as Spec. --verify is
// the last step: ticket.md must show what the end stage expected. --finish exports what exists as
// incomplete. Every step names the agent package that ran (`agent`), and an export records it in its trace.
const usage = 'Usage: pnpm run write:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <absolute-idea>) [--guidelines FILE] [--output DIR] [--force-pull] [--verify] [--finish] [--parent-run RUN:NONCE] [--attach JSON]'
const SKILL = 'spec-writer' as const

/** The session usage report of a --local hand run: <export>/trace/session-usage.json (KIT-19, F9). */
const sessionUsageFile = (exportDir: string) => join(exportDir, 'trace', 'session-usage.json')

/** parseArgs, with an unknown or malformed option reported as a usage error naming it, not a crash. */
function parseUsage<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${usage}`)
  }
}

const agent = await agentVersion(new URL('..', import.meta.url))
let context: DriverContext = { skill: SKILL, repo: '' }
let driverArgs: DriverTicketArgs = {}
try {
  const { values, positionals } = parseUsage(() => parseArgs({
    allowPositionals: true,
    options: { repo: { type: 'string' }, ticket: { type: 'string' }, 'no-ticket': { type: 'string' }, guidelines: { type: 'string' }, output: { type: 'string' }, 'force-pull': { type: 'boolean' }, verify: { type: 'boolean' }, finish: { type: 'boolean' }, 'take-recommended': { type: 'boolean' }, 'parent-run': { type: 'string' }, attach: { type: 'string' } },
  }))
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new UsageError(usage)
  const repo = values.repo
  context = { skill: SKILL, repo }
  driverArgs = { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'], parentRun: values['parent-run'] }
  const outputFor = (folder: string) => values.output ?? join(folder, 'spec.written')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket, attach: attachArg(values.attach) }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    process.exitCode = verified.exitCode
  } else {
    const before = await beforeRun(context, driverArgs)
    if (before.kind === 'stage') {
      console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    } else {
      const ideaPath = before.kind === 'none' ? before.path : before.input!
      const outputDir = before.kind === 'ticket' ? outputFor(before.folder) : values.output
      const result = await runLocal({
        ideaPath,
        repoPath: repo,
        ...(values.guidelines === undefined ? {} : { guidelinesPath: values.guidelines }),
        ...(outputDir === undefined ? {} : { outputDir }),
        finish: values.finish === true, takeRecommended: values['take-recommended'] === true,
      })
      if (!result.pending) await recordAgentVersion(result.dir, agent)
      if (!result.pending) {
        const status = result.status as RunStatus
        const head = await reportHead({ status, reason: result.reason }, repo)
        if (before.kind === 'ticket') {
          // The written spec becomes the working folder's spec.md: the file the ticket's Spec page is pushed from.
          // A missing spec.md is caught generically: a planned push whose file never materialized
          // downgrades the run to incomplete inside afterRun/localBoardEnd (finishFlow's missing-push
          // rule, F53), so this script no longer gates the push on result.spec itself.
          const spec = result.spec === null ? null : join(before.folder, 'spec.md')
          if (result.spec !== null && spec !== null) await copyFile(result.spec, spec)
          const board = await afterRun(context, before, { status, exportDir: result.dir, verifyCommand: `spec-writer.sh local ${before.ticket.id} --verify`, sessionUsage: sessionUsageFile(result.dir) })
          console.log(JSON.stringify({ report: head, ...result, agent, ...board, ...(spec === null ? {} : { ticketSpec: spec }) }, null, 2))
          process.exitCode = board.exitCode
        } else {
          await writeBoardTrace(result.dir, before.trace)
          console.log(JSON.stringify({ report: head, ...result, agent, ticket: 'none' }, null, 2))
          process.exitCode = exitCodeFor(status)
        }
      } else {
        const report = before.kind === 'ticket' ? await sessionUsageStep(SKILL, before.folder, sessionUsageFile(outputFor(before.folder))) : {}
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }), ...report }, null, 2))
      }
    }
  }
} catch (error) {
  if (error instanceof UsageError) {
    // A malformed invocation runs nothing and prints no board action: the usage on stderr, exit 2 (F5, F24).
    console.error(`spec-writer local: ${error.message}`)
    process.exitCode = USAGE_EXIT
  } else {
    const result = await handleRunError(context, error, driverArgs)
    console.log(JSON.stringify({ pending: false, agent, ...result }, null, 2))
    console.error(`spec-writer local: ${result.status}: ${result.message ?? result.reason}`)
    process.exitCode = result.exitCode
  }
}
