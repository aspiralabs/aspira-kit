// What every agent's --local driver (scripts/local.ts) does around its runLocal: resolve the ticket
// argument, run the board stage before knowledge, and at the end print the board actions for the
// session with the trace written into the export. One module, so the six drivers behave the same
// and are tested once. Nothing here touches an agent's own pipeline. It also writes
// `.work/<id>-<slug>/progress.md` at every return to the session, so a crashed or resumed run
// always has a Next action to read (F14-F21).

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { agentVersion } from './agent-version.ts'
import { BOARD_ENV, board as makeBoard } from './board.ts'
import { analyzedApps } from './changed-apps.ts'
import { readGroomRecord } from './groom-record.ts'
import { appendRefusal, nextAction, PROGRESS_NOTE_FILE, writeProgressNote, writeStep8PrBody, type NextAction, type ProgressNote } from './progress-note.ts'
import { redact } from './redact.ts'
import { REFUSED_EXIT, USAGE_EXIT, exitCodeFor, readRunStatus, type ReasonCode, type RunStatus } from './run-status.ts'
import { isCommittable, isSecretsFile } from './step-commands.ts'
import { checkParentRun, encodeTrace, parentRunSchema, releaseRunId, reserveRunId, telemetryFile, writeTelemetry, type Gap, type SpanInput, type SpanUsage } from './telemetry.ts'
import { HAND_USAGE_SOURCE, readSessionUsage, readUsageSource, subagentSpans, type Interval } from './telemetry-sources.ts'
import { TICKET_FILE, TicketArgumentError, WORK_DIR, workDirFor, ticketArgument, type BoardTrace, type Skill, type TicketArgument, type TicketRecord } from './ticket.ts'
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

/** The session's telemetry attach result, `--attach '{"blockId": …}'` or `'{"error": …}'`, for the verify step (KIT-19, F14). */
const attachSchema = z.union([z.object({ blockId: z.string().min(1) }), z.object({ error: z.string().min(1) })])

/** A local driver's --attach value as the verify step takes it; one that does not parse is recorded as an attach error, never a failed verify (OBS-002). */
export function attachArg(value: string | undefined): TelemetryAttachResult | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = attachSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : { error: '--attach is not {"blockId": "…"} or {"error": "…"}' }
  } catch {
    return { error: '--attach is not JSON' }
  }
}

/** Where the session writes its usage report for this hand run and the run id it names (KIT-19, F9); nothing for a step of a build-feature run (--parent-run). */
export async function sessionUsageStep(skill: Skill, folder: string, file: string): Promise<{ sessionUsage?: { file: string; runId: string } }> {
  const run = await readLocalRun(boardStateDir(folder, skill))
  return run?.runId === undefined || run.parentRun !== undefined ? {} : { sessionUsage: { file, runId: run.runId } }
}

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

/** The refusal for a `--parent-run` value that is not `<run-id>:<nonce>`. */
export const PARENT_RUN_FORMAT = '--parent-run must be <run-id>:<nonce>, the build-feature run id and the nonce of its pending step'

/** Refuse a `--parent-run` value that is malformed, or that does not name the pending step of the build-feature run in progress on the ticket (KIT-19, F6). Reads no board. */
export async function checkParentRunArgument(folder: string | null, value: string, when: 'start' | 'finish'): Promise<void> {
  if (!parentRunSchema.safeParse(value).success) throw new FlowRefused(PARENT_RUN_FORMAT)
  if (folder === null) throw new FlowRefused('--parent-run names a build-feature run, but the ticket has no working folder yet')
  await checkParentRun(folder, value, when)
}

const exec = promisify(execFile)

/** A note's run id when the stage has none to name yet (before the board stage reserved one, or a step of a build-feature run); every call site fills in what it knows. */
const NO_RUN_ID = '-'

/** Writes (or best-effort skips) the progress note for one driver stage. Never throws: a note is a convenience, not a gate. */
async function note(context: DriverContext, folder: string | null, build: () => Promise<ProgressNote | null> | ProgressNote | null): Promise<void> {
  if (folder === null) return
  try {
    const built = await build()
    if (built === null) return
    await writeProgressNote({ folder, repo: context.repo, notionToken: context.env?.NOTION_TOKEN, note: built })
  } catch {
    // A note is best-effort: a failure here must never stop the run it is trying to describe.
  }
}

