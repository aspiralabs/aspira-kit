// The command every launcher (skill/aspira-<agent>/scripts/<agent>.sh) runs around a separate-process
// run, through the agent's scripts/ticket.ts: `start` resolves, gates, pulls and claims the ticket
// before the agent is launched, so a refusal costs nothing; `finish` pushes the outputs and makes the
// success move once the agent exits; `resolve` reads a ticket for `kit next`. Output is one
// `key=value` per line, which bash reads without a JSON parser. Exit 3 is a refusal.

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { board as makeBoard, type Board } from './board.ts'
import { exitCodeFor, readRunStatus, REFUSED_EXIT, USAGE_EXIT } from './run-status.ts'
import { GATES, SKILLS, reportHeader, type Skill } from './ticket.ts'
import { FlowRefused, finishFlow, inputFileFor, readAspira, startFlow } from './ticket-flow.ts'
import { noBoardMessage, resolveArgument, UsageError } from './ticket-driver.ts'

export { REFUSED_EXIT }

const usage = (skill: string) => [
  `Usage: ticket.ts start [<ticket>] --repo DIR [--force-pull] [--force-run] [--dev NAME]`,
  `       ticket.ts finish --repo DIR --folder DIR --run-status STATUS [--ok | --failed (older launcher, ignored)] [--pr-url URL] [--export DIR]`,
  `       ticket.ts resolve <ticket> --repo DIR`,
  `       ticket.ts record --repo DIR --file <run record JSON> [--skill S]`,
  `  for the ${skill} skill`,
].join('\n')

const line = (key: string, value: string | undefined | null) => `${key}=${(value ?? '').replaceAll('\n', ' ')}`

/** Run the CLI; returns the exit code and prints to the given streams. `client` is a board for tests; default: board.ts on the env token. */
export async function ticketCli(
  skill: Skill,
  argv: string[],
  io: { out: (text: string) => void; err: (text: string) => void } = { out: console.log, err: console.error },
  env: Record<string, string | undefined> = process.env,
  client?: Board,
): Promise<number> {
  if (!SKILLS.includes(skill)) throw new Error(`not a skill: ${skill}`)
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { repo: { type: 'string' }, folder: { type: 'string' }, 'force-pull': { type: 'boolean' }, 'force-run': { type: 'boolean' }, dev: { type: 'string' }, ok: { type: 'boolean' }, failed: { type: 'boolean' }, 'run-status': { type: 'string' }, 'pr-url': { type: 'string' }, export: { type: 'string' }, file: { type: 'string' }, skill: { type: 'string' } },
    })
    const [command, positional, ...extra] = positionals
    if (command === undefined || extra.length > 0 || values.repo === undefined) throw new UsageError(usage(skill))
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
      const started = await startFlow({ skill, repo, argument, board: config.board, force: values['force-pull'] === true, forceRun: values['force-run'] === true, dev: values.dev, client: board, env })
      const input = inputOf(skill, started.folder)
      for (const [key, value] of Object.entries({ folder: started.folder, id: started.ticket.id, title: started.ticket.title, url: started.ticket.url, before: started.trace.statusBefore, status: started.ticket.status, pr: started.ticket.pr, input, pulled: started.pulled.join(' '), kept: started.kept.join(' ') })) io.out(line(key, value))
      return 0
    }
    if (command === 'finish') {
      // --ok/--failed are an older launcher's flags (F7): parsed so the call does not fail, never read.
      if (values.folder === undefined || values['run-status'] === undefined) throw new UsageError(usage(skill))
      const word = values['run-status']
      const read = readRunStatus(word)
      if (read === null) io.err(`unknown run status ${word}; recorded incomplete`)
      const finished = await finishFlow({ skill, folder: values.folder, runStatus: read?.status ?? 'incomplete', reasonCode: read?.reasonCode ?? null, prUrl: values['pr-url'], exportDir: values.export, board: config.board, client: board, env })
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
      if (finished.remaining !== null) io.out(finished.remaining)
      io.out(`Board trace: ${finished.traceFile}`)
      return exitCodeFor(finished.runStatus)
    }
    throw new UsageError(usage(skill))
  } catch (error) {
    if (error instanceof FlowRefused) {
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

function inputOf(skill: Skill, folder: string): string {
  if (GATES[skill].input === undefined) return ''
  try {
    return inputFileFor(skill, folder)
  } catch {
    return ''
  }
}
