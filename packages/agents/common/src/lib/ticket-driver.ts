// What every agent's --local driver (scripts/local.ts) does around its runLocal: resolve the ticket
// argument, run the board stage before knowledge, and at the end print the board actions for the
// session with the trace written into the export. One module, so the six drivers behave the same
// and are tested once. Nothing here touches an agent's own pipeline.

import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readGroomRecord } from './groom-record.ts'
import { REFUSED_EXIT, USAGE_EXIT, exitCodeFor, readRunStatus, type ReasonCode, type RunStatus } from './run-status.ts'
import { TICKET_FILE, TicketArgumentError, WORK_DIR, ticketArgument, type BoardTrace, type Skill, type TicketArgument, type TicketRecord } from './ticket.ts'
import { FlowRefused, findWorkFolders, inputFileFor, localBoardEnd, localBoardStep, localBoardVerify, localStateDir, noTicketTrace, readAspira, readTicketMd, type BoardStage } from './ticket-flow.ts'
import { GATES } from './ticket.ts'

/**
 * The ticket-related arguments every --local driver takes. `forceRun` (the groomer) clears another
 * run's marker; `finish` (the groomer's `local --finish`) ends its round state on a passing verify
 * whatever the recorded status.
 */
export type DriverTicketArgs = { positional?: string; noTicket?: boolean; forcePull?: boolean; forceRun?: boolean; verify?: boolean; finish?: boolean }

export type DriverContext = {
  skill: Skill
  repo: string
  env?: Record<string, string | undefined>
  dev?: string
  /** Runs after the resolve and before the claim is printed; a check that refuses throws FlowRefused with its Next action (the implementor's branch gate, F22). */
  beforeClaim?: (ticket: TicketRecord) => void | Promise<void>
}

/** Where the driver keeps its board state between calls: inside the working folder, outside the run's own work dir. */
export const boardStateDir = (folder: string, skill: Skill) => localStateDir(folder, skill)

/** The refusal for a repository with no board. A row that refuses --no-ticket (the groomer) does not offer it. */
export const noBoardMessage = (repo: string, skill: Skill): string =>
  `${repo} has no aspira.json, so it has no Feature Board. Run kit init --board <Feature Board URL> to add one${GATES[skill].noTicket === false ? '.' : ', or pass --no-ticket with a file path.'}`

/** A run status word as the flow takes it (old or new, F7); a word outside both reads as incomplete. */
export const runStatusOf = (word: string): RunStatus => readRunStatus(word)?.status ?? 'incomplete'

export type BeforeRun =
  /** The board stage to print; the session performs its actions and calls the driver again. */
  | { kind: 'stage'; stage: BoardStage }
  /** The ticket is claimed and pulled: run the agent on `input` (the ticket's file for this skill). */
  | { kind: 'ticket'; argument: TicketArgument & { kind: 'ticket' | 'folder' }; folder: string; input: string | null; statusBefore: string; ticket: { id: string; title: string; url: string; status: string; pr?: string }; trace: BoardTrace }
  /** --no-ticket: a path, no board. */
  | { kind: 'none'; path: string; trace: BoardTrace }

/** The ticket argument of a run, resolved against aspira.json and the working folders (F1, F2). */
export async function resolveArgument(context: DriverContext, args: DriverTicketArgs): Promise<TicketArgument> {
  const folders = await findWorkFolders(context.repo)
  const argument = ticketArgument({ positional: args.positional, noTicket: args.noTicket, workFolders: folders, skill: context.skill })
  if (argument.kind !== 'path' && (await readAspira(context.repo)) === null) {
    throw new FlowRefused(noBoardMessage(context.repo, context.skill))
  }
  return argument
}

/** Before the agent runs: the board stage, or the ticket with its input file (F5, F6, F8). */
export async function beforeRun(context: DriverContext, args: DriverTicketArgs): Promise<BeforeRun> {
  const argument = await resolveArgument(context, args)
  if (argument.kind === 'path') return { kind: 'none', path: argument.path, trace: noTicketTrace(context.skill) }
  const config = (await readAspira(context.repo))!
  const folder = argument.folder ?? null
  // Until the folder exists the state lives under .work/.local; once the resolve step created the folder it moves in.
  const shared = join(context.repo, WORK_DIR, '.local', context.skill)
  const stateDir = folder === null ? shared : boardStateDir(folder, context.skill)
  if (folder !== null && !existsSync(join(stateDir, 'board.json')) && existsSync(join(shared, 'board.json'))) {
    await mkdir(stateDir, { recursive: true })
    await rename(join(shared, 'board.json'), join(stateDir, 'board.json'))
  }
  const step = await localBoardStep({ skill: context.skill, repo: context.repo, argument, board: config.board, stateDir, force: args.forcePull, forceRun: args.forceRun, dev: context.dev, env: context.env, ...(context.beforeClaim === undefined ? {} : { beforeClaim: context.beforeClaim }) })
  if ('stage' in step) return { kind: 'stage', stage: step.stage }
  const input = GATES[context.skill].input === undefined ? null : inputFileFor(context.skill, step.ready.folder)
  const ticket = step.ready.ticket
  return { kind: 'ticket', argument: { ...argument, folder: step.ready.folder }, folder: step.ready.folder, input, statusBefore: step.ready.statusBefore, ticket: { id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, ...(ticket.pr === undefined ? {} : { pr: ticket.pr }) }, trace: step.ready.trace }
}