/**
 * The folder a build-feature run already keeps for the ticket when no ticket.md names it yet (KIT-21):
 * `.work/<id>` or `.work/<id>-*` holding a build-feature run state. A fresh ticket's first step runs
 * before any ticket.md exists (build-feature resolves the card live), so its resolve stage must write
 * into that folder, not a second one, for `--parent-run` to find the run.
 */
export async function buildFeatureFolder(repo: string, ref: string): Promise<string | null> {
  const work = workDirFor(repo)
  if (!existsSync(work)) return null
  const lower = ref.trim().toLowerCase()
  const entries = (await readdir(work, { withFileTypes: true })).filter((entry) => entry.isDirectory() && (entry.name === lower || entry.name.startsWith(`${lower}-`))).sort((a, b) => a.name.localeCompare(b.name))
  return entries.map((entry) => join(work, entry.name)).find((folder) => existsSync(join(folder, '.local', 'build-feature', 'state.json'))) ?? null
}

/** Before the agent runs: the board stage, or the ticket with its input file (F5, F6, F8). */
export async function beforeRun(context: DriverContext, args: DriverTicketArgs): Promise<BeforeRun> {
  if (args.parentRun !== undefined && !parentRunSchema.safeParse(args.parentRun).success) throw new FlowRefused(PARENT_RUN_FORMAT)
  let argument = await resolveArgument(context, args)
  if (argument.kind === 'path') return { kind: 'none', path: argument.path, trace: noTicketTrace(context.skill) }
  if (args.parentRun !== undefined && argument.kind === 'ticket' && argument.folder === undefined) {
    const folder = await buildFeatureFolder(context.repo, argument.ref)
    if (folder !== null) argument = { ...argument, folder }
  }
  if (args.parentRun !== undefined) await checkParentRunArgument(argument.folder ?? null, args.parentRun, 'start')
  const config = (await readAspira(context.repo))!
  const folder = argument.folder ?? null
  // Until the folder exists the state lives under .work/.local; once the resolve step created the folder it moves in.
  const shared = join(workDirFor(context.repo), '.local', context.skill)
  const stateDir = folder === null ? shared : boardStateDir(folder, context.skill)
  if (folder !== null && !existsSync(join(stateDir, 'board.json')) && existsSync(join(shared, 'board.json'))) {
    await mkdir(stateDir, { recursive: true })
    await rename(join(shared, 'board.json'), join(stateDir, 'board.json'))
  }
  const step = await localBoardStep({ skill: context.skill, repo: context.repo, argument, board: config.board, stateDir, force: args.forcePull, forceRun: args.forceRun, dev: context.dev, env: context.env, ...(context.beforeClaim === undefined ? {} : { beforeClaim: context.beforeClaim }) })
  if ('stage' in step) {
    // Never clobber a note a finished run already left (Step 6's Next action, say) with a bare
    // "still resolving" announcement: only write one here when the ticket has none yet.
    const alreadyNoted = step.stage.folder !== null && (await readFile(join(step.stage.folder, PROGRESS_NOTE_FILE), 'utf8').catch(() => undefined)) !== undefined
    if (!alreadyNoted) {
      await note(context, step.stage.folder, async () => {
        const ticket = step.stage.folder === null ? null : await readTicketMd(step.stage.folder)
        if (ticket === null) return null
        return { id: ticket.id, title: ticket.title, skill: context.skill, runId: NO_RUN_ID, runStatus: 'needs-author', status: ticket.status, expectedStatus: null, outputs: [], completed: [], decisions: [], openIssues: [], nextAction: nextAction({ kind: 'continue', id: ticket.id, skill: context.skill }) }
      })
    }
    return { kind: 'stage', stage: step.stage }
  }
  await reserveLocalRun(stateDir, step.ready.folder, args.parentRun)
  const input = GATES[context.skill].input === undefined ? null : inputFileFor(context.skill, step.ready.folder, step.ready.statusBefore)
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

/** The notice for a hand run that has no run id: its launcher predates run telemetry. */
export const NO_RUN_ID_NOTICE = 'Telemetry not written: no run id; run kit update'
/** The notice for a --local run whose driver passed no session usage report: the driver predates run telemetry. */
export const NO_SESSION_USAGE_NOTICE = 'Telemetry not written: the local driver passed no session usage report; run kit update'

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
  return { file: null, notice: `Telemetry not written: ${result.reason}` }
}

