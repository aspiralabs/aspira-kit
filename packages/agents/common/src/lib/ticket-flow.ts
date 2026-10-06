// The ticket flow on a file system and a board: the working folder under .work/, the pull into it,
// the gate, the moves and the pushes. Two paths share it. The separate-process path (`startFlow`
// and `finishFlow`) performs every board action itself through board.ts with NOTION_TOKEN. The
// --local path (`localBoardStep`, `localBoardEnd`, `localBoardVerify`) lists the same actions as
// data for the Claude Code session to perform with the Notion MCP, and verifies ticket.md between
// steps. Both record every action, with the Status before and after, in the run's trace.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BoardError, board as makeBoard, type Board, type Ticket } from './board.ts'
import {
  DEFAULT_DEV,
  DEV_ENV,
  GATES,
  IDEA_FILE,
  TICKET_FILE,
  TICKET_PAGES,
  WORK_DIR,
  checkGate,
  endMove,
  parseTicketMd,
  pullDecision,
  pushesFor,
  renderTicketMd,
  reportHeader,
  ticketMdFormat,
  workFolderName,
  type BoardAction,
  type BoardTrace,
  type BoardTraceEntry,
  type Skill,
  type TicketArgument,
  type TicketRecord,
  type WorkFolder,
} from './ticket.ts'

/** The project's board configuration, `aspira.json` at the repository root (F2). */
export const ASPIRA_FILE = 'aspira.json'
export type AspiraConfig = { board: string; releases?: string }

/** The file a run's board work is recorded in: `trace/board.json`, or `board.json` when the export has no trace/. */
export const BOARD_TRACE_FILE = 'board.json'

export class FlowRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowRefused'
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** aspira.json, or null when the project has no board. Throws when the file is not what kit init writes. */
export async function readAspira(repo: string): Promise<AspiraConfig | null> {
  const file = join(repo, ASPIRA_FILE)
  if (!existsSync(file)) return null
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<AspiraConfig>
  if (typeof parsed.board !== 'string' || parsed.board === '') throw new FlowRefused(`${file} has no "board"; run kit init --board <Feature Board URL>`)
  return { board: parsed.board, ...(typeof parsed.releases === 'string' ? { releases: parsed.releases } : {}) }
}

/** Every folder under .work/ that holds a ticket.md, with the ticket it names. */
export async function findWorkFolders(repo: string): Promise<WorkFolder[]> {
  const dir = join(repo, WORK_DIR)
  if (!existsSync(dir)) return []
  const out: WorkFolder[] = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const folder = join(dir, entry.name)
    const ticket = await readTicketMd(folder)
    if (ticket !== null) out.push({ folder, id: ticket.id, url: ticket.url })
  }
  return out
}

/** The ticket.md of a working folder, or null. */
export async function readTicketMd(folder: string): Promise<TicketRecord | null> {
  const text = await readFile(join(folder, TICKET_FILE), 'utf8').catch(() => null)
  return text === null ? null : parseTicketMd(text)
}

const modifiedAt = async (file: string): Promise<string | undefined> => stat(file).then((s) => s.mtime.toISOString(), () => undefined)

type PullItem = { title: string; file: string; page: string; decision: 'write' | 'keep' | 'conflict'; reason: string }

/** The pull plan for a ticket against its folder: each page the ticket has, mapped to its file, with the decision (F5). */
export async function pullPlan(ticket: TicketRecord, folder: string, previous: Record<string, string>, force: boolean): Promise<PullItem[]> {
  const items: PullItem[] = []
  for (const { title, file } of TICKET_PAGES) {
    const page = ticket.pages[title]
    if (page === undefined) continue
    const path = join(folder, file)
    const exists = existsSync(path)
    const recordedAt = previous[title]
    const decision = pullDecision({ exists, localModifiedAt: await modifiedAt(path), recordedAt, pageEditedAt: page.lastEditedAt, force })
    const reason = !exists ? 'not in the working folder' : decision === 'keep' ? 'unchanged since the last pull' : recordedAt === undefined ? 'no pull recorded' : `edited on the ticket after the last pull (${recordedAt})`
    items.push({ title, file: path, page: page.url, decision, reason })
  }
  return items
}

