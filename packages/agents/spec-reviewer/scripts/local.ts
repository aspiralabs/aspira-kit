import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { TicketArgumentError } from '@aspiralabs/agent-common/lib/ticket'
import { afterRun, beforeRun, verifyRun } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { KnowledgeRequired, knowledgeStage, runLocal } from '../agent/lib/local.ts'

// One step of a --local review. The ticket comes first: the `board` stage (resolve, pull) is printed
// before anything else, and the driver refuses, before any model stage, when ticket.md does not show
// the Status the reviewer needs. Then the knowledge stage (the Notion pages to fetch) until the
// guidelines are there, then the pending phases (prompt and output file per phase) or, once every
// phase output is present, the finished report with the end-of-run board actions. --verify is the
// last step: ticket.md must show what the end stage expected. --finish exports what exists as
// incomplete. Every step names the agent package that ran (`agent`), and an export records it in its trace.
const usage = 'Usage: pnpm run review:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <absolute-spec>) [--guidelines FILE] [--output DIR] [--force-pull] [--verify] [--finish]'
const REFUSED = 3

const agent = await agentVersion(new URL('..', import.meta.url))
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { repo: { type: 'string' }, ticket: { type: 'string' }, 'no-ticket': { type: 'string' }, guidelines: { type: 'string' }, output: { type: 'string' }, 'force-pull': { type: 'boolean' }, verify: { type: 'boolean' }, finish: { type: 'boolean' } },
  })
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new Error(usage)
  const repo = values.repo
  const context = { skill: 'spec-reviewer' as const, repo }
  const outputFor = (folder: string) => values.output ?? join(folder, 'spec.reviewed')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    if (!verified.verified) process.exitCode = 1
  } else {
    const before = await beforeRun(context, { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'] })
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
        finish: values.finish === true,
      })
      if (!result.pending) await recordAgentVersion(result.dir, agent)
      if (!result.pending && before.kind === 'ticket') {
        const board = await afterRun(context, before, { ok: result.status !== 'incomplete', status: result.status, exportDir: result.dir, verifyCommand: `spec-reviewer.sh local ${before.ticket.id} --verify` })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (!result.pending) await writeBoardTrace(result.dir, before.trace)
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }) }, null, 2))
      }
      if (!result.pending && result.status !== 'ready') process.exitCode = 1
    }
  }
} catch (error) {
  if (error instanceof KnowledgeRequired) console.log(JSON.stringify({ ...knowledgeStage(error), agent }, null, 2))
  else if (error instanceof FlowRefused || error instanceof TicketArgumentError) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'board', reason: error.message }, null, 2))
    console.error(`spec-reviewer local: refused: ${error.message}`)
    process.exitCode = REFUSED
  } else {
    console.error(`spec-reviewer local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