/**
 * After the export: the pushes and the end move as actions for the session, the trace in the
 * export, and the run status and exit code next to them (F7, F8, F10, F53). The result depends
 * only on `run.status`: there is no separate `ok` to agree or disagree with it. The groomer calls
 * it once per round with `round`. A hand run also writes its telemetry file here, its root ending
 * now, with the subagents of the session usage report at `sessionUsage`, and the session gets the
 * actions to attach it; a run with `--parent-run`, or from a driver that passes no `sessionUsage`
 * (one older than run telemetry), writes and attaches nothing (KIT-19). Telemetry failures are
 * notices only: they never change the run status or exit code (OBS-002). The groomer's round ends
 * its run: the next round reserves a new run id.
 */
export async function afterRun(context: DriverContext, before: BeforeRun & { kind: 'ticket' }, run: { status: RunStatus; reasonCode?: ReasonCode | null; exportDir: string; verifyCommand: string; round?: number; sessionUsage?: string }) {
  const aspira = await readAspira(context.repo)
  const board = GATES[context.skill].record === undefined ? undefined : aspira?.board
  // With a Notion token the pages are pushed through the API from their files; without one the session pushes them.
  const token = process.env[BOARD_ENV]
  const push = token === undefined || token === '' || aspira?.board === undefined ? undefined : makeBoard({ board: aspira.board, token }).pushPage
  const stateDir = boardStateDir(before.folder, context.skill)
  const runStatus = run.status
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
    runStatus,
    reasonCode: run.reasonCode ?? null,
    exportDir: run.exportDir,
    stateDir,
    verifyCommand: run.verifyCommand,
    ...(run.round === undefined ? {} : { round: run.round }),
    ...(board === undefined ? {} : { board }),
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(push === undefined ? {} : { push }),
  })
  if (GATES[context.skill].record !== undefined && local?.runId !== undefined) await writeLocalRun(stateDir, {})
  await note(context, before.folder, async () => {
    // Nothing for the session to verify on a ready build step: the note goes straight to Step 7 or 8 (F21).
    const after = end.verify === null && runStatus === 'ready' ? await stepAfterBuild(context, before.folder, before.ticket) : null
    return {
      id: before.ticket.id,
      title: before.ticket.title,
      skill: context.skill,
      runId: local?.runId ?? NO_RUN_ID,
      runStatus,
      status: before.ticket.status,
      expectedStatus: end.verify?.status ?? null,
      outputs: after?.outputs ?? [],
      completed: [],
      decisions: [],
      openIssues: [...(end.remaining === null ? [] : [end.remaining]), ...(after?.openIssues ?? [])],
      nextAction: end.verify === null ? (after?.action ?? null) : { step: `Verify the board actions ${context.skill} asked for`, do: [], run: [end.verify.command], session: end.verify.command },
    }
  })
  return {
    ticket: `${before.ticket.id} ${before.ticket.title}`,
    folder: before.folder,
    runStatus,
    exitCode: exitCodeFor(runStatus),
    board: { stage: end.stage, actions: end.actions, verify: end.verify, trace: end.traceFile, ...(end.remaining === null ? {} : { remaining: end.remaining }) },
    ...(notices.length === 0 ? {} : { notices }),
  }
}

