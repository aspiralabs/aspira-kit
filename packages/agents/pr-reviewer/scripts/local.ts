import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { TicketArgumentError } from '@aspiralabs/agent-common/lib/ticket'
import { afterRun, beforeRun, verifyRun } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { KnowledgeRequired, runLocal } from '../agent/lib/local.ts'

// One step of a --local review. The ticket comes first: the `board` stage (resolve, pull) is printed
// before anything else, and the driver refuses, before any model stage, when ticket.md does not show
// In Review: Implementation with the PR set. Then the next stage's tasks (prompt and output file per
// task) or, once every stage is done, the exported review with the end-of-run board actions (the
// push of review.md as the PR Review page; the reviewer makes no move). --verify is the last step.
// --finish exports what exists as incomplete. Without the engineering guidelines folder it refuses
// (exit 3) and prints the pages to fetch. Every step names the agent package that ran (`agent`).
const usage = 'Usage: pnpm review:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <github-pr | absolute-repo-path>) [--branch B] [--base main] [--max-rounds N] [--output DIR] [--knowledge DIR] [--since DIR] [--max-cost USD] [--no-comment] [--force-pull] [--verify] [--finish]'
const REFUSED = 3

const agent = await agentVersion(new URL('..', import.meta.url))
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ticket: { type: 'string' },
      'no-ticket': { type: 'string' },
      branch: { type: 'string' },
      base: { type: 'string' },
      'max-rounds': { type: 'string' },
      output: { type: 'string' },
      knowledge: { type: 'string' },
      since: { type: 'string' },
      'max-cost': { type: 'string' },
      'no-comment': { type: 'boolean' },
      'force-pull': { type: 'boolean' },
      verify: { type: 'boolean' },
      finish: { type: 'boolean' },
    },
  })
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new Error(usage)
  const repo = values.repo
  const rounds = values['max-rounds']
  const context = { skill: 'pr-reviewer' as const, repo }
  const outputFor = (folder: string) => values.output ?? join(folder, 'pr-review')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    if (!verified.verified) process.exitCode = 1
  } else {
    const before = await beforeRun(context, { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'] })
    if (before.kind === 'stage') {
      console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    } else {
      // With a ticket the source is its PR property; the gate already refused when it was unset.
      const source = before.kind === 'none' ? before.path : before.ticket.pr
      if (source === undefined || source === '') throw new FlowRefused(`${before.kind === 'ticket' ? before.ticket.id : 'the ticket'} has no PR property set; the implementor sets it when it opens the PR`)
      const outputDir = before.kind === 'ticket' ? outputFor(before.folder) : values.output
      const result = await runLocal({
        source,
        ...(before.kind === 'none' && values.branch !== undefined ? { branch: values.branch } : {}),
        ...(before.kind === 'none' && values.base !== undefined ? { base: values.base } : {}),
        ...(rounds === undefined ? {} : { maxRounds: Number(rounds) }),
        ...(outputDir === undefined ? {} : { output: outputDir }),
        ...(values.knowledge === undefined ? {} : { knowledge: values.knowledge }),
        ...(values.since === undefined ? {} : { since: values.since }),
        ...(values['max-cost'] === undefined ? {} : { maxCost: Number(values['max-cost']) }),
        noComment: values['no-comment'] === true,
        finish: values.finish === true,
      })
      if (!result.pending) await recordAgentVersion(result.dir, agent)
      if (!result.pending && before.kind === 'ticket') {
        const board = await afterRun(context, before, { ok: result.status === 'complete', status: result.status, exportDir: result.dir, verifyCommand: `pr-reviewer.sh local ${before.ticket.id} --verify` })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (!result.pending) await writeBoardTrace(result.dir, before.trace)
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }) }, null, 2))
      }
      if (!result.pending && result.status !== 'complete') process.exitCode = 1
    }
  }
} catch (error) {
  if (error instanceof KnowledgeRequired) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'knowledge', reason: error.message, knowledge: error.plan, agent }, null, 2))
    console.error(`pr-reviewer local: ${error.message}`)
    process.exitCode = REFUSED
  } else if (error instanceof FlowRefused || error instanceof TicketArgumentError) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'board', reason: error.message, agent }, null, 2))
    console.error(`pr-reviewer local: refused: ${error.message}`)
    process.exitCode = REFUSED
  } else {
    console.error(`pr-reviewer local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