/** The refusal for a pull with conflicts: which files, and the flag. */
export function conflictMessage(items: PullItem[]): string | null {
  const conflicts = items.filter((item) => item.decision === 'conflict')
  if (conflicts.length === 0) return null
  return `Not overwriting ${conflicts.length === 1 ? 'a local file' : 'local files'} newer than ${conflicts.length === 1 ? 'its page' : 'their pages'}: ${conflicts.map((item) => `${item.file} (${item.title})`).join(', ')}. Pass --force-pull to replace ${conflicts.length === 1 ? 'it' : 'them'} with the ticket's version.`
}

const entry = (action: BoardAction['action'], detail: string, before: string, after: string, ok = true, error?: string): BoardTraceEntry => ({ at: new Date().toISOString(), action, detail, statusBefore: before, statusAfter: after, ok, ...(error === undefined ? {} : { error }) })

/** Write the trace into an export: `<dir>/trace/board.json` when it has a trace/, else `<dir>/board.json`. Returns the file. */
export async function writeBoardTrace(dir: string, trace: BoardTrace): Promise<string> {
  const traceDir = join(dir, 'trace')
  const target = existsSync(traceDir) ? traceDir : dir
  await mkdir(target, { recursive: true })
  const file = join(target, BOARD_TRACE_FILE)
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`)
  return file
}

export async function readBoardTrace(dir: string): Promise<{ file: string; trace: BoardTrace } | null> {
  for (const file of [join(dir, 'trace', BOARD_TRACE_FILE), join(dir, BOARD_TRACE_FILE)]) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text !== null) return { file, trace: JSON.parse(text) as BoardTrace }
  }
  return null
}

/** The trace of a run with no ticket (--no-ticket). */
export const noTicketTrace = (skill: Skill): BoardTrace => ({ skill, ticket: null, folder: null, statusBefore: null, statusAfter: null, pushed: [], actions: [] })

const record = (ticket: Ticket, pulledAt: string): TicketRecord => ({
  id: ticket.id,
  title: ticket.title,
  url: ticket.url,
  status: ticket.status,
  type: ticket.type,
  priority: ticket.priority,
  area: ticket.area,
  dev: ticket.dev,
  pr: ticket.pr,
  version: ticket.version,
  idea: ticket.idea,
  pulledAt,
  pages: ticket.pages,
})

const writeInto = async (file: string, text: string) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

const previousPagesOf = (ticket: TicketRecord | null): Record<string, string> => Object.fromEntries(Object.values(ticket?.pages ?? {}).map((page) => [page.title, page.lastEditedAt]))

// ---------------------------------------------------------------------------------------------
// The separate-process path: the flow performs every action through board.ts.
// ---------------------------------------------------------------------------------------------

export type FlowOptions = {
  skill: Skill
  repo: string
  argument: TicketArgument
  /** The Feature Board, from aspira.json. */
  board: string
  force?: boolean
  dev?: string
  /** A board client, for tests; default: board.ts on NOTION_TOKEN. */
  client?: Board
  env?: Record<string, string | undefined>
}

export type FlowStart = { ticket: TicketRecord; folder: string; trace: BoardTrace; pulled: string[]; kept: string[] }

/** Resolve, gate, pull, claim: everything a skill does before its first model call (F5, F6). Throws FlowRefused before any board write when the gate refuses. */
export async function startFlow(options: FlowOptions): Promise<FlowStart> {
  const env = options.env ?? process.env
  const client = options.client ?? makeBoard({ board: options.board, token: env.NOTION_TOKEN })
  const dev = options.dev ?? env[DEV_ENV] ?? DEFAULT_DEV
  if (options.argument.kind === 'path') throw new Error('startFlow needs a ticket; --no-ticket runs make no board actions')
  const ticket = await client.resolveTicket(options.argument.ref)
  const gate = checkGate(options.skill, ticket)
  if (!gate.ok) throw new FlowRefused(gate.message)
  const folder = options.argument.folder ?? join(options.repo, WORK_DIR, workFolderName(ticket))
  const previous = previousPagesOf(await readTicketMd(folder))
  const now = new Date().toISOString()
  const current = record(ticket, now)
  const plan = await pullPlan(current, folder, previous, options.force === true)
  const conflict = conflictMessage(plan)
  if (conflict !== null) throw new FlowRefused(conflict)

  const trace: BoardTrace = { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  trace.actions.push(entry('resolve', `${ticket.id} resolved from ${options.argument.ref}`, ticket.status, ticket.status))
  await mkdir(folder, { recursive: true })
  await writeInto(join(folder, IDEA_FILE), ticket.idea)
  const pulled: string[] = []
  const kept: string[] = []
  for (const item of plan) {
    if (item.decision === 'keep') { kept.push(item.file); continue }
    const page = await client.pullPage(ticket, item.title)
    if (page === undefined) continue
    await writeInto(item.file, page.markdown)
    pulled.push(item.file)
    trace.actions.push(entry('pull', `${item.title} -> ${item.file} (${item.reason})`, ticket.status, ticket.status))
  }
  if (gate.startMove !== null) {
    try {
      await client.setProperty(ticket, 'Dev', dev)
      trace.actions.push(entry('set', `Dev = ${dev}`, ticket.status, ticket.status))
      const moved = await client.moveTicket(ticket, gate.startMove.from, gate.startMove.to)
      trace.actions.push(entry('move', `${moved.before} -> ${moved.after}`, moved.before, moved.after))
      current.status = moved.after
      current.dev = dev
      trace.statusAfter = moved.after
    } catch (error) {
      trace.actions.push(entry('move', `${gate.startMove.from} -> ${gate.startMove.to}`, ticket.status, ticket.status, false, message(error)))
      throw error
    }
  }
  await writeInto(join(folder, TICKET_FILE), renderTicketMd(current))
  return { ticket: current, folder, trace, pulled, kept }
}

export type FinishOptions = {
  skill: Skill
  folder: string
  /** Did the run succeed (the skill's own success status)? */
  ok: boolean
  /** The run's status word, for the pushes that depend on it (needs-author). */
  runStatus: string
  /** The PR the implementor opened, when it did. */
  prUrl?: string
  /** The export directory the trace is written into; default: the working folder. */
  exportDir?: string
  board: string
  client?: Board
  env?: Record<string, string | undefined>
  /** The trace the start left, continued here. */
  trace?: BoardTrace
}

export type FlowFinish = { trace: BoardTrace; traceFile: string; header: string[]; pushFailures: string[]; remaining: string | null }

/** Push the outputs and make the success move (F7). A push failure is reported with the local path and the move is still made. */
export async function finishFlow(options: FinishOptions): Promise<FlowFinish> {
  const env = options.env ?? process.env
  const client = options.client ?? makeBoard({ board: options.board, token: env.NOTION_TOKEN })
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing; the start step writes it`)
  const trace: BoardTrace = options.trace ?? { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder: options.folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  const pushFailures: string[] = []
  let status = ticket.status
  if (options.ok) {
    for (const push of pushesFor(options.skill, options.runStatus)) {
      const file = join(options.folder, push.file)
      const markdown = await readFile(file, 'utf8').catch(() => null)
      if (markdown === null) {
        pushFailures.push(`${push.title}: ${file} does not exist`)
        trace.actions.push(entry('push', `${push.title} from ${file}`, status, status, false, 'file missing'))
        continue
      }
      try {
        const result = await client.pushPage(ticket.url, push.title, markdown)
        trace.pushed.push({ title: push.title, url: result.url })
        ticket.pages[push.title] = { id: result.id, title: push.title, url: result.url, lastEditedAt: new Date().toISOString() }
        trace.actions.push(entry('push', `${push.title} from ${file} (${result.created ? 'created' : 'replaced'})`, status, status))
      } catch (error) {
        pushFailures.push(`${push.title}: ${message(error)}; the output is at ${file}`)
        trace.actions.push(entry('push', `${push.title} from ${file}`, status, status, false, message(error)))
      }
    }
  }
  let prOpened = false
  if (options.skill === 'implementor' && options.ok && options.prUrl !== undefined && options.prUrl !== '') {
    try {
      await client.setProperty(ticket.url, 'PR', options.prUrl)
      ticket.pr = options.prUrl
      prOpened = true
      trace.actions.push(entry('set', `PR = ${options.prUrl}`, status, status))
    } catch (error) {
      trace.actions.push(entry('set', `PR = ${options.prUrl}`, status, status, false, message(error)))
    }
  }
  const move = endMove(options.skill, options.ok, status, prOpened)
  if (move !== null) {
    try {
      const moved = await client.moveTicket(ticket.url, move.from, move.to)
      trace.actions.push(entry('move', `${moved.before} -> ${moved.after}`, moved.before, moved.after))
      status = moved.after
    } catch (error) {
      trace.actions.push(entry('move', `${move.from} -> ${move.to}`, status, status, false, message(error)))
    }
  }
  ticket.status = status
  trace.statusAfter = status
  await writeInto(join(options.folder, TICKET_FILE), renderTicketMd(ticket))
  const traceFile = await writeBoardTrace(options.exportDir ?? options.folder, trace)
  const remaining = remainingStep(options.skill, options.ok, status, prOpened)
  return { trace, traceFile, header: reportHeader(trace), pushFailures, remaining }
}

