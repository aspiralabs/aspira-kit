// What every agent's --local driver (scripts/local.ts) does around its runLocal: resolve the ticket
// argument, run the board stage before knowledge, and at the end print the board actions for the
// session with the trace written into the export. One module, so the six drivers behave the same
// and are tested once. Nothing here touches an agent's own pipeline.

import { constants, existsSync } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentVersion } from './agent-version.ts'
import { readGroomRecord } from './groom-record.ts'
import { checkParentRun, encodeTrace, parentRunSchema, releaseRunId, reserveRunId, telemetryDir, telemetryFile, writeTelemetry, type Gap, type SpanInput, type SpanUsage } from './telemetry.ts'
import { HAND_USAGE_SOURCE, readSessionUsage, readUsageSource, subagentSpans, type Interval } from './telemetry-sources.ts'
import { RUN_STATUSES, TICKET_FILE, WORK_DIR, ticketArgument, type BoardTrace, type RunStatus, type Skill, type TicketArgument } from './ticket.ts'
import {
  FlowRefused,
  findWorkFolders,
  inputFileFor,
  localBoardEnd,
  localBoardStep,
  localBoardVerify,
  localStateDir,
  noTicketTrace,
  readAspira,
  readLocalRun,
  readTicketMd,
  writeLocalRun,
  type BoardStage,
  type TelemetryAttachResult,
} from './ticket-flow.ts'
import { GATES } from './ticket.ts'

/**
 * The ticket-related arguments every --local driver takes. `forceRun` (the groomer) clears another
 * run's marker; `finish` (the groomer's `local --finish`) ends its round state on a passing verify
 * whatever the recorded status. `parentRun` is `--parent-run <run-id>:<nonce>`: the run is a step of
 * that build-feature run and writes no telemetry of its own. `attach` is the session's result of
 * the telemetry attach action, passed to the verify step.
 */
export type DriverTicketArgs = { positional?: string; noTicket?: boolean; forcePull?: boolean; forceRun?: boolean; verify?: boolean; finish?: boolean; parentRun?: string; attach?: TelemetryAttachResult }

export type DriverContext = { skill: Skill; repo: string; env?: Record<string, string | undefined>; dev?: string }

/** Where the driver keeps its board state between calls: inside the working folder, outside the run's own work dir. */
export const boardStateDir = (folder: string, skill: Skill) => localStateDir(folder, skill)

/** The refusal for a repository with no board. A row that refuses --no-ticket (the groomer) does not offer it. */
export const noBoardMessage = (repo: string, skill: Skill): string =>
  `${repo} has no aspira.json, so it has no Feature Board. Run kit init --board <Feature Board URL> to add one${GATES[skill].noTicket === false ? '.' : ', or pass --no-ticket with a file path.'}`

/** A run status word as the flow takes it; a word outside the list is a failure. */
export const runStatusOf = (word: string): RunStatus => RUN_STATUSES.find((status) => status === word) ?? 'incomplete'

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

/** The refusal for a `--parent-run` value that is not `<run-id>:<nonce>`. */
export const PARENT_RUN_FORMAT = '--parent-run must be <run-id>:<nonce>, the build-feature run id and the nonce of its pending step'

/** Refuse a `--parent-run` value that is malformed, or that does not name the pending step of the build-feature run in progress on the ticket (KIT-19, F6). Reads no board. */
export async function checkParentRunArgument(folder: string | null, value: string, when: 'start' | 'finish'): Promise<void> {
  if (!parentRunSchema.safeParse(value).success) throw new FlowRefused(PARENT_RUN_FORMAT)
  if (folder === null) throw new FlowRefused('--parent-run names a build-feature run, but the ticket has no working folder yet')
  await checkParentRun(folder, value, when)
}

