import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { TicketArgumentError } from '@aspiralabs/agent-common/lib/ticket'
import { afterRun, beforeRun, verifyRun } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local build. The ticket comes first: the `board` stage (resolve, pull, claim) is
// printed before anything else, and the driver refuses, before any model stage, when ticket.md does
// not show the Status the implementor needs. Then the knowledge stage, the next stage's tasks (a
// prompt and an output file per task), or the finished run with the end-of-run board actions.
// --verify is the last step: ticket.md must show the Status the end stage expected. --finish exports
// what exists as incomplete. Every step names the agent package that ran (`agent`).
const usage = 'Usage: pnpm run implement:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <plan.review | plan.reviewed.md | spec.md>) [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--force-pull] [--verify] [--finish]'
const REFUSED = 3

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ticket: { type: 'string' },
      'no-ticket': { type: 'string' },
      guidelines: { type: 'string' },
      'max-parallel': { type: 'string' },
      serial: { type: 'boolean' },
      work: { type: 'string' },
      'force-pull': { type: 'boolean' },
      verify: { type: 'boolean' },
      finish: { type: 'boolean' },
    },
  })
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new Error(usage)
  const repo = values.repo
  const parallel = values['max-parallel']
  const agent = await agentVersion(new URL('..', import.meta.url))
  const context = { skill: 'implementor' as const, repo }
  const outputFor = (folder: string) => join(folder, 'plan.review')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    if (!verified.verified) process.exitCode = 1
  } else {
    const before = await beforeRun(context, { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'] })
    if (before.kind === 'stage') {
      console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    } else {
      const source = before.kind === 'none' ? before.path : before.input!
      const result = await runLocal({
        source,
        repo,
        ...(values.guidelines === undefined ? {} : { guidelines: values.guidelines }),
        ...(parallel === undefined ? {} : { maxParallel: Number(parallel) }),
        ...(values.work === undefined ? {} : { work: values.work }),
        serial: values.serial === true,
        finish: values.finish === true,
      })
      if (!result.pending && result.export !== null) await recordAgentVersion(result.export, agent)
      if (!result.pending && before.kind === 'ticket') {
        const exportDir = result.export ?? outputFor(before.folder)
        const board = await afterRun(context, before, { ok: result.status === 'complete', status: result.status, exportDir, verifyCommand: `implementor.sh local ${before.ticket.id} --verify` })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (!result.pending && result.export !== null) await writeBoardTrace(result.export, before.trace)
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }) }, null, 2))
      }
      if (!result.pending && result.status !== 'complete') process.exitCode = 1
    }
  }
} catch (error) {
  if (error instanceof FlowRefused || error instanceof TicketArgumentError) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'board', reason: error.message }, null, 2))
    console.error(`implementor local: refused: ${error.message}`)
    process.exitCode = REFUSED
  } else {
    console.error(`implementor local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
