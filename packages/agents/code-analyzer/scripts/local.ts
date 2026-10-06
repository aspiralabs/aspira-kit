import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { TicketArgumentError } from '@aspiralabs/agent-common/lib/ticket'
import { afterRun, beforeRun, verifyRun } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { KnowledgeRequired, runLocal } from '../agent/lib/local.ts'

// One step of a --local run. The ticket comes first: the `board` stage (resolve, pull) is printed
// before anything else, and the driver refuses, before any model stage, when ticket.md does not show
// a Status the analyzer runs from. Then the knowledge stage until the guidelines are in place, each
// fix stage's tasks (prompt and output file per batch), then the exported run with the board trace.
// The analyzer makes no move and pushes nothing. Every step names the agent package that ran (`agent`).
const usage = 'Usage: pnpm run local --repo <absolute-repo> (--ticket [ID | URL] [<dir>] | --no-ticket <absolute-repo-path>) [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--force-pull] [--verify] [--finish]'
const REFUSED = 3

const agent = await agentVersion(new URL('..', import.meta.url))
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
    },
  })
  const [positional, ...extra] = positionals
  if (values.repo === undefined || extra.length > 0 || (values['no-ticket'] === true && positional === undefined) || (values['no-ticket'] === true && values.ticket !== undefined)) throw new Error(usage)
  const repo = values.repo
  const source = positional ?? repo
  const rounds = values['max-rounds']
  const progress = (message: string) => console.error(`${new Date().toISOString()} ${message}`)
  const context = { skill: 'code-analyzer' as const, repo }
  const outputFor = () => values.output ?? join(resolve(source), '.static-analysis')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket }, outputFor)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent }, null, 2))
    if (!verified.verified) process.exitCode = 1
  } else {
    const before = await beforeRun(context, { positional: values['no-ticket'] === true ? source : values.ticket, noTicket: values['no-ticket'] === true, forcePull: values['force-pull'] })
    if (before.kind === 'stage') {
      console.log(JSON.stringify({ ...before.stage, agent }, null, 2))
    } else {
      const result = await runLocal(
        {
          source,
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
        const board = await afterRun(context, before, { ok: result.status === 'clean' || result.status === 'partial', status: result.status, exportDir: result.dir, verifyCommand: `code-analyzer.sh local ${before.ticket.id} ${source} --verify` })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (!result.pending) await writeBoardTrace(result.dir, before.trace)
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }) }, null, 2))
      }
      if (!result.pending && result.status !== 'clean') process.exitCode = 1
    }
  }
} catch (error) {
  if (error instanceof KnowledgeRequired) {
    // Not a failure: the stage the session runs before the first step.
    console.log(JSON.stringify({ pending: true, refused: error.message, ...error.plan, agent }, null, 2))
  } else if (error instanceof FlowRefused || error instanceof TicketArgumentError) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'board', reason: error.message }, null, 2))
    console.error(`code-analyzer local: refused: ${error.message}`)
    process.exitCode = REFUSED
  } else {
    console.error(`code-analyzer local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
