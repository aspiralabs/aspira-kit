import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { exitCodeFor } from '@aspiralabs/agent-common/lib/run-status'
import { TicketArgumentError, type TicketRecord } from '@aspiralabs/agent-common/lib/ticket'
import { ticketBranch } from '@aspiralabs/agent-common/lib/ticket-branch'
import { afterRun, beforeRun, verifyRun } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, readTicketMd, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { exportDirOf, runLocal } from '../agent/lib/local.ts'

const exec = promisify(execFile)

// One step of a --local build. The ticket comes first: the `board` stage (resolve, pull, claim) is
// printed before anything else, and the driver refuses, before any model stage, when ticket.md does
// not show the Status the implementor needs. The board-stage gate also refuses, before the claim,
// when the checkout is not the ticket's own branch (GIT-001): building on the wrong branch is a
// mistake no amount of work afterward fixes. Then the knowledge stage, the next stage's tasks (a
// prompt and an output file per task), or the finished run with the end-of-run board actions.
// --verify is the last step: ticket.md must show the Status the end stage expected. --finish exports
// what exists as incomplete. Every step names the agent package that ran (`agent`).
const usage = 'Usage: pnpm run implement:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <plan.review | plan.reviewed.md | spec.md>) [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--force-pull] [--verify] [--finish]'
const REFUSED = 3

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', repo, ...args])).stdout.trim()
}

/** Refuses, before the claim (the Dev set and the start move), a checkout that is not the ticket's own branch: `git switch -c <branch>`, or `git switch <branch>` when it already exists (F22, F27). */
function beforeClaim(repo: string): (ticket: TicketRecord) => Promise<void> {
  return async (ticket) => {
    const current = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
    const wanted = ticketBranch(ticket.id, ticket.title, ticket.type)
    if (current === wanted) return
    const exists = await git(repo, 'rev-parse', '--verify', '--quiet', wanted).then(
      () => true,
      () => false,
    )
    const command = exists ? `git switch ${wanted}` : `git switch -c ${wanted}`
    throw new FlowRefused(`${repo} is on "${current}", not "${wanted}" (${ticket.id}'s branch, GIT-001). Run \`${command}\`, then run local again.`)
  }
}

/**
 * Step 8's push command, for a `--verify` report: always the branch a ready build recorded in
 * `implementation-local.json` (F21, F22), never one recomputed from the ticket's live title or
 * Type, which may have changed on the board since the build ran. Null when the build never
 * reached ready, or recorded no branch (an older export).
 */
async function step8For(outputFor: (folder: string) => string, folder: string): Promise<{ push: string; note?: string } | null> {
  const record = await readFile(join(outputFor(folder), 'trace/implementation-local.json'), 'utf8')
    .then((text) => JSON.parse(text) as { status?: unknown; branch?: unknown })
    .catch(() => null)
  if (record === null || record.status !== 'ready' || typeof record.branch !== 'string') return null
  const ticket = await readTicketMd(folder)
  if (ticket === null) return null
  const live = ticketBranch(ticket.id, ticket.title, ticket.type)
  const push = `git push -u origin ${record.branch}`
  if (live === record.branch) return { push }
  return { push, note: `the card's title or Type changed since the build: the branch stays ${record.branch}` }
}

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
  const context = { skill: 'implementor' as const, repo, beforeClaim: beforeClaim(repo) }
  const outputFor = (folder: string) => join(folder, 'plan.review')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket }, outputFor)
    const step8 = await step8For(outputFor, verified.folder)
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent, ...(step8 === null ? {} : { step8 }) }, null, 2))
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
      const exported = result.pending ? null : exportDirOf(result)
      if (exported !== null) await recordAgentVersion(exported, agent)
      if (!result.pending && before.kind === 'ticket') {
        const exportDir = exported ?? outputFor(before.folder)
        const board = await afterRun(context, before, { status: result.status, reasonCode: result.reasonCode ?? null, exportDir, verifyCommand: `implementor.sh local ${before.ticket.id} --verify` })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (exported !== null) await writeBoardTrace(exported, before.trace)
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }) }, null, 2))
      }
      if (!result.pending) process.exitCode = exitCodeFor(result.status)
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