/**
 * After the export: the pushes and the end move as actions for the session, the trace in the
 * export, and the run status and exit code next to them (F7, F8, F10, F53). The result depends
 * only on `run.status`: there is no separate `ok` to agree or disagree with it. The groomer calls
 * it once per round with `round`.
 */
export async function afterRun(context: DriverContext, before: BeforeRun & { kind: 'ticket' }, run: { status: RunStatus; reasonCode?: ReasonCode | null; exportDir: string; verifyCommand: string; round?: number }) {
  const board = GATES[context.skill].record === undefined ? undefined : (await readAspira(context.repo))?.board
  const end = await localBoardEnd({
    skill: context.skill,
    folder: before.folder,
    runStatus: run.status,
    reasonCode: run.reasonCode ?? null,
    exportDir: run.exportDir,
    stateDir: boardStateDir(before.folder, context.skill),
    verifyCommand: run.verifyCommand,
    ...(run.round === undefined ? {} : { round: run.round }),
    ...(board === undefined ? {} : { board }),
  })
  return {
    ticket: `${before.ticket.id} ${before.ticket.title}`,
    folder: before.folder,
    runStatus: run.status,
    exitCode: exitCodeFor(run.status),
    board: { stage: end.stage, actions: end.actions, verify: end.verify, trace: end.traceFile, ...(end.remaining === null ? {} : { remaining: end.remaining }) },
  }
}

/** The verify step (`--verify`): ticket.md shows the Status the end stage expected; the report header comes back, with the run status and exit code (0 only when the board check passed and the status is ready) (F8, F10). */
export async function verifyRun(context: DriverContext, args: DriverTicketArgs, exportDirFor: (folder: string) => string) {
  const argument = await resolveArgument(context, args)
  if (argument.kind === 'path') throw new FlowRefused('--verify needs a ticket; a --no-ticket run has no board work to verify')
  const folder = argument.folder ?? null
  if (folder === null) throw new FlowRefused(`No working folder under ${WORK_DIR}/ holds a ${TICKET_FILE} for ${argument.ref}; nothing to verify`)
  const exportDir = exportDirFor(folder)
  const result = await localBoardVerify({ skill: context.skill, folder, exportDir })
  if (result.ok && (await roundStateEnds(context.skill, folder, args.finish === true))) await rm(boardStateDir(folder, context.skill), { recursive: true, force: true }).catch(() => undefined)
  const ticket = await readTicketMd(folder)
  const runStatus: RunStatus = result.ok ? 'ready' : 'incomplete'
  return {
    verified: result.ok,
    ticket: ticket === null ? argument.ref : `${ticket.id} ${ticket.title}`,
    status: ticket?.status ?? null,
    report: result.header,
    pushed: result.trace.pushed,
    trace: result.traceFile,
    folder,
    runStatus,
    exitCode: exitCodeFor(runStatus),
    ...(result.problem === null ? {} : { problem: result.problem }),
  }
}

/** Whether a passing verify ends the --local state: always for a row without a record; for the groomer only once the run is ready or needs-author/paused, or on --finish. */
async function roundStateEnds(skill: Skill, folder: string, finish: boolean): Promise<boolean> {
  if (GATES[skill].record === undefined || finish) return true
  const record = await readGroomRecord(folder).catch(() => undefined)
  return record?.status === 'ready' || (record?.status === 'needs-author' && record?.reasonCode === 'paused')
}

/** Thrown for a malformed CLI invocation (args that do not parse); handleRunError reports it as incomplete with USAGE_EXIT, matching a script's own usage error today. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Thrown when a run cannot go on for a missing prerequisite in the loaded knowledge (a required page the fetch could not read); handleRunError reports it as blocked. */
export class KnowledgePrerequisiteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgePrerequisiteError'
  }
}

/** What handleRunError reports: the status and exit code a driver's caller prints, and the one reason sentence (F9). */
export type RunErrorResult = { status: 'refused' | 'blocked' | 'incomplete'; reason: string; exitCode: number }

/**
 * Turns an error thrown by beforeRun/afterRun/verifyRun (or the agent's own pipeline) into the
 * run's final status and exit code (F9): FlowRefused and TicketArgumentError are refused (a board
 * gate or argument problem, REFUSED_EXIT); a KnowledgePrerequisiteError is blocked; a UsageError is
 * incomplete at USAGE_EXIT; anything else is incomplete with the error's own message as the reason.
 * Updating progress.md for this is the caller's job (ticket-cli.ts's `note`/`finish` commands and
 * each agent's scripts/local.ts), once progress-note.ts exists to write it.
 */
export async function handleRunError(_context: DriverContext, error: unknown, _args: DriverTicketArgs): Promise<RunErrorResult> {
  if (error instanceof FlowRefused || error instanceof TicketArgumentError) return { status: 'refused', reason: error.message, exitCode: REFUSED_EXIT }
  if (error instanceof KnowledgePrerequisiteError) return { status: 'blocked', reason: error.message, exitCode: 1 }
  if (error instanceof UsageError) return { status: 'incomplete', reason: error.message, exitCode: USAGE_EXIT }
  return { status: 'incomplete', reason: error instanceof Error ? error.message : String(error), exitCode: 1 }
}
