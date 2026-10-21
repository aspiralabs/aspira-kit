// The command every launcher (skill/aspira-<agent>/scripts/<agent>.sh) runs around a separate-process
// run, through the agent's scripts/ticket.ts: `start` resolves, gates, pulls and claims the ticket
// before the agent is launched, so a refusal costs nothing; `finish` pushes the outputs and makes the
// success move once the agent exits; `resolve` reads a ticket for `kit next`. Output is one
// `key=value` per line, which bash reads without a JSON parser. Exit 3 is a refusal.

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { board as makeBoard, type Board } from './board.ts'
import { nextAction, writeProgressNote } from './progress-note.ts'
import { exitCodeFor, readRunStatus, REFUSED_EXIT, USAGE_EXIT, type RunStatus } from './run-status.ts'
import { parentRunSchema, reserveRunId } from './telemetry.ts'
import { GATES, SKILLS, TicketArgumentError, reportHeader, type Skill } from './ticket.ts'
import { FlowRefused, finishFlow, inputFileFor, readAspira, readTicketMd, startFlow } from './ticket-flow.ts'
import { NO_RUN_ID_NOTICE, PARENT_RUN_FORMAT, checkParentRunArgument, cloudHandRunSpans, noBoardMessage, resolveArgument, runStartTime, UsageError, writeHandRunTelemetry } from './ticket-driver.ts'

export { REFUSED_EXIT }

const usage = (skill: string) => [
  `Usage: ticket.ts start [<ticket>] --repo DIR [--force-pull] [--force-run] [--dev NAME] [--parent-run RUN:NONCE]`,
  `       ticket.ts finish --repo DIR --folder DIR --run-status STATUS [--ok | --failed (older launcher, ignored)] [--pr-url URL] [--export DIR] [--run-id ID --run-started ISO | --parent-run RUN:NONCE]`,
  `       ticket.ts resolve <ticket> --repo DIR`,
  `       ticket.ts record --repo DIR --file <run record JSON> [--skill S]`,
  `  for the ${skill} skill`,
  `  start prints run-id= and run-started=; the launcher passes them to finish, which writes the run's telemetry file.`,
  `  --parent-run marks a step of a build-feature run: it writes and attaches no telemetry of its own.`,
].join('\n')

/** The run id and start time `finish` takes from its launcher, as `start` printed them. */
const handRunSchema = z.object({ runId: z.string().regex(/^run-\d{8}T\d{6}Z(-\d+)?$/), startedAt: z.iso.datetime() })

const line = (key: string, value: string | undefined | null) => `${key}=${(value ?? '').replaceAll('\n', ' ')}`

/**
 * Run the CLI; returns the exit code and prints to the given streams. `client` is a board for tests;
 * default: board.ts on the env token. `models` maps an agent name of the skill's usage file to its
 * model id (pr-reviewer's usage lines carry none), for the run's telemetry.
 */