/** What is left for a human after the run, when the skill's success move was not made. */
export function remainingStep(skill: Skill, ok: boolean, status: string, prOpened: boolean): string | null {
  const gate = GATES[skill]
  if (skill === 'implementor' && ok && !prOpened) return `The ticket stays in "${status}": opening the PR is the remaining step. Push the branch, open the PR, set the ticket's PR property and move it to "In Review: Implementation".`
  if (!ok && gate.inProgress !== undefined) return `The run did not succeed, so the ticket stays in "${status}". Fix what stopped it and run ${skill} again; a rerun from "${gate.inProgress}" makes no start move.`
  return null
}

// ---------------------------------------------------------------------------------------------
// The --local path: the session performs the actions with the Notion MCP; the driver verifies.
// ---------------------------------------------------------------------------------------------

/** The `board` stage, printed before `knowledge` (F8): the actions as data, and what ticket.md must show before the driver goes on. */
export type BoardStage = {
  pending: true
  status: 'pending'
  stage: 'board'
  ticket: string
  folder: string | null
  actions: BoardAction[]
  /** What ticket.md must show once the actions are done. */
  verify: { file: string; status: string | null }
  note: string
}

export type LocalBoardState = {
  skill: Skill
  ref: string
  phase: 'resolve' | 'sync' | 'ready'
  folder: string | null
  askedAt: string | null
  syncAskedAt: string | null
  previous: Record<string, string>
  statusBefore: string | null
  trace: BoardTrace | null
}

