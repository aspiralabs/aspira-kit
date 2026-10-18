import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { prStep, type PrStepResult } from '@aspiralabs/agent-common/lib/pr-step'
import { USAGE_EXIT, exitCodeFor } from '@aspiralabs/agent-common/lib/run-status'
import { type TicketRecord } from '@aspiralabs/agent-common/lib/ticket'
import { ticketBranch } from '@aspiralabs/agent-common/lib/ticket-branch'
import { afterRun, attachArg, beforeRun, handleRunError, sessionUsageStep, UsageError, verifyRun, type DriverContext, type DriverTicketArgs } from '@aspiralabs/agent-common/lib/ticket-driver'
import { FlowRefused, readTicketMd, writeBoardTrace } from '@aspiralabs/agent-common/lib/ticket-flow'
import { exportDirOf, runLocal } from '../agent/lib/local.ts'

const exec = promisify(execFile)

// One step of a --local build. The ticket comes first: the `board` stage (resolve, pull, claim) is
// printed before anything else, and the driver refuses, before any model stage, when ticket.md does
// not show the Status the implementor needs. The board-stage gate also refuses, before the claim,
// when the checkout is not the ticket's own branch (GIT-001): building on the wrong branch is a
// mistake no amount of work afterward fixes. Then the run loads the Notion rules itself
// (load-knowledge, once per run; blocked, exit 1, without a NOTION_TOKEN), then the next stage's
// tasks (a prompt and an output file per task), or the finished run with the end-of-run board actions.
// --verify is the last step: ticket.md must show the Status the end stage expected; --pr-url (only
// with --verify) runs the shared PR check and the set-then-move board step (F24-F26) for Step 8,
// printing the set or move action the session performs next; without it, Step 8 is reported still
// open. --finish exports what exists as incomplete. Every step names the agent package that ran (`agent`).
const usage =
  'Usage: pnpm run implement:local --repo <absolute-repo> (--ticket [ID | URL] | --no-ticket <plan.review | plan.reviewed.md | spec.md>) [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--force-pull] [--verify [--pr-url URL [--replace-pending]]] [--finish] [--parent-run RUN:NONCE] [--attach JSON]'
const SKILL = 'implementor' as const

/** The session usage report of a --local hand run: <export>/trace/session-usage.json (KIT-19, F9). */
const sessionUsageFile = (exportDir: string) => join(exportDir, 'trace', 'session-usage.json')

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
async function step8For(outputFor: (folder: string) => string, folder: string): Promise<{ push: string; branch: string; note?: string } | null> {
  const record = await readFile(join(outputFor(folder), 'trace/implementation-local.json'), 'utf8')
    .then((text) => JSON.parse(text) as { status?: unknown; branch?: unknown })
    .catch(() => null)
  if (record === null || record.status !== 'ready' || typeof record.branch !== 'string') return null
  const ticket = await readTicketMd(folder)
  if (ticket === null) return null
  const live = ticketBranch(ticket.id, ticket.title, ticket.type)
  const push = `git push -u origin ${record.branch}`
  if (live === record.branch) return { push, branch: record.branch }
  return { push, branch: record.branch, note: `the card's title or Type changed since the build: the branch stays ${record.branch}` }
}

/**
 * Step 8's PR action for a `--verify --pr-url` report (F24-F26): the shared PR check, then the
 * set-then-move board step, against the branch `step8For` recorded (never the ticket's live title
 * or Type). `open` is false only once the board already shows the move; a check or step problem
 * (a bad PR, gh missing, a conflicting pending URL) is reported, naming nothing as set or moved.
 */
async function step8PrAction(repo: string, branch: string, folder: string, url: string, replacePending: boolean): Promise<{ open: boolean; action?: 'set' | 'move'; url?: string; from?: string; to?: string; problem?: string }> {
  const ticket = await readTicketMd(folder)
  const decision: PrStepResult = await prStep({ url, repo, branch, folder, ticket: { id: ticket?.id ?? '', status: ticket?.status ?? '', pr: ticket?.pr ?? null }, env: process.env, replacePending })
  if (decision.kind === 'set') return { open: true, action: 'set', url: decision.url }
  if (decision.kind === 'move') return { open: true, action: 'move', from: decision.from, to: decision.to }
  if (decision.kind === 'ready') return { open: false }
  return { open: true, problem: decision.message }
}