/** Before the agent runs: the board stage, or the ticket with its input file (F5, F6, F8). */
export async function beforeRun(context: DriverContext, args: DriverTicketArgs): Promise<BeforeRun> {
  if (args.parentRun !== undefined && !parentRunSchema.safeParse(args.parentRun).success) throw new FlowRefused(PARENT_RUN_FORMAT)
  const argument = await resolveArgument(context, args)
  if (argument.kind === 'path') return { kind: 'none', path: argument.path, trace: noTicketTrace(context.skill) }
  if (args.parentRun !== undefined) await checkParentRunArgument(argument.folder ?? null, args.parentRun, 'start')
  const config = (await readAspira(context.repo))!
  const folder = argument.folder ?? null
  // Until the folder exists the state lives under .work/.local; once the resolve step created the folder it moves in.
  const shared = join(context.repo, WORK_DIR, '.local', context.skill)
  const stateDir = folder === null ? shared : boardStateDir(folder, context.skill)
  if (folder !== null && !existsSync(join(stateDir, 'board.json')) && existsSync(join(shared, 'board.json'))) {
    await mkdir(stateDir, { recursive: true })
    await rename(join(shared, 'board.json'), join(stateDir, 'board.json'))
  }
  const step = await localBoardStep({ skill: context.skill, repo: context.repo, argument, board: config.board, stateDir, force: args.forcePull, forceRun: args.forceRun, dev: context.dev, env: context.env })
  if ('stage' in step) return { kind: 'stage', stage: step.stage }
  await reserveLocalRun(stateDir, step.ready.folder, args.parentRun)
  const input = GATES[context.skill].input === undefined ? null : inputFileFor(context.skill, step.ready.folder)
  const ticket = step.ready.ticket
  return { kind: 'ticket', argument: { ...argument, folder: step.ready.folder }, folder: step.ready.folder, input, statusBefore: step.ready.statusBefore, ticket: { id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, ...(ticket.pr === undefined ? {} : { pr: ticket.pr }) }, trace: step.ready.trace }
}

/**
 * A hand run's run id and start time, reserved once when the board stage reaches the ticket and kept
 * in the skill's board.json, so a re-entry keeps them (KIT-19, F13). A run inside build-feature
 * (`--parent-run`) reserves none and records the value instead.
 */
async function reserveLocalRun(stateDir: string, folder: string, parentRun: string | undefined): Promise<void> {
  const run = await readLocalRun(stateDir)
  if (run === null) return
  if (parentRun !== undefined) {
    if (run.runId !== undefined) await releaseRunId(folder, run.runId)
    if (run.parentRun !== parentRun || run.runId !== undefined) await writeLocalRun(stateDir, { parentRun })
    return
  }
  if (run.runId !== undefined && run.runStartedAt !== undefined) return
  const startedAt = runStartTime()
  const runId = await reserveRunId(folder, startedAt)
  await writeLocalRun(stateDir, { runId, runStartedAt: startedAt })
}

/** A hand run's start time: now, to the second its run id names, so the id and the time agree. */
export const runStartTime = (): string => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()

/** The kit version the telemetry resource names: agent-common's own, the kit's packages being versioned in lockstep. */
async function kitVersion(): Promise<string> {
  const found = await agentVersion(new URL('../..', import.meta.url)).catch(() => null)
  return found?.version ?? '0.0.0'
}

/** Every usage value not measured: the self usage of a span whose own model calls no source reports. */
const NOT_MEASURED: SpanUsage = { model: null, inputTokens: null, outputTokens: null, totalTokens: null, cacheRead: null, cacheWrite: null, toolCalls: null, costUsd: null }

/** The spans beneath a hand run's root, or the gap that kept its source out. */
export type HandRunSpans = { children: SpanInput[]; gap?: Gap }

/** A default/cloud hand run's phase spans, from the skill's usage file under its export dir (F5, F12). The implementor records none: timing only. */
export async function cloudHandRunSpans(skill: Skill, exportDir: string | undefined, interval: Interval, models?: Readonly<Record<string, string>>): Promise<HandRunSpans> {
  const source = HAND_USAGE_SOURCE[skill]
  if (source === null) return { children: [] }
  if (exportDir === undefined) return { children: [], gap: 'missing' }
  const result = await readUsageSource(join(exportDir, source.file), { ...interval, kind: source.kind, skill, ...(models === undefined ? {} : { models }) })
  return 'gap' in result ? { children: [], gap: result.gap } : { children: result.groups }
}