export type LocalBoardOptions = {
  skill: Skill
  repo: string
  argument: TicketArgument
  board: string
  /** Where the driver keeps its state between calls (the run's work directory). */
  stateDir: string
  force?: boolean
  dev?: string
  env?: Record<string, string | undefined>
}

const stateFile = (dir: string) => join(dir, 'board.json')

async function readState(dir: string): Promise<LocalBoardState | null> {
  const text = await readFile(stateFile(dir), 'utf8').catch(() => null)
  return text === null ? null : (JSON.parse(text) as LocalBoardState)
}

async function saveState(dir: string, state: LocalBoardState): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`)
}

const newerThan = async (file: string, since: string | null): Promise<boolean> => {
  const at = await modifiedAt(file)
  return at !== undefined && (since === null || Date.parse(at) >= Date.parse(since) - 1000)
}

const resolveAction = (ref: string, boardUrl: string, repo: string, folder: string | null): BoardAction => ({
  action: 'resolve',
  ticket: ref,
  board: boardUrl,
  write: folder === null ? `${join(repo, WORK_DIR)}/<id in lower case>-<title as a slug>/${TICKET_FILE}` : join(folder, TICKET_FILE),
  folder: folder ?? `${join(repo, WORK_DIR)}/<id in lower case>-<title as a slug>`,
  format: ticketMdFormat(),
  note: `Resolve the ticket on the Feature Board with the Notion MCP (notion-fetch, read-only): by its ID property for an ID, by the page for a URL. Write ticket.md at "write" in exactly the "format" layout, with every property as the board shows it, the child pages with their last-edited times, and the Idea as plain markdown. The folder is .work/<id>-<slug>: the ID in lower case, then the title in lower case with runs of other characters as single dashes (nom-4-explore-pagination).`,
})

/** The ready result of the local board stage: the driver may go on to `knowledge`. */
export type LocalBoardReady = { ticket: TicketRecord; folder: string; statusBefore: string; trace: BoardTrace }

/**
 * One step of the local board work. Returns the `board` stage to print while the session still has
 * actions to perform, or the ticket once ticket.md shows the expected Status and every pull is in.
 * Throws FlowRefused, before any model stage, when the gate refuses or a local file is newer than its page.
 */
export async function localBoardStep(options: LocalBoardOptions): Promise<{ stage: BoardStage } | { ready: LocalBoardReady }> {
  if (options.argument.kind === 'path') throw new Error('localBoardStep needs a ticket; --no-ticket runs make no board actions')
  const env = options.env ?? process.env
  const dev = options.dev ?? env[DEV_ENV] ?? DEFAULT_DEV
  const ref = options.argument.ref
  const known = options.argument.folder ?? null
  let state = await readState(options.stateDir)
  if (state === null || state.ref !== ref || state.skill !== options.skill) {
    const existing = known === null ? null : await readTicketMd(known)
    state = { skill: options.skill, ref, phase: 'resolve', folder: known, askedAt: null, syncAskedAt: null, previous: previousPagesOf(existing), statusBefore: null, trace: null }
  }
  const stageOf = (folder: string | null, actions: BoardAction[], status: string | null, note: string): BoardStage => ({
    pending: true,
    status: 'pending',
    stage: 'board',
    ticket: ref,
    folder,
    actions,
    verify: { file: folder === null ? `<folder>/${TICKET_FILE}` : join(folder, TICKET_FILE), status },
    note,
  })

  if (state.phase === 'resolve') {
    // Resolved when the session has written ticket.md since the resolve was asked for.
    const folder = state.folder ?? (await findWorkFolders(options.repo)).find((candidate) => sameRef(candidate, ref))?.folder ?? null
    const ticket = folder === null ? null : await readTicketMd(folder)
    if (state.askedAt === null || folder === null || ticket === null || !(await newerThan(join(folder, TICKET_FILE), state.askedAt))) {
      if (state.askedAt === null) {
        state.askedAt = new Date().toISOString()
        if (state.folder === null && folder !== null) {
          state.folder = folder
          state.previous = previousPagesOf(ticket)
        }
        await saveState(options.stateDir, state)
      }
      return { stage: stageOf(state.folder, [resolveAction(ref, options.board, options.repo, state.folder)], null, 'Perform each action with the Notion MCP, then call local again. The driver reads ticket.md and refuses when it does not show what the gate needs.') }
    }
    state.folder = folder
    const gate = checkGate(options.skill, ticket)
    if (!gate.ok) throw new FlowRefused(gate.message)
    state.phase = 'sync'
    state.statusBefore = ticket.status
    state.trace = { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [entry('resolve', `${ticket.id} resolved from ${ref} by the session`, ticket.status, ticket.status)] }
    await writeInto(join(folder, IDEA_FILE), ticket.idea)
    await saveState(options.stateDir, state)
  }

  const folder = state.folder!
  const ticket = await readTicketMd(folder)
  if (ticket === null) throw new FlowRefused(`${join(folder, TICKET_FILE)} is missing or not a ticket file; delete ${options.stateDir} and start over`)
  const gate = checkGate(options.skill, ticket)
  if (!gate.ok) throw new FlowRefused(gate.message)
  const plan = await pullPlan(ticket, folder, state.previous, options.force === true)
  // A file the session wrote since the sync was asked for is the pull, not a local edit.
  const pending: typeof plan = []
  for (const item of plan) if (item.decision === 'keep' || state.syncAskedAt === null || !(await newerThan(item.file, state.syncAskedAt))) pending.push(item)
  const conflict = conflictMessage(pending)
  if (conflict !== null) throw new FlowRefused(conflict)
  const actions: BoardAction[] = []
  for (const item of pending) {
    if (item.decision !== 'write') continue
    actions.push({ action: 'pull', title: item.title, page: item.page, file: item.file, reason: item.reason, note: 'Fetch the child page with the Notion MCP and write its content as plain markdown (no Notion escapes; tables as pipe tables; callouts as block quotes).' })
  }
  const expected = GATES[options.skill].inProgress ?? null
  if (gate.startMove !== null) {
    actions.push({ action: 'set', page: ticket.url, name: 'Dev', value: dev, then: `set Dev to "${dev}" in ${join(folder, TICKET_FILE)}` })
    actions.push({ action: 'move', page: ticket.url, from: gate.startMove.from, to: gate.startMove.to, then: `set Status to "${gate.startMove.to}" in ${join(folder, TICKET_FILE)}` })
  }
  if (actions.length > 0) {
    if (state.syncAskedAt === null) {
      state.syncAskedAt = new Date().toISOString()
      await saveState(options.stateDir, state)
    }
    return { stage: stageOf(folder, actions, expected ?? ticket.status, 'Perform each action with the Notion MCP (notion-fetch for a pull, notion-update-page for a move or a property), update ticket.md as each "then" says, then call local again.') }
  }
  const trace = state.trace!
  if (state.phase === 'sync') {
    for (const item of plan) if (!pending.includes(item)) trace.actions.push(entry('pull', `${item.title} -> ${item.file} (${item.reason}) by the session`, state.statusBefore ?? ticket.status, state.statusBefore ?? ticket.status))
    if (state.statusBefore !== null && ticket.status !== state.statusBefore) {
      trace.actions.push(entry('set', `Dev = ${ticket.dev ?? dev} by the session`, state.statusBefore, state.statusBefore))
      trace.actions.push(entry('move', `${state.statusBefore} -> ${ticket.status} by the session`, state.statusBefore, ticket.status))
    }
    trace.statusAfter = ticket.status
    state.phase = 'ready'
    state.previous = previousPagesOf(ticket)
    state.trace = trace
    await saveState(options.stateDir, state)
  }
  return { ready: { ticket, folder, statusBefore: state.statusBefore ?? ticket.status, trace } }
}

function sameRef(folder: WorkFolder, ref: string): boolean {
  const lower = ref.trim().toLowerCase()
  if (folder.id.toLowerCase() === lower) return true
  const own = folder.url.replace(/-/g, '').toLowerCase()
  const wanted = lower.replace(/-/g, '')
  const hex = wanted.match(/([0-9a-f]{32})(?:\?.*)?$/)?.[1]
  return hex !== undefined && own.includes(hex)
}

/** The end of a local run (F8): the pushes and the success or failure move as actions, and the trace written into the export with the Status the verify step expects. */
export async function localBoardEnd(options: { skill: Skill; folder: string; ok: boolean; runStatus: string; exportDir: string; stateDir: string; verifyCommand: string }): Promise<{ stage: 'board-end'; actions: BoardAction[]; verify: { command: string; file: string; status: string } | null; traceFile: string; remaining: string | null }> {
  const state = await readState(options.stateDir)
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing`)
  const trace: BoardTrace = state?.trace ?? { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder: options.folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  const actions: BoardAction[] = []
  if (options.ok) {
    for (const push of pushesFor(options.skill, options.runStatus)) {
      const file = join(options.folder, push.file)
      if (!existsSync(file)) continue
      actions.push({ action: 'push', page: ticket.url, title: push.title, file, then: `add or update the "${push.title}" row of the Pages table in ${join(options.folder, TICKET_FILE)} with the page URL and its last-edited time` })
    }
  }
  const move = endMove(options.skill, options.ok, ticket.status, false)
  if (move !== null) actions.push({ action: 'move', page: ticket.url, from: move.from, to: move.to, then: `set Status to "${move.to}" in ${join(options.folder, TICKET_FILE)}` })
  const expected = move?.to ?? ticket.status
  trace.expected = expected
  trace.pushing = actions.filter((action) => action.action === 'push').map((action) => (action as { title: string }).title)
  // Nothing for the session to do: the trace is complete as it stands.
  trace.verified = actions.length === 0
  const traceFile = await writeBoardTrace(options.exportDir, trace)
  return { stage: 'board-end', actions, verify: actions.length === 0 ? null : { command: options.verifyCommand, file: join(options.folder, TICKET_FILE), status: expected }, traceFile, remaining: remainingStep(options.skill, options.ok, expected, false) }
}