export async function ticketCli(
  skill: Skill,
  argv: string[],
  io: { out: (text: string) => void; err: (text: string) => void } = { out: console.log, err: console.error },
  env: Record<string, string | undefined> = process.env,
  client?: Board,
  models?: Readonly<Record<string, string>>,
): Promise<number> {
  if (!SKILLS.includes(skill)) throw new Error(`not a skill: ${skill}`)
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        folder: { type: 'string' },
        'force-pull': { type: 'boolean' },
        'force-run': { type: 'boolean' },
        dev: { type: 'string' },
        ok: { type: 'boolean' },
        failed: { type: 'boolean' },
        'run-status': { type: 'string' },
        'pr-url': { type: 'string' },
        export: { type: 'string' },
        file: { type: 'string' },
        skill: { type: 'string' },
        run: { type: 'string' },
        'parent-run': { type: 'string' },
        'run-id': { type: 'string' },
        'run-started': { type: 'string' },
      },
    })
    const [command, positional, ...extra] = positionals
    if (command === undefined || extra.length > 0 || values.repo === undefined) throw new UsageError(usage(skill))
    const parentRun = values['parent-run']
    // A malformed --parent-run is refused before anything is read (KIT-19, F6).
    if (parentRun !== undefined && command !== 'resolve' && !parentRunSchema.safeParse(parentRun).success) throw new FlowRefused(PARENT_RUN_FORMAT)
    const repo = values.repo
    if (command === 'record') {
      if (values.file === undefined) throw new UsageError(usage(skill))
      const text = await readFile(values.file, 'utf8').catch(() => undefined)
      const parsed = text === undefined ? undefined : JSON.parse(text)
      const word = parsed !== null && typeof parsed === 'object' && 'status' in parsed ? String((parsed as { status: unknown }).status) : undefined
      const read = word === undefined ? null : readRunStatus(word)
      const status = read?.status ?? 'incomplete'
      io.out(line('status', status))
      io.out(line('reason', read === null ? `${values.file}${text === undefined ? ' is missing' : word === undefined ? ' has no status' : `'s status is "${word}", which is not a known run status`}` : ''))
      io.out(line('reasonCode', read?.reasonCode ?? ''))
      return exitCodeFor(status)
    }
    if (command === 'note') {
      if (values.folder === undefined || values.run === undefined) throw new UsageError(usage(skill))
      const ticket = await readTicketMd(values.folder)
      if (ticket === null) throw new UsageError(`${values.folder}/ticket.md is missing; the start step writes it`)
      const wait = `${skill}.sh wait ${values.run}`
      await writeProgressNote({
        folder: values.folder,
        repo,
        notionToken: env.NOTION_TOKEN,
        note: { id: ticket.id, title: ticket.title, skill, runId: values.run, runStatus: 'needs-author', status: ticket.status, expectedStatus: null, outputs: [], completed: [], decisions: [], openIssues: [], nextAction: { step: `${skill} is running: wait for it to finish`, do: [], run: [wait], session: wait } },
      })
      return 0
    }
    const config = await readAspira(repo)
    if (config === null) {
      io.err(noBoardMessage(repo, skill))
      return REFUSED_EXIT
    }
    const board = client ?? makeBoard({ board: config.board, token: env.NOTION_TOKEN })
    if (command === 'resolve') {
      if (positional === undefined) throw new UsageError(usage(skill))
      const ticket = await board.resolveTicket(positional)
      for (const [key, value] of Object.entries({ id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, pr: ticket.pr, dev: ticket.dev })) io.out(line(key, value))
      return 0
    }
    if (command === 'start') {
      const argument = await resolveArgument({ skill, repo, env }, { positional })
      if (argument.kind === 'path') throw new UsageError(usage(skill))
      if (parentRun !== undefined) await checkParentRunArgument(argument.folder ?? null, parentRun, 'start')
      const started = await startFlow({ skill, repo, argument, board: config.board, force: values['force-pull'] === true, forceRun: values['force-run'] === true, dev: values.dev, client: board, env })
      const input = inputOf(skill, started.folder, started.trace.statusBefore ?? undefined)
      for (const [key, value] of Object.entries({ folder: started.folder, id: started.ticket.id, title: started.ticket.title, url: started.ticket.url, before: started.trace.statusBefore, status: started.ticket.status, pr: started.ticket.pr, input, pulled: started.pulled.join(' '), kept: started.kept.join(' ') })) io.out(line(key, value))
      // The run id is reserved once the gate passed, so a refused start reserves none (KIT-19, F1, F13).
      if (parentRun === undefined) {
        const startedAt = runStartTime()
        const runId = await reserveRunId(started.folder, startedAt)
        io.out(line('run-id', runId))
        io.out(line('run-started', startedAt))
      }
      return 0
    }
    if (command === 'finish') {
      // --ok/--failed are an older launcher's flags (F7): parsed so the call does not fail, never read.
      if (values.folder === undefined || values['run-status'] === undefined) throw new UsageError(usage(skill))
      const folder = values.folder
      const word = values['run-status']
      const read = readRunStatus(word)
      if (read === null) io.err(`unknown run status ${word}; recorded incomplete`)
      const runStatus = read?.status ?? 'incomplete'
      const notices: string[] = []
      let telemetry: { runId: string; file: string } | undefined
      if (parentRun !== undefined) await checkParentRunArgument(folder, parentRun, 'finish')
      else {
        // The telemetry carries the run status as read (one of the five words), not the launcher's raw word.
        const written = await writeCloudTelemetry({ skill, folder, status: runStatus, exportDir: values.export, runId: values['run-id'], runStarted: values['run-started'], ...(models === undefined ? {} : { models }) })
        // A launcher older than run telemetry passes no run id: a warning beside the output, which stays as before.
        if (written.notice === NO_RUN_ID_NOTICE) io.err(written.notice)
        else if (written.notice !== null) notices.push(written.notice)
        if (written.telemetry !== null) telemetry = written.telemetry
      }
      const finished = await finishFlow({ skill, folder, runStatus, reasonCode: read?.reasonCode ?? null, prUrl: values['pr-url'], exportDir: values.export, board: config.board, client: board, env, ...(telemetry === undefined ? {} : { telemetry }) })
      // A row with a record (the groomer) leads with the recorded word, which the launcher reads.
      const recorded = GATES[skill].record !== undefined
      if (recorded) io.out(line('run-status', finished.runStatus))
      for (const text of reportHeader(finished.trace)) io.out(text)
      if (recorded) {
        io.out(`${GATES[skill].pulls?.[0]?.title ?? 'Decisions'}: ${finished.groom?.url ?? 'not created yet'}`)
        io.out(`Open questions: ${finished.groom?.open ?? 0}`)
      }
      for (const failure of finished.pushFailures) io.out(`Push failed: ${failure}`)
      for (const notice of finished.notices) io.out(notice)
      // Telemetry lines are notices only: they never change the exit code (OBS-002, F16).
      for (const notice of [...notices, ...finished.telemetryFailures]) io.out(notice)
      if (finished.remaining !== null) io.out(finished.remaining)
      io.out(`Board trace: ${finished.traceFile}`)
      const ticketAfter = await readTicketMd(values.folder).catch(() => null)
      if (ticketAfter !== null) {
        const action =
          finished.runStatus === 'ready'
            ? nextAction({ kind: 'run', id: ticketAfter.id, skill, runStatus: 'ready', verified: true, liveStatus: ticketAfter.status })
            : nextAction({ kind: 'run', id: ticketAfter.id, skill, runStatus: finished.runStatus, reason: finished.pushFailures[0] ?? finished.notices[0] })
        await writeProgressNote({
          folder: values.folder,
          repo,
          notionToken: env.NOTION_TOKEN,
          note: { id: ticketAfter.id, title: ticketAfter.title, skill, runId: values.run ?? telemetry?.runId ?? '-', runStatus: finished.runStatus, status: ticketAfter.status, expectedStatus: null, outputs: [], completed: finished.notices, decisions: [], openIssues: finished.pushFailures, nextAction: action },
        }).catch(() => undefined)
      }
      return exitCodeFor(finished.runStatus)
    }
    throw new UsageError(usage(skill))
  } catch (error) {
    // A wrong ticket argument is a refusal before any folder exists (F15), as handleRunError has it.
    if (error instanceof FlowRefused || error instanceof TicketArgumentError) {
      io.err(`${skill}: refused: ${error.message}`)
      return REFUSED_EXIT
    }
    if (error instanceof UsageError) {
      io.err(`${skill} ticket: ${error.message}`)
      return USAGE_EXIT
    }
    io.err(`${skill} ticket: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/**
 * A default/cloud hand run's telemetry at finish (KIT-19, F1, F5, F19): the root runs from the
 * start time its launcher carried over to now, with the phases of the skill's usage file under
 * the export dir. Returns the file to attach, or the notice when none was written: a launcher
 * older than this change passes no run id.
 */
async function writeCloudTelemetry(args: { skill: Skill; folder: string; status: RunStatus; exportDir: string | undefined; runId: string | undefined; runStarted: string | undefined; models?: Readonly<Record<string, string>> }): Promise<{ telemetry: { runId: string; file: string } | null; notice: string | null }> {
  if (args.runId === undefined) return { telemetry: null, notice: NO_RUN_ID_NOTICE }
  const run = handRunSchema.safeParse({ runId: args.runId, startedAt: args.runStarted })
  if (!run.success) return { telemetry: null, notice: 'Telemetry not written: --run-id and --run-started are not the run id and start time ticket.ts start printed' }
  const ticket = await readTicketMd(args.folder)
  if (ticket === null) return { telemetry: null, notice: 'Telemetry not written: the working folder has no ticket.md' }
  const endedAt = new Date().toISOString()
  const spans = await cloudHandRunSpans(args.skill, args.exportDir, { start: run.data.startedAt, end: endedAt }, args.models)
  const written = await writeHandRunTelemetry({ skill: args.skill, folder: args.folder, ticketId: ticket.id, runId: run.data.runId, startedAt: run.data.startedAt, endedAt, status: args.status, mode: 'cloud', spans })
  return { telemetry: written.file === null ? null : { runId: run.data.runId, file: written.file }, notice: written.notice }
}

function inputOf(skill: Skill, folder: string, statusBefore?: string): string {
  if (GATES[skill].input === undefined) return ''
  try {
    return inputFileFor(skill, folder, statusBefore)
  } catch {
    return ''
  }
}
