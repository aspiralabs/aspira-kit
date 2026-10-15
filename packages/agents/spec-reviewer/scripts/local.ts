import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { exitCodeFor, type RunStatus } from '@aspiralabs/agent-common/lib/run-status'
import { afterRun, beforeRun, handleRunError, UsageError, verifyRun, type DriverContext, type DriverTicketArgs } from '@aspiralabs/agent-common/lib/ticket-driver'
import { readTicketMd, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { KnowledgeRequired, knowledgeStage, runLocal } from '../agent/lib/local.ts'

// At a passing --verify, the Spec Reviewed page's last-edited time (as ticket.md's Pages table
// shows it) is folded into the export's own trace/review.json, so the planner can tell a pulled
// spec whose bytes changed in the Notion round-trip from one whose content actually changed (F33).
async function recordSpecReviewedEditedAt(folder: string, exportDir: string): Promise<void> {
  const ticket = await readTicketMd(folder)
  const editedAt = ticket?.pages['Spec Reviewed']?.lastEditedAt
  if (editedAt === undefined) return
  const reviewFile = join(exportDir, 'trace', 'review.json')
  const raw = await readFile(reviewFile, 'utf8').catch(() => null)
  if (raw === null) return
  const report = JSON.parse(raw) as Record<string, unknown>
  await writeFile(reviewFile, JSON.stringify({ ...report, specReviewedEditedAt: editedAt }, null, 2))
}

// One step of a --local review. The ticket comes first: the `board` stage (resolve, pull) is printed
// before anything else, and the driver refuses, before any model stage, when ticket.md does not show
// the Status the reviewer needs. Then the knowledge stage (the Notion pages to fetch) until the
// guidelines are there, then the pending phases (prompt and output file per phase) or, once every
// phase output is present, the finished report with the end-of-run board actions. --verify is the
// last step: ticket.md must show what the end stage expected. --finish exports what exists as
// incomplete. Every step names the agent package that ran (`agent`), and an export records it in its trace.
const usage = 'Usage: pnpm run review:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <absolute-spec>) [--guidelines FILE] [--output DIR] [--force-pull] [--verify] [--finish]'

const agent = await agentVersion(new URL('..', import.meta.url))
let context: DriverContext = { skill: 'spec-reviewer', repo: '' }
let driverArgs: DriverTicketArgs = {}
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { repo: { type: 'string' }, ticket: { type: 'string' }, 'no-ticket': { type: 'string' }, guidelines: { type: 'string' }, output: { type: 'string' }, 'force-pull': { type: 'boolean' }, verify: { type: 'boolean' }, finish: { type: 'boolean' }, 'take-recommended': { type: 'boolean' } },
  })
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new UsageError(usage)
  const repo = values.repo
  context = { skill: 'spec-reviewer', repo }
  driverArgs = { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'] }
  const outputFor = (folder: string) => values.output ?? join(folder, 'spec.reviewed')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket }, outputFor)
    if (verified.verified) await recordSpecReviewedEditedAt(verified.folder, outputFor(verified.folder))
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
        ...(values.guidelines === undefined ? {} : { guidelinesPath: values.guidelines }),
        ...(outputDir === undefined ? {} : { outputDir }),
        finish: values.finish === true, takeRecommended: values['take-recommended'] === true,
      })
      if (!result.pending) await recordAgentVersion(result.dir, agent)
      if (!result.pending && before.kind === 'ticket') {
        const status = result.status as RunStatus
        const board = await afterRun(context, before, { status, exportDir: result.dir, verifyCommand: `spec-reviewer.sh local ${before.ticket.id} --verify` })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
        process.exitCode = board.exitCode
      } else {
        if (!result.pending) await writeBoardTrace(result.dir, before.trace)
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }) }, null, 2))
        if (!result.pending) process.exitCode = exitCodeFor(result.status as RunStatus)
      }
    }
  }
} catch (error) {
  if (error instanceof KnowledgeRequired) console.log(JSON.stringify({ ...knowledgeStage(error), agent }, null, 2))
  else {
    const result = await handleRunError(context, error, driverArgs)
    console.log(JSON.stringify({ pending: false, agent, ...result }, null, 2))
    console.error(`spec-reviewer local: ${result.status}: ${result.message ?? result.reason}`)
    process.exitCode = result.exitCode
  }
}