/** A --local hand run's subagent spans, from the session usage report; a --local run reads no usage.json (F9, F12). */
async function localHandRunSpans(sessionUsage: string | undefined, runId: string, interval: Interval): Promise<HandRunSpans> {
  if (sessionUsage === undefined) return { children: [], gap: 'missing' }
  const report = await readSessionUsage(sessionUsage)
  if ('gap' in report) return { children: [], gap: report.gap }
  // A report naming another run is that run's, left in the export.
  if (report.usage.runId !== runId) return { children: [], gap: 'stale' }
  return { children: subagentSpans(report.usage, interval) }
}

/** Why the telemetry folder cannot be written, for the notice; empty when it can. */
async function writeCause(folder: string): Promise<string> {
  try {
    await access(telemetryDir(folder), constants.W_OK)
    return ''
  } catch (error) {
    return ` (${error instanceof Error ? error.message : String(error)})`
  }
}

/** The notice for a hand run that has no run id: its launcher predates run telemetry. */
export const NO_RUN_ID_NOTICE = 'Telemetry not written: no run id; run kit init'
/** The notice for a --local run whose driver passed no session usage report: the driver predates run telemetry. */
export const NO_SESSION_USAGE_NOTICE = 'Telemetry not written: the local driver passed no session usage report; run kit init'

/**
 * Write a hand run's telemetry file (KIT-19, F1, F5, F16): the root span is the skill run from its
 * start to now, with its status word; the children are its phases or subagents. Returns the file
 * to attach (also when an earlier end of the same run wrote it: it is never rewritten, F13) and the
 * notice when nothing could be written. Never throws for the write.
 */
export async function writeHandRunTelemetry(run: { skill: Skill; folder: string; ticketId: string; runId: string; startedAt: string; endedAt: string; status: string; mode: 'local' | 'cloud'; spans: HandRunSpans }): Promise<{ file: string | null; notice: string | null }> {
  const { spans } = run
  // The session's own tokens (--local), and a run whose source gave nothing, are not measured.
  const selfUnmeasured = run.mode === 'local' || spans.children.length === 0
  const root: SpanInput = {
    name: run.skill,
    kind: 'hand-run',
    start: run.startedAt,
    end: run.endedAt,
    status: run.status,
    ...(selfUnmeasured ? { usage: NOT_MEASURED } : {}),
    ...(spans.gap === undefined ? {} : { attributes: { 'aspira.gap': spans.gap } }),
    children: spans.children,
  }
  const document = encodeTrace(root, { kitVersion: await kitVersion(), ticketId: run.ticketId, runId: run.runId, mode: run.mode })
  const result = await writeTelemetry(run.folder, run.runId, document)
  const file = telemetryFile(run.folder, run.runId)
  if (result.ok || existsSync(file)) return { file, notice: null }
  return { file: null, notice: `Telemetry not written: ${result.reason}${await writeCause(run.folder)}` }
}

/**
 * After the export: the pushes and the end move as actions for the session, and the trace in the
 * export (F7, F8, F10). The groomer calls it once per round with `round`; `runStatus`, when given,
 * is the word the flow takes instead of `status`. A hand run also writes its telemetry file here,
 * its root ending now, with the subagents of the session usage report at `sessionUsage`, and the
 * session gets the actions to attach it; a run with `--parent-run`, or from a driver that passes no
 * `sessionUsage` (one older than run telemetry), writes and attaches nothing. The
 * groomer's round ends its run: the next round reserves a new run id.
 */
