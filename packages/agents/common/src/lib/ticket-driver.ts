// What every agent's --local driver (scripts/local.ts) does around its runLocal: resolve the ticket
// argument, run the board stage before knowledge, and at the end print the board actions for the
// session with the trace written into the export. One module, so the six drivers behave the same
// and are tested once. Nothing here touches an agent's own pipeline. It also writes
// `.work/<id>-<slug>/progress.md` at every return to the session, so a crashed or resumed run
// always has a Next action to read (F14-F21).

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { analyzedApps } from './changed-apps.ts'
import { readGroomRecord } from './groom-record.ts'
import { appendRefusal, nextAction, PROGRESS_NOTE_FILE, writeProgressNote, writeStep8PrBody, type NextAction, type ProgressNote } from './progress-note.ts'
import { redact } from './redact.ts'
import { isCommittable, isSecretsFile } from './step-commands.ts'
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

const exec = promisify(execFile)

/** A note's fields this module does not yet have a real value for (no run has an id of its own here); every call site fills in what it knows. */
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
  await note(context, before.folder, async () => {
    // Nothing for the session to verify on a ready build step: the note goes straight to Step 7 or 8 (F21).
    const after = end.verify === null && run.status === 'ready' ? await stepAfterBuild(context, before.folder, before.ticket) : null
    return {
      id: before.ticket.id,
      title: before.ticket.title,
      skill: context.skill,
      runId: NO_RUN_ID,
      runStatus: run.status,
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
  await note(context, folder, async () => {
    if (ticket === null) return null
    const after = result.ok ? await stepAfterBuild(context, folder, ticket) : null
    const action = result.ok
      ? (after?.action ?? nextAction({ kind: 'run', id: ticket.id, skill: context.skill, runStatus: 'ready', verified: true, liveStatus: ticket.status }))
      : { step: 'Fix the verify problem, then run --verify again', do: [], run: [], session: '' }
    const openIssues = [...(result.problem === null ? [] : [result.problem]), ...(after?.openIssues ?? [])]
    return { id: ticket.id, title: ticket.title, skill: context.skill, runId: NO_RUN_ID, runStatus, status: ticket.status, expectedStatus: null, outputs: after?.outputs ?? [], completed: [], decisions: [], openIssues, nextAction: action }
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
  const command = `.claude/skills/aspira-${context.skill}/scripts/${context.skill}.sh local ${ticket.id}`
  await writeProgressNote({
    folder,
    repo: context.repo,
    notionToken: context.env?.NOTION_TOKEN,
    note: { id: ticket.id, title: ticket.title, skill: context.skill, runId: NO_RUN_ID, runStatus: 'incomplete', status: ticket.status, expectedStatus: null, outputs: [], completed: [], decisions: [], openIssues: [redacted], nextAction: { step: 'The run ended incomplete: rerun the step', do: [], run: [command], session: command } },
  }).catch(() => undefined)
  return result
}
