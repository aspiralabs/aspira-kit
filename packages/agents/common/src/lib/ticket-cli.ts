// The command every launcher (skill/aspira-<agent>/scripts/<agent>.sh) runs around a separate-process
// run, through the agent's scripts/ticket.ts: `start` resolves, gates, pulls and claims the ticket
// before the agent is launched, so a refusal costs nothing; `finish` pushes the outputs and makes the
// success move once the agent exits; `resolve` reads a ticket for `kit next`. Output is one
// `key=value` per line, which bash reads without a JSON parser. Exit 3 is a refusal.

import { parseArgs } from 'node:util'
import { board as makeBoard, type Board } from './board.ts'
import { GATES, RUN_STATUSES, SKILLS, reportHeader, type Skill } from './ticket.ts'
import { FlowRefused, finishFlow, inputFileFor, readAspira, startFlow } from './ticket-flow.ts'
import { noBoardMessage, resolveArgument, runStatusOf } from './ticket-driver.ts'

export const REFUSED_EXIT = 3

const usage = (skill: string) => [
  `Usage: ticket.ts start [<ticket>] --repo DIR [--force-pull] [--force-run] [--dev NAME]`,
  `       ticket.ts finish --repo DIR --folder DIR (--ok | --failed) --run-status STATUS [--pr-url URL] [--export DIR]`,
  `       ticket.ts resolve <ticket> --repo DIR`,
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
      options: { repo: { type: 'string' }, folder: { type: 'string' }, 'force-pull': { type: 'boolean' }, 'force-run': { type: 'boolean' }, dev: { type: 'string' }, ok: { type: 'boolean' }, failed: { type: 'boolean' }, 'run-status': { type: 'string' }, 'pr-url': { type: 'string' }, export: { type: 'string' } },
    })
    const [command, positional, ...extra] = positionals
    if (command === undefined || extra.length > 0 || values.repo === undefined) throw new Error(usage(skill))
    const repo = values.repo
    const config = await readAspira(repo)
    if (config === null) {
      io.err(noBoardMessage(repo, skill))
      return REFUSED_EXIT
    }
    const board = client ?? makeBoard({ board: config.board, token: env.NOTION_TOKEN })
    if (command === 'resolve') {
      if (positional === undefined) throw new Error(usage(skill))
      const ticket = await board.resolveTicket(positional)
      for (const [key, value] of Object.entries({ id: ticket.id, title: ticket.title, url: ticket.url, status: ticket.status, pr: ticket.pr, dev: ticket.dev })) io.out(line(key, value))
      return 0
    }
    if (command === 'start') {
      const argument = await resolveArgument({ skill, repo, env }, { positional })
      if (argument.kind === 'path') throw new Error(usage(skill))
      const started = await startFlow({ skill, repo, argument, board: config.board, force: values['force-pull'] === true, forceRun: values['force-run'] === true, dev: values.dev, client: board, env })
      const input = inputOf(skill, started.folder)
      for (const [key, value] of Object.entries({ folder: started.folder, id: started.ticket.id, title: started.ticket.title, url: started.ticket.url, before: started.trace.statusBefore, status: started.ticket.status, pr: started.ticket.pr, input, pulled: started.pulled.join(' '), kept: started.kept.join(' ') })) io.out(line(key, value))
      return 0
    }
    if (command === 'finish') {
      if (values.folder === undefined || values['run-status'] === undefined || values.ok === values.failed) throw new Error(usage(skill))
      const word = values['run-status']
      const runStatus = runStatusOf(word)
      if (!RUN_STATUSES.some((status) => status === word)) io.err(`unknown run status ${word}; recorded incomplete`)
      const finished = await finishFlow({ skill, folder: values.folder, ok: values.ok === true, runStatus, prUrl: values['pr-url'], exportDir: values.export, board: config.board, client: board, env })
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
      const differs = recorded && finished.runStatus !== runStatus
      return finished.pushFailures.length === 0 && !differs ? 0 : 1
    }
    throw new Error(usage(skill))
  } catch (error) {
    if (error instanceof FlowRefused) {
      io.err(`${skill}: refused: ${error.message}`)
      return REFUSED_EXIT
    }
    io.err(`${skill} ticket: ${error instanceof Error ? error.message : String(error)}`)
    return 2
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
