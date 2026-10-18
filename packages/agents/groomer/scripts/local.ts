import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { readGroomRecord } from '@aspiralabs/agent-common/lib/groom-record'
import { exitCodeFor } from '@aspiralabs/agent-common/lib/run-status'
import { afterRun, attachArg, beforeRun, handleRunError, KnowledgePrerequisiteError, sessionUsageStep, UsageError, verifyRun, type DriverTicketArgs } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused } from '@aspiralabs/agent-common/lib/ticket-flow'
import { KnowledgeRequired, knowledgeStage, runLocal } from '../agent/lib/local.ts'
import { groomPaths } from '../agent/lib/paths.ts'

// One step of a --local run. The ticket comes first: the `board` stage (resolve, pull, mark, claim)
// is printed before anything else, and the driver refuses, before any model stage, when ticket.md
// does not show a Feature card in Idea, Grooming or Shortlist. Then the guidelines, which the run
// fetches itself (blocked, exit 1, without a NOTION_TOKEN), then each round: `round` (the round task), `answers` (the chat round),
// `summary` on a confirm, and `board` (fetch the page, then the rendered page with the end-of-round
// board actions). `--verify` follows every board stage; the round state is kept until a confirmed
// or stopped round verifies, or `--verify --finish`. `--finish` alone exports the round as
// incomplete. Every step names the agent package that ran.
const usage = 'Usage: pnpm run groom:local --repo <absolute-repo> [--ticket ID | URL] [--guidelines FILE] [--force-pull] [--force-run] [--verify] [--finish] [--parent-run RUN:NONCE] [--attach JSON]'
const SKILL = 'groomer' as const

/** The session usage report of a --local round: <export>/trace/session-usage.json (KIT-19, F9). */
const sessionUsageFile = (exportDir: string) => join(exportDir, 'trace', 'session-usage.json')

const agent = await agentVersion(new URL('..', import.meta.url))
let context = { skill: SKILL, repo: '' }
let driverArgs: DriverTicketArgs = {}
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { repo: { type: 'string' }, ticket: { type: 'string' }, guidelines: { type: 'string' }, 'force-pull': { type: 'boolean' }, 'force-run': { type: 'boolean' }, verify: { type: 'boolean' }, finish: { type: 'boolean' }, 'take-recommended': { type: 'boolean' }, 'parent-run': { type: 'string' }, attach: { type: 'string' } },
  })
  if (values.repo === undefined || positionals.length > 0) throw new UsageError(usage)
  const repo = values.repo
  context = { skill: SKILL, repo }
  driverArgs = { positional: values.ticket, forcePull: values['force-pull'], forceRun: values['force-run'], parentRun: values['parent-run'] }
  const outputFor = (folder: string) => groomPaths(folder).output
  if (values.verify === true) {
    const finish = values.finish === true
    const verified = await verifyRun(context, { positional: values.ticket, finish, attach: attachArg(values.attach) }, outputFor)
    const record = verified.verified ? await readGroomRecord(verified.folder).catch(() => undefined) : undefined
    const runStatus = record?.status ?? verified.runStatus
    // The round state ends with the run: the driver removes .local/groomer/, this removes groom.local/.
    const ended = verified.verified && (finish || record?.status === 'ready' || (record?.status === 'needs-author' && record?.reasonCode === 'paused'))
    if (ended) await rm(groomPaths(verified.folder).work, { recursive: true, force: true })
    console.log(JSON.stringify({ pending: !ended, stage: 'board-verify', ...verified, runStatus, ...(record === undefined ? {} : { reasonCode: record.reasonCode, open: record.open }), ended, agent }, null, 2))
    process.exitCode = exitCodeFor(runStatus)
  } else {
    const before = await beforeRun(context, driverArgs)
    if (before.kind === 'stage') console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    else if (before.kind === 'none') throw new FlowRefused('the groomer writes to the card; it needs a Feature Board ticket')
    else {
      const step = await runLocal({ folder: before.folder, repoPath: repo, ...(values.guidelines === undefined ? {} : { guidelinesPath: values.guidelines }), finish: values.finish === true, takeRecommended: values['take-recommended'] === true })
      // No guidelines and no NOTION_TOKEN to fetch them with: the run ends blocked (exit 1, F52),
      // through the same handler every driver's errors go through, so the note says what to set.
      if (!step.pending && step.status === 'blocked') throw new KnowledgePrerequisiteError(step.reason)
      const ticket = `${before.ticket.id} ${before.ticket.title}`
      if (step.stage === 'board' && 'runStatus' in step && step.runStatus !== undefined) {
        const output = outputFor(before.folder)
        await recordAgentVersion(output, agent)
        const board = await afterRun(context, before, { status: step.runStatus, reasonCode: step.reasonCode ?? null, exportDir: output, verifyCommand: `groomer.sh local ${before.ticket.id} --verify`, round: step.round, sessionUsage: sessionUsageFile(output) })
        console.log(JSON.stringify({ ...step, agent, ...board }, null, 2))
      } else {
        const report = await sessionUsageStep(SKILL, before.folder, sessionUsageFile(outputFor(before.folder)))
        console.log(JSON.stringify({ ...step, agent, ticket, folder: before.folder, ...report }, null, 2))
      }
    }
  }
} catch (error) {
  if (error instanceof KnowledgeRequired) console.log(JSON.stringify({ ...knowledgeStage(error), agent }, null, 2))
  else {
    const result = await handleRunError(context, error, driverArgs)
    console.log(JSON.stringify({ pending: false, agent, ...result }, null, 2))
    console.error(`groomer local: ${result.status}: ${result.message ?? result.reason}`)
    process.exitCode = result.exitCode
  }
}