export async function afterRun(context: DriverContext, before: BeforeRun & { kind: 'ticket' }, run: { ok: boolean; status: string; exportDir: string; verifyCommand: string; round?: number; runStatus?: RunStatus; sessionUsage?: string }) {
  const board = GATES[context.skill].record === undefined ? undefined : (await readAspira(context.repo))?.board
  const stateDir = boardStateDir(before.folder, context.skill)
  const runStatus = run.runStatus ?? runStatusOf(run.status)
  const endedAt = new Date().toISOString()
  const local = await readLocalRun(stateDir)
  const notices: string[] = []
  let telemetry: { runId: string; file: string } | undefined
  if (local?.parentRun === undefined) {
    // A driver older than run telemetry passes no report path: like a launcher with no run id, it writes nothing.
    if (run.sessionUsage === undefined) notices.push(NO_SESSION_USAGE_NOTICE)
    else if (local?.runId === undefined || local.runStartedAt === undefined) notices.push(NO_RUN_ID_NOTICE)
    else {
      const interval = { start: local.runStartedAt, end: endedAt }
      const spans = await localHandRunSpans(run.sessionUsage, local.runId, interval)
      const written = await writeHandRunTelemetry({ skill: context.skill, folder: before.folder, ticketId: before.ticket.id, runId: local.runId, startedAt: local.runStartedAt, endedAt, status: runStatus, mode: 'local', spans })
      if (written.notice !== null) notices.push(written.notice)
      if (written.file !== null) telemetry = { runId: local.runId, file: written.file }
    }
  }
  const end = await localBoardEnd({
    skill: context.skill,
    folder: before.folder,
    ok: run.ok,
    runStatus,
    exportDir: run.exportDir,
    stateDir,
    verifyCommand: run.verifyCommand,
    ...(run.round === undefined ? {} : { round: run.round }),
    ...(board === undefined ? {} : { board }),
    ...(telemetry === undefined ? {} : { telemetry }),
  })
  if (GATES[context.skill].record !== undefined && local?.runId !== undefined) await writeLocalRun(stateDir, {})
  return {
    ticket: `${before.ticket.id} ${before.ticket.title}`,
    folder: before.folder,
    board: { stage: end.stage, actions: end.actions, verify: end.verify, trace: end.traceFile, ...(end.remaining === null ? {} : { remaining: end.remaining }) },
    ...(notices.length === 0 ? {} : { notices }),
  }
}

/** The verify step (`--verify`): ticket.md shows the Status the end stage expected; the report header comes back (F8, F10). */
export async function verifyRun(context: DriverContext, args: DriverTicketArgs, exportDirFor: (folder: string) => string) {
  const argument = await resolveArgument(context, args)
  if (argument.kind === 'path') throw new FlowRefused('--verify needs a ticket; a --no-ticket run has no board work to verify')
  const folder = argument.folder ?? null
  if (folder === null) throw new FlowRefused(`No working folder under ${WORK_DIR}/ holds a ${TICKET_FILE} for ${argument.ref}; nothing to verify`)
  const exportDir = exportDirFor(folder)
  const result = await localBoardVerify({ skill: context.skill, folder, exportDir, ...(args.attach === undefined ? {} : { attach: args.attach }) })
  if (result.ok && (await roundStateEnds(context.skill, folder, args.finish === true))) await rm(boardStateDir(folder, context.skill), { recursive: true, force: true }).catch(() => undefined)
  const ticket = await readTicketMd(folder)
  return { verified: result.ok, ticket: ticket === null ? argument.ref : `${ticket.id} ${ticket.title}`, status: ticket?.status ?? null, report: result.header, pushed: result.trace.pushed, trace: result.traceFile, folder, ...(result.problem === null ? {} : { problem: result.problem }), ...(result.notices.length === 0 ? {} : { notices: result.notices }) }
}

/** Whether a passing verify ends the --local state: always for a row without a record; for the groomer only once the run is confirmed or stopped, or on --finish. */
async function roundStateEnds(skill: Skill, folder: string, finish: boolean): Promise<boolean> {
  if (GATES[skill].record === undefined || finish) return true
  const record = await readGroomRecord(folder).catch(() => undefined)
  return record?.status === 'confirmed' || record?.status === 'stopped'
}
