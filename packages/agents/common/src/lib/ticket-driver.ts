// What every agent's --local driver (scripts/local.ts) does around its runLocal: resolve the ticket
// argument, run the board stage before knowledge, and at the end print the board actions for the
// session with the trace written into the export. One module, so the six drivers behave the same
// and are tested once. Nothing here touches an agent's own pipeline.

import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TICKET_FILE, WORK_DIR, ticketArgument, type BoardTrace, type Skill, type TicketArgument } from './ticket.ts'
import { FlowRefused, findWorkFolders, inputFileFor, localBoardEnd, localBoardStep, localBoardVerify, noTicketTrace, readAspira, readTicketMd, type BoardStage } from './ticket-flow.ts'
import { GATES } from './ticket.ts'

/** The ticket-related arguments every --local driver takes. */
export type DriverTicketArgs = { positional?: string; noTicket?: boolean; forcePull?: boolean; verify?: boolean }

export type DriverContext = { skill: Skill; repo: string; env?: Record<string, string | undefined>; dev?: string }

/** Where the driver keeps its board state between calls: inside the working folder, outside the run's own work dir. */
export const boardStateDir = (folder: string, skill: Skill) => join(folder, '.local', skill)

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
    throw new FlowRefused(`${context.repo} has no aspira.json, so it has no Feature Board. Run kit init --board <Feature Board URL> to add one, or pass --no-ticket with a file path.`)
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
  const step = await localBoardStep({ skill: context.skill, repo: context.repo, argument, board: config.board, stateDir, force: args.forcePull, dev: context.dev, env: context.env })
  if ('stage' in step) return { kind: 'stage', stage: step.stage }
  const input = GATES[context.skill].input === undefined ? null : inputFileFor(context.skill, step.ready.folder)
  const ticket = step.ready.ticket
  return { kind: 'ticket', argument: { ...argument, folder: step.ready.folder }, folder: step.ready.folder, input, statusBefore: step.ready.statusBefore, ticket: { id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, ...(ticket.pr === undefined ? {} : { pr: ticket.pr }) }, trace: step.ready.trace }
}

/** After the export: the pushes and the end move as actions for the session, and the trace in the export (F7, F8, F10). */
export async function afterRun(context: DriverContext, before: BeforeRun & { kind: 'ticket' }, run: { ok: boolean; status: string; exportDir: string; verifyCommand: string }) {
  const end = await localBoardEnd({ skill: context.skill, folder: before.folder, ok: run.ok, runStatus: run.status, exportDir: run.exportDir, stateDir: boardStateDir(before.folder, context.skill), verifyCommand: run.verifyCommand })
  return {
    ticket: `${before.ticket.id} ${before.ticket.title}`,
    folder: before.folder,
    board: { stage: end.stage, actions: end.actions, verify: end.verify, trace: end.traceFile, ...(end.remaining === null ? {} : { remaining: end.remaining }) },
  }
}

/** The verify step (`--verify`): ticket.md shows the Status the end stage expected; the report header comes back (F8, F10). */
export async function verifyRun(context: DriverContext, args: DriverTicketArgs, exportDirFor: (folder: string) => string) {
  const argument = await resolveArgument(context, args)
  if (argument.kind === 'path') throw new FlowRefused('--verify needs a ticket; a --no-ticket run has no board work to verify')
  const folder = argument.folder ?? null
  if (folder === null) throw new FlowRefused(`No working folder under ${WORK_DIR}/ holds a ${TICKET_FILE} for ${argument.ref}; nothing to verify`)
  const exportDir = exportDirFor(folder)
  const result = await localBoardVerify({ skill: context.skill, folder, exportDir })
  if (result.ok) await rm(boardStateDir(folder, context.skill), { recursive: true, force: true }).catch(() => undefined)
  const ticket = await readTicketMd(folder)
  return { verified: result.ok, ticket: ticket === null ? argument.ref : `${ticket.id} ${ticket.title}`, status: ticket?.status ?? null, report: result.header, pushed: result.trace.pushed, trace: result.traceFile, folder, ...(result.problem === null ? {} : { problem: result.problem }) }
}