/** parseArgs, with an unknown or malformed option reported as a usage error naming it, not a crash. */
function parseUsage<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${usage}`)
  }
}

let context: DriverContext = { skill: 'implementor', repo: '' }
let driverArgs: DriverTicketArgs = {}
try {
  const { values, positionals } = parseUsage(() => parseArgs({
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
      'pr-url': { type: 'string' },
      'replace-pending': { type: 'boolean' },
      'parent-run': { type: 'string' },
      attach: { type: 'string' },
    },
  }))
  if (values.repo === undefined || positionals.length > 0 || (values.ticket !== undefined && values['no-ticket'] !== undefined)) throw new UsageError(usage)
  if ((values['pr-url'] !== undefined || values['replace-pending'] === true) && values.verify !== true) throw new UsageError(usage)
  const repo = values.repo
  const parallel = values['max-parallel']
  const agent = await agentVersion(new URL('..', import.meta.url))
  context = { skill: SKILL, repo, beforeClaim: beforeClaim(repo) }
  driverArgs = { positional: values['no-ticket'] ?? values.ticket, noTicket: values['no-ticket'] !== undefined, forcePull: values['force-pull'], parentRun: values['parent-run'] }
  const outputFor = (folder: string) => join(folder, 'plan.review')
  if (values.verify === true) {
    const verified = await verifyRun(context, { positional: values.ticket, attach: attachArg(values.attach) }, outputFor)
    const record = await step8For(outputFor, verified.folder)
    const prUrl = values['pr-url']
    const step8 =
      record === null
        ? null
        : prUrl === undefined
          ? { ...record, open: true }
          : { ...record, ...(await step8PrAction(repo, record.branch, verified.folder, prUrl, values['replace-pending'] === true)) }
    console.log(JSON.stringify({ pending: false, stage: 'board-verify', ...verified, agent, ...(step8 === null ? {} : { step8 }) }, null, 2))
    if (!verified.verified || (step8 !== null && 'problem' in step8)) process.exitCode = 1
  } else {
    const before = await beforeRun(context, driverArgs)
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
        const board = await afterRun(context, before, { status: result.status, reasonCode: result.reasonCode ?? null, exportDir, verifyCommand: `implementor.sh local ${before.ticket.id} --verify`, sessionUsage: sessionUsageFile(exportDir) })
        console.log(JSON.stringify({ ...result, agent, ...board }, null, 2))
      } else {
        if (exported !== null) await writeBoardTrace(exported, before.trace)
        const report = before.kind === 'ticket' && result.pending ? await sessionUsageStep(SKILL, before.folder, sessionUsageFile(outputFor(before.folder))) : {}
        console.log(JSON.stringify({ ...result, agent, ticket: before.kind === 'none' ? 'none' : `${before.ticket.id} ${before.ticket.title}`, ...(before.kind === 'none' ? {} : { folder: before.folder }), ...report }, null, 2))
      }
      if (!result.pending) process.exitCode = exitCodeFor(result.status)
    }
  }
} catch (error) {
  if (error instanceof UsageError) {
    // A malformed invocation runs nothing and prints no board action: the usage on stderr, exit 2 (F5).
    console.error(`implementor local: ${error.message}`)
    process.exitCode = USAGE_EXIT
  } else {
    // A refusal (refused, exit 3), a missing prerequisite (blocked, exit 1) or a crash (incomplete,
    // exit 1, F9), with the progress note written or appended by the shared handler (F15).
    const result = await handleRunError(context, error, driverArgs)
    console.log(JSON.stringify({ pending: false, ...(error instanceof FlowRefused ? { stage: 'board' } : {}), ...result }, null, 2))
    console.error(`implementor local: ${result.status}: ${result.reason}`)
    process.exitCode = result.exitCode
  }
}