/** The verify step (`--verify`): ticket.md shows the Status the end stage expected; the report header comes back, with the run status and exit code (0 only when the board check passed and the status is ready) (F8, F10). */
export async function verifyRun(context: DriverContext, args: DriverTicketArgs, exportDirFor: (folder: string) => string) {
  const argument = await resolveArgument(context, args)
  if (argument.kind === 'path') throw new FlowRefused('--verify needs a ticket; a --no-ticket run has no board work to verify')
  const folder = argument.folder ?? null
  if (folder === null) throw new FlowRefused(`No working folder under ${WORK_DIR}/ holds a ${TICKET_FILE} for ${argument.ref}; nothing to verify`)
  const exportDir = exportDirFor(folder)
  const result = await localBoardVerify({ skill: context.skill, folder, exportDir, ...(args.attach === undefined ? {} : { attach: args.attach }) })
  // The run id the board stage reserved, read before a passing verify removes the state it lives in.
  const runId = (await readLocalRun(boardStateDir(folder, context.skill)))?.runId ?? NO_RUN_ID
  if (result.ok && (await roundStateEnds(context.skill, folder, args.finish === true))) await rm(boardStateDir(folder, context.skill), { recursive: true, force: true }).catch(() => undefined)
  const ticket = await readTicketMd(folder)
  // The status the export computed (its merged decisions included), never a fresh "ready": one run, one status (KIT-86).
  const runStatus: RunStatus = result.ok ? (result.trace.runStatus ?? 'ready') : 'incomplete'
  await note(context, folder, async () => {
    if (ticket === null) return null
    const after = runStatus === 'ready' ? await stepAfterBuild(context, folder, ticket) : null
    const action = result.ok
      ? (after?.action ?? nextAction({ kind: 'run', id: ticket.id, skill: context.skill, runStatus, verified: true, liveStatus: ticket.status }))
      : { step: 'Fix the verify problem, then run --verify again', do: [], run: [], session: '' }
    const openIssues = [...(result.problem === null ? [] : [result.problem]), ...(after?.openIssues ?? [])]
    return { id: ticket.id, title: ticket.title, skill: context.skill, runId, runStatus, status: ticket.status, expectedStatus: null, outputs: after?.outputs ?? [], completed: [], decisions: [], openIssues, nextAction: action }
  })
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
    ...(result.notices.length === 0 ? {} : { notices: result.notices }),
  }
}

/** What the implementor recorded about a ready --local build (F21, F22): the app directories it changed, its final commit and the branch it built on. */
type BuildRecord = { apps: string[]; head: string | null; branch: string | null }

async function buildRecordOf(folder: string): Promise<BuildRecord | null> {
  const text = await readFile(join(folder, 'plan.review', 'trace', 'implementation-local.json'), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as { status?: unknown; apps?: unknown; head?: unknown; branch?: unknown }
    if (typeof parsed.status !== 'string' || readRunStatus(parsed.status)?.status !== 'ready') return null
    const apps = Array.isArray(parsed.apps) ? parsed.apps.filter((app): app is string => typeof app === 'string') : []
    return { apps, head: typeof parsed.head === 'string' ? parsed.head : null, branch: typeof parsed.branch === 'string' ? parsed.branch : null }
  } catch {
    return null
  }
}

/** The checkout's uncommitted files (the analyzer's fixes), repository-relative, from `git status`; never the run's own `.work/` or `.static-analysis/` output. `[]` on any failure. */
async function uncommittedPaths(repo: string): Promise<string[]> {
  const output = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo }).then((result) => result.stdout, () => '')
  const entries = output.split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    // A rename or copy carries its source path as the next entry: skip it, the new path is what gets staged.
    if (entry[0] === 'R' || entry[0] === 'C') i += 1
  }
  return paths.filter((path) => !path.startsWith(`${WORK_DIR}/`) && !path.split('/').includes('.static-analysis'))
}

/**
 * The Next action after a ready implementor or code-analyzer run on a ticket (F21): Step 7 for the
 * first changed app directory the code analyzer has not finished for this ticket and the build's
 * head, or, once every one has, Step 8 as ordered commands with the PR body written to
 * `<folder>/pr-body.md` first (F42). The branch is the one the implementor recorded (F22). Null
 * for any other skill, or when there is no ready implementor record to read.
 */