/** The last local step: ticket.md must show the expected Status; the pushed pages are read from its Pages table; the trace is completed. */
export async function localBoardVerify(options: { skill: Skill; folder: string; exportDir: string }): Promise<{ ok: boolean; header: string[]; trace: BoardTrace; traceFile: string; problem: string | null }> {
  const found = await readBoardTrace(options.exportDir)
  if (found === null) throw new Error(`No board trace under ${options.exportDir}; run the export step first`)
  const { trace } = found
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing`)
  const expected = trace.expected ?? trace.statusAfter ?? ticket.status
  const before = trace.statusAfter ?? ticket.status
  let problem: string | null = null
  if (ticket.status !== expected) problem = `${join(options.folder, TICKET_FILE)} shows "${ticket.status}", expected "${expected}". Make the move with the Notion MCP, update ticket.md, and run the verify step again.`
  else if (before !== expected) trace.actions.push(entry('move', `${before} -> ${expected} by the session`, before, expected))
  for (const title of trace.pushing ?? []) {
    const page = ticket.pages[title]
    if (page === undefined) {
      problem ??= `${join(options.folder, TICKET_FILE)} has no "${title}" row in its Pages table; push the page with the Notion MCP, add the row, and run the verify step again.`
      continue
    }
    if (trace.pushed.some((pushed) => pushed.title === title)) continue
    trace.pushed.push({ title, url: page.url })
    trace.actions.push(entry('push', `${title} -> ${page.url} by the session`, expected, expected))
  }
  trace.statusAfter = ticket.status
  trace.verified = problem === null
  const traceFile = await writeBoardTrace(options.exportDir, trace)
  return { ok: problem === null, header: reportHeader(trace), trace, traceFile, problem }
}

/** The ticket's input file for a skill, checked to exist, with a message naming the page that is missing. */
export function inputFileFor(skill: Skill, folder: string): string {
  const input = GATES[skill].input
  if (input === undefined) throw new Error(`${skill} takes no input file`)
  const candidates = Array.isArray(input) ? input : [input]
  for (const candidate of candidates) {
    const file = resolve(folder, candidate)
    if (existsSync(file)) return file
  }
  const last = candidates.at(-1)!
  const file = resolve(folder, last)
  const page = TICKET_PAGES.find((candidate) => candidate.file === last)
  throw new FlowRefused(page === undefined ? `${file} is missing` : `${file} is missing: the ticket has no "${page.title}" page yet. ${whoProduces(page.title)}`)
}

function whoProduces(title: string): string {
  const by: Record<string, string> = { Spec: 'The spec writer puts it there.', 'Spec Reviewed': 'The spec reviewer puts it there.', Plan: 'The planner puts it there.', Implementation: 'The implementor puts it there.' }
  return by[title] ?? ''
}

export { BoardError }