async function stepAfterBuild(context: DriverContext, folder: string, ticket: { id: string; title: string; url: string }): Promise<{ action: NextAction; outputs: string[]; openIssues: string[] } | null> {
  if (context.skill !== 'implementor' && context.skill !== 'code-analyzer') return null
  const record = await buildRecordOf(folder)
  if (record === null) return null
  const done = record.head === null ? [] : await analyzedApps(context.repo, record.apps, { ticket: ticket.id, head: record.head })
  const base = { kind: 'run' as const, id: ticket.id, skill: context.skill, runStatus: 'ready' as const, verified: true, apps: record.apps, analyzedApps: done }
  if (record.apps.some((app) => !done.includes(app)) || record.branch === null) return { action: nextAction(base), outputs: [], openIssues: [] }
  const body = await writeStep8PrBody({ folder, repo: context.repo, ...(record.apps.length === 1 ? { app: record.apps[0]! } : {}), ticket })
  const paths = await uncommittedPaths(context.repo)
  const action = nextAction({ ...base, title: ticket.title, branch: record.branch, prBodyFile: relative(context.repo, body), paths })
  // A path Step 8 will not stage (a `.env*` secrets file, say) is named here instead of silently vanishing (AVA1.1).
  const openIssues = paths.filter((path) => !isCommittable(path)).map((path) => `Step 8 leaves ${path} out of the commit: ${isSecretsFile(path) ? 'a .env* file may hold secrets, so it is never staged' : 'it is outside what a PR may commit'}; commit it by hand only if it is meant to be in the PR.`)
  return { action, outputs: [body], openIssues }
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
export type RunErrorResult = { status: 'refused' | 'blocked' | 'incomplete'; reason: string; /** Same text as `reason`, for a caller that reads an error-shaped `.message`. */ message?: string; exitCode: number }

/** The folder a thrown error's own ticket argument resolves to, or null when none can be resolved at all (no positional, no known folder). Never throws. */
async function folderForError(context: DriverContext, args: DriverTicketArgs): Promise<string | null> {
  try {
    const argument = await resolveArgument(context, args)
    return argument.kind === 'path' ? null : (argument.folder ?? null)
  } catch {
    return null
  }
}

/**
 * Turns an error thrown by beforeRun/afterRun/verifyRun (or the agent's own pipeline) into the
 * run's final status and exit code (F9): FlowRefused and TicketArgumentError are refused (a board
 * gate or argument problem, REFUSED_EXIT); a KnowledgePrerequisiteError is blocked; a UsageError is
 * incomplete at USAGE_EXIT; anything else is incomplete with the error's own message as the reason.
 *
 * When a ticket folder can be resolved: a refusal appends a dated Open issues line to an existing,
 * finished note and keeps its Next action (appendRefusal); nothing is written when no finished note
 * exists yet. Any other status replaces the note outright with status incomplete, the reason under
 * Open issues, and Next action "rerun the step". No ticket folder at all writes nothing either way.
 */
export async function handleRunError(context: DriverContext, error: unknown, args: DriverTicketArgs): Promise<RunErrorResult> {
  const reason = error instanceof FlowRefused || error instanceof TicketArgumentError || error instanceof KnowledgePrerequisiteError || error instanceof UsageError || error instanceof Error ? error.message : String(error)
  const result: RunErrorResult =
    error instanceof FlowRefused || error instanceof TicketArgumentError
      ? { status: 'refused', reason, message: reason, exitCode: REFUSED_EXIT }
      : error instanceof KnowledgePrerequisiteError
        ? { status: 'blocked', reason, message: reason, exitCode: 1 }
        : error instanceof UsageError
          ? { status: 'incomplete', reason, message: reason, exitCode: USAGE_EXIT }
          : { status: 'incomplete', reason, message: reason, exitCode: 1 }
  const folder = await folderForError(context, args)
  if (folder === null) return result
  const file = join(folder, PROGRESS_NOTE_FILE)
  const redacted = await redact(result.reason, context.repo, { extra: context.env?.NOTION_TOKEN === undefined ? [] : [context.env.NOTION_TOKEN] }).catch(() => result.reason)
  if (result.status === 'refused' || result.status === 'blocked') {
    const existing = await readFile(file, 'utf8').catch(() => undefined)
    if (existing !== undefined) await writeFile(file, appendRefusal(existing, redacted)).catch(() => undefined)
    return result
  }
  const ticket = await readTicketMd(folder).catch(() => null)
  if (ticket === null) return result
  const command = `~/.claude/skills/aspira-${context.skill}/scripts/${context.skill}.sh local ${ticket.id}`
  await writeProgressNote({
    folder,
    repo: context.repo,
    notionToken: context.env?.NOTION_TOKEN,
    note: { id: ticket.id, title: ticket.title, skill: context.skill, runId: NO_RUN_ID, runStatus: 'incomplete', status: ticket.status, expectedStatus: null, outputs: [], completed: [], decisions: [], openIssues: [redacted], nextAction: { step: 'The run ended incomplete: rerun the step', do: [], run: [command], session: command } },
  }).catch(() => undefined)
  return result
}
