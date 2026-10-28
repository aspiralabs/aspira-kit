// The ticket flow on a file system and a board: the working folder under .work/, the pull into it,
// the gate, the moves and the pushes. Two paths share it. The separate-process path (`startFlow`
// and `finishFlow`) performs every board action itself through board.ts with NOTION_TOKEN. The
// --local path (`localBoardStep`, `localBoardEnd`, `localBoardVerify`) lists the same actions as
// data for the Claude Code session to perform with the Notion MCP, and verifies ticket.md between
// steps. Both record every action, with the Status before and after, in the run's trace.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { readEffectiveAspira } from './aspira-config.ts'
import { BoardError, board as makeBoard, type Board, type BoardWithPageMarkdown, type Ticket, type TicketPage } from './board.ts'
import {
  GROOM_LINE_PATTERNS,
  RECOMMENDED_SUFFIX,
  applyAnswersById,
  classifyRenderings,
  groomPageState,
  normalizeQuestion,
  parseGroomPage,
  readGroomPage,
  renderGroomPage,
  reviseAnswers,
  type Answer,
  type GroomCarried,
  type GroomTicks,
} from './decisions.ts'
import { GROOM_BRANCHES, readGroomRecord, rebuildGroomRecord, validateIdeaSummary, writeGroomRecord, type GroomRecord } from './groom-record.ts'
import { pageIdFrom } from './knowledge.ts'
import { PLAN_BLOCK_FILES, recoverPlan } from './plan-block.ts'
import type { ReasonCode } from './run-status.ts'
import { listsTelemetry, readAttached, recordAttached, telemetryFile, telemetryNotice } from './telemetry.ts'
import {
  DEFAULT_DEV,
  DEV_ENV,
  GATES,
  IDEA_FILE,
  TICKET_FILE,
  TICKET_PAGES,
  workDirFor,
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
  type BoardTraceTelemetry,
  type Gate,
  type RunStatus,
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

/** The statusFlow/pullRequest keys of the aspira.json that applies to `from` (KIT-68); both true when none says otherwise. */
function statusFlowOf(from: string): { statusFlow: boolean; pullRequest: boolean } {
  const { statusFlow, pullRequest } = readEffectiveAspira(from).config
  return { statusFlow, pullRequest }
}

/** aspira.json, or null when the project has no board. Throws when the file is not what kit init writes. */
export async function readAspira(repo: string): Promise<AspiraConfig | null> {
  const { file, config } = readEffectiveAspira(repo)
  if (file === undefined) return null
  const parsed = config as Partial<AspiraConfig>
  if (typeof parsed.board !== 'string' || parsed.board === '') throw new FlowRefused(`${file} has no "board"; run kit init --board <Feature Board URL>`)
  return { board: parsed.board, ...(typeof parsed.releases === 'string' ? { releases: parsed.releases } : {}) }
}

/** Every folder under .work/ that holds a ticket.md, with the ticket it names. */
export async function findWorkFolders(repo: string): Promise<WorkFolder[]> {
  const dir = workDirFor(repo)
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

/** The content hash of each file a pull last wrote, by file name, in the working folder (KIT-72). */
export const PULLED_FILE = '.pulled.json'
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')
const contentHash = async (file: string): Promise<string | null> => readFile(file, 'utf8').then(hashOf, () => null)
const pulledHashes = async (folder: string): Promise<Record<string, string>> => {
  const parsed = z.record(z.string(), z.string()).safeParse(await readFile(join(folder, PULLED_FILE), 'utf8').then((text) => JSON.parse(text) as unknown, () => null))
  return parsed.success ? parsed.data : {}
}

/** Record what the pull just wrote into these files, so a later pull can tell a rewrite with the same content from a local edit. */
export async function recordPulled(folder: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return
  const hashes = await pulledHashes(folder)
  for (const file of files) {
    const hash = await contentHash(file)
    if (hash !== null) hashes[relative(folder, file)] = hash
  }
  await writeFile(join(folder, PULLED_FILE), `${JSON.stringify(hashes, null, 2)}\n`)
}

type PullItem = { title: string; file: string; page: string; decision: 'write' | 'keep' | 'conflict'; reason: string; note?: string }

/** How the --local session copies a page the gate row pulls over the local file: the page parser reads column 0 only. */
const OVERWRITE_PULL_NOTE =
  'Fetch the child page with the Notion MCP and write it as plain markdown: copy every heading\'s text verbatim, write every to-do block as a column-0 "- [ ]" or "- [x]" line, and every other block as its own paragraph (no Notion escapes). This copy is replaced on every run; never edit it to answer a question.'

/** The pull plan for a ticket against its folder: each page the ticket has, mapped to its file, with the decision (F5). The gate row's own pulls are always written. */
export async function pullPlan(skill: Skill, ticket: TicketRecord, folder: string, previous: Record<string, string>, force: boolean): Promise<PullItem[]> {
  const items: PullItem[] = []
  const pages: { title: string; file: string; overwrite?: true; note?: string }[] = [...TICKET_PAGES, ...(GATES[skill].pulls ?? [])]
  const hashes = await pulledHashes(folder)
  for (const { title, file, overwrite, note } of pages) {
    const page = ticket.pages[title]
    if (page === undefined) continue
    const path = join(folder, file)
    const exists = existsSync(path)
    const recordedAt = previous[title]
    const unchanged = exists && hashes[file] !== undefined && hashes[file] === (await contentHash(path))
    const decision = pullDecision({ exists, localModifiedAt: await modifiedAt(path), recordedAt, pageEditedAt: page.lastEditedAt, force, overwrite, unchanged })
    const reason =
      overwrite === true ? 'pulled over the local copy on every run' : !exists ? 'not in the working folder' : decision === 'keep' ? 'unchanged since the last pull' : unchanged ? 'edited on the ticket; the local copy holds only the last pull' : recordedAt === undefined ? 'no pull recorded' : `edited on the ticket after the last pull (${recordedAt})`
    items.push({ title, file: path, page: page.url, decision, reason, ...(overwrite === true ? { note: note ?? OVERWRITE_PULL_NOTE } : {}) })
  }
  return items
}

/** The refusal for a pull with conflicts: which files, and the flag. */
export function conflictMessage(items: PullItem[]): string | null {
  const conflicts = items.filter((item) => item.decision === 'conflict')
  if (conflicts.length === 0) return null
  return `Not overwriting ${conflicts.length === 1 ? 'a local file' : 'local files'} newer than ${conflicts.length === 1 ? 'its page' : 'their pages'}: ${conflicts.map((item) => `${item.file} (${item.title})`).join(', ')}. Pass --force-pull to replace ${conflicts.length === 1 ? 'it' : 'them'} with the ticket's version.`
}

const entry = (action: BoardTraceEntry['action'], detail: string, before: string, after: string, ok = true, error?: string): BoardTraceEntry => ({ at: new Date().toISOString(), action, detail, statusBefore: before, statusAfter: after, ok, ...(error === undefined ? {} : { error }) })

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
  ...(ticket.duplicatePages === undefined ? {} : { duplicatePages: ticket.duplicatePages }),
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
  /** The groomer: clear another run's `Run:` marker on Grooming Decisions instead of refusing (`--force-run`). Ignored by every other row. */
  forceRun?: boolean
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
  const gate = checkGate(options.skill, ticket, statusFlowOf(options.repo))
  if (!gate.ok) throw new FlowRefused(gate.message)
  const folder = options.argument.folder ?? join(workDirFor(options.repo), workFolderName(ticket))
  const previous = previousPagesOf(await readTicketMd(folder))
  const now = new Date().toISOString()
  const current = record(ticket, now)
  const plan = await pullPlan(options.skill, current, folder, previous, options.force === true)
  const conflict = conflictMessage(plan)
  if (conflict !== null) throw new FlowRefused(conflict)

  const trace: BoardTrace = { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  trace.actions.push(entry('resolve', `${ticket.id} resolved from ${options.argument.ref}`, ticket.status, ticket.status))
  await mkdir(folder, { recursive: true })
  await writeInto(join(folder, IDEA_FILE), ticket.idea)
  const pulled: string[] = []
  const kept: string[] = []
  const pulledPages: Record<string, TicketPage & { markdown: string }> = {}
  for (const item of plan) {
    if (item.decision === 'keep') { kept.push(item.file); continue }
    const page = await client.pullPage(ticket, item.title)
    if (page === undefined) continue
    pulledPages[item.title] = page
    await writeInto(item.file, page.markdown)
    pulled.push(item.file)
    trace.actions.push(entry('pull', `${item.title} -> ${item.file} (${item.reason})`, ticket.status, ticket.status))
    // A fresh machine's implementor pull has the pushed Plan page but not the planner's own
    // trace/plan.json and trace/review.json (never pushed to git): rebuild them from the page's
    // fenced block (F36) instead of asking the session to retype the plan. `pageMarkdown` (raw, no
    // notionToMarkdown conversion) is preferred so the block's hashes still verify; a client without
    // it (an older mock) falls back to the already-pulled, converted copy.
    if (options.skill === 'implementor' && item.title === 'Plan' && !existsSync(join(folder, PLAN_BLOCK_FILES[0]))) {
      const raw = 'pageMarkdown' in client ? await (client as BoardWithPageMarkdown).pageMarkdown(page.id) : { markdown: page.markdown, truncated: false }
      const recovered = await recoverPlan({ pageMarkdown: raw.markdown, truncated: raw.truncated, folder, pageUrl: page.url })
      trace.actions.push(
        recovered.recovered
          ? entry('pull', `Plan block -> ${recovered.files.join(', ')} (recovered from the Plan page)`, ticket.status, ticket.status)
          : entry('pull', `Plan block not recovered: ${recovered.reason}`, ticket.status, ticket.status, false, recovered.reason),
      )
    }
  }
  const row = GATES[options.skill]
  const groomPull = row.pulls?.[0]
  if (groomPull !== undefined && row.record !== undefined) {
    const page = await markGroomPage({ client, ticket, folder, title: groomPull.title, page: pulledPages[groomPull.title], forceRun: options.forceRun === true, trace })
    current.pages = { ...current.pages, [groomPull.title]: page }
  }
  if (gate.startMove !== null) {
    try {
      if (row.setsDev !== false) {
        await client.setProperty(ticket, 'Dev', dev)
        trace.actions.push(entry('set', `Dev = ${dev}`, ticket.status, ticket.status))
      }
      const moved = await client.moveTicket(ticket, gate.startMove.from, gate.startMove.to)
      trace.actions.push(entry('move', `${moved.before} -> ${moved.after}`, moved.before, moved.after))
      current.status = moved.after
      if (row.setsDev !== false) current.dev = dev
      trace.statusAfter = moved.after
    } catch (error) {
      trace.actions.push(entry('move', `${gate.startMove.from} -> ${gate.startMove.to}`, ticket.status, ticket.status, false, message(error)))
      throw error
    }
  }
  await recordPulled(folder, pulled)
  await writeInto(join(folder, TICKET_FILE), renderTicketMd(current))
  return { ticket: current, folder, trace, pulled, kept }
}

// ---------------------------------------------------------------------------------------------
// The groomer's Grooming Decisions page: the run marker, the final re-read and the record.
// ---------------------------------------------------------------------------------------------

/** The Idea summary the groomer's agent composes on a confirm, relative to the working folder. */
export const GROOM_IDEA_SUMMARY_FILE = 'groom/idea-summary.md'

/** The paragraph a run keeps on Grooming Decisions while it writes: `Run: <startedAt> <mode> in progress`. */
export const runMarkerText = (startedAt: string, mode: 'agent' | 'local'): string => `Run: ${startedAt} ${mode} in progress`

/** Every `Run:` marker paragraph a page carries, at column 0, with its start time. */
function runMarkers(markdown: string): { line: string; startedAt: string }[] {
  return markdown.split('\n').flatMap((line) => {
    const match = GROOM_LINE_PATTERNS.run.test(line) ? /^Run: (\S+) /.exec(line) : null
    return match === null ? [] : [{ line, startedAt: match[1]! }]
  })
}

const today = () => new Date().toISOString().slice(0, 10)

/** The record of a card no run has groomed yet: every branch open, round zero. */
const emptyGroomRecord = (startedAt: string): GroomRecord => ({ decisions: [], branches: GROOM_BRANCHES.map((id) => ({ id, state: 'open' as const })), round: 0, startedAt, open: 0, page: {}, status: 'incomplete', reasonCode: null, reason: null })

/** The first blocks of every rendering, the title and the intro, exactly as the renderer writes them: what a first run's new page holds before its marker. */
function groomPageHead(): string {
  return `${renderGroomPage(emptyGroomRecord(''), { date: today(), notes: [] }).split('\n\n').slice(0, 2).join('\n\n')}\n`
}

/** The record a start continues: the local one, or the one the page holds, or a new one. */
function startingRecord(local: GroomRecord | undefined, page: string | undefined, startedAt: string): GroomRecord {
  if (local !== undefined) return local
  if (page === undefined) return emptyGroomRecord(startedAt)
  try {
    return rebuildGroomRecord(page).record
  } catch {
    return emptyGroomRecord(startedAt)
  }
}

/**
 * One run per card at a time (F14): create Grooming Decisions on a first run, refuse while another
 * run's marker is on it (unless forced), clear this machine's own stale marker, append this run's
 * marker, and record the page and the marker in groom/trace/groom.json. Runs before the start move.
 */
async function markGroomPage(args: { client: Board; ticket: Ticket; folder: string; title: string; page: (TicketPage & { markdown: string }) | undefined; forceRun: boolean; trace: BoardTrace }): Promise<TicketPage> {
  const { client, ticket, title, trace } = args
  const local = await readGroomRecord(args.folder).catch(() => undefined)
  const startedAt = new Date().toISOString()
  const marker = runMarkerText(startedAt, 'agent')
  const status = ticket.status
  let page: TicketPage
  if (args.page === undefined) {
    const created = await client.createPage(ticket, title, groomPageHead())
    page = { id: created.id, title, url: created.url, lastEditedAt: startedAt }
    trace.actions.push(entry('push', `${title} created with its title and intro (${created.url})`, status, status))
  } else {
    page = { id: args.page.id, title, url: args.page.url, lastEditedAt: args.page.lastEditedAt }
    const stale = runMarkers(args.page.markdown)
    const foreign = stale.find((found) => found.startedAt !== local?.startedAt)
    if (foreign !== undefined && !args.forceRun) throw new FlowRefused(`a groomer run started at ${foreign.startedAt} is in progress on ${ticket.id}; wait or rerun with --force-run`)
    if (stale.length > 0) await clearStaleMarkers({ client, ticket, title, markdown: args.page.markdown, ownBlockId: foreign === undefined ? local?.markerBlockId : undefined, trace })
  }
  const appended = await client.appendParagraph(page.id, marker)
  trace.actions.push(entry('mark', `${marker} -> ${title}`, status, status))
  const base = startingRecord(local, args.page?.markdown, startedAt)
  await writeGroomRecord(args.folder, { ...base, startedAt, page: { id: page.id, url: page.url }, markerBlockId: appended.id })
  return page
}

/**
 * Removes the `Run:` markers a start may clear. Its own marker goes by the block id the record kept;
 * a marker whose block id is unknown (another run's, under --force-run) can only go by rewriting the
 * page without it, append-first, which re-creates every block under the integration's identity.
 */
async function clearStaleMarkers(args: { client: Board; ticket: Ticket; title: string; markdown: string; ownBlockId: string | undefined; trace: BoardTrace }): Promise<void> {
  const { client, ticket, title, trace } = args
  const status = ticket.status
  if (args.ownBlockId !== undefined) {
    try {
      await client.deleteBlock(args.ownBlockId)
      trace.actions.push(entry('unmark', `this machine's earlier Run marker ${args.ownBlockId} deleted from ${title}`, status, status))
      return
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
    }
  }
  const without = args.markdown.split('\n').filter((line) => runMarkers(line).length === 0).join('\n')
  await client.replacePage(ticket, title, without)
  trace.actions.push(entry('unmark', `${title} rewritten without its stale Run marker`, status, status))
}

/** The global position of each to-do line of a page's markdown, by its line index. */
function toDoOrdinals(markdown: string): Map<number, number> {
  const ordinals = new Map<number, number>()
  for (const [at, line] of markdown.split('\n').entries()) if (GROOM_LINE_PATTERNS.todo.test(line)) ordinals.set(at, ordinals.size)
  return ordinals
}

/** The line where the kept rendering starts within the page (classifyRenderings splits on the title line). */
function keptOffset(markdown: string, kept: string): number {
  const lines = markdown.split('\n')
  const starts = lines.flatMap((line, at) => (at === 0 || GROOM_LINE_PATTERNS.title.test(line) ? [at] : []))
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? lines.length
    if (lines.slice(start, end).join('\n') === kept) return start
  }
  return 0
}

/** Does the CONFIRM block of a rendering carry the groomer's own `Confirmed <date>` line (a Confirm it rendered ticked)? */
function confirmedLine(markdown: string, pattern: RegExp): boolean {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^## CONFIRM — /.test(line))
  if (start === -1) return false
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line) || GROOM_LINE_PATTERNS.trailer.test(line)) return false
    if (pattern.test(line)) return true
  }
  return false
}

type TickEvent = { id: string; index: number; at: number }

/**
 * Merges the ticks of the kept rendering into the record (Source of answers, F17): only a tick
 * event (a box the page's own lines record unticked, now checked) is attributed, through the to-do
 * listing and the integration's own id, failing closed. Returns the record and whether Confirm counts.
 */
async function mergeGroomTicks(args: { client: Board; pageId: string; markdown: string; kept: string; record: GroomRecord; at: (detail: string) => void; notices: string[] }): Promise<{ record: GroomRecord; confirmTicked: boolean; confirmUnticked: boolean; carried: GroomCarried[] }> {
  const { kept, at } = args
  const parse = parseGroomPage(kept, args.record.decisions.map((decision) => decision.id))
  const read = readGroomPage(kept)
  for (const line of parse.unread) {
    args.notices.push(line)
    at(line)
  }
  const strip = (text: string) => text.replace(RECOMMENDED_SUFFIX, '').trim()
  const events: TickEvent[] = []
  for (const block of read.questions) {
    const ticks = parse.ticks.find((entry) => entry.id === block.id)
    if (ticks === undefined) continue
    const recorded = block.decided === undefined ? -1 : block.todos.findIndex((todo) => normalizeQuestion(strip(todo.text)) === normalizeQuestion(block.decided!.answer))
    for (const index of ticks.indexes) if (index !== recorded) events.push({ id: block.id, index, at: block.todos[index]!.at })
  }
  const confirmBox = read.confirm?.[0]
  const ownConfirm = confirmedLine(kept, GROOM_LINE_PATTERNS.confirmed)
  if (confirmBox?.checked === true && !ownConfirm) events.push({ id: 'CONFIRM', index: 0, at: confirmBox.at })

  const accepted = new Map<string, { indexes: number[]; by: string }>()
  if (events.length > 0) {
    const todos = await args.client.listToDos(args.pageId)
    const me = (await args.client.me()).id
    const ordinals = toDoOrdinals(args.markdown)
    const offset = keptOffset(args.markdown, kept)
    const complete = todos.length === ordinals.size
    for (const event of events) {
      const ordinal = ordinals.get(offset + event.at)
      const todo = complete && ordinal !== undefined ? todos[ordinal] : undefined
      const by = todo?.checked === true ? todo.lastEditedBy?.id : undefined
      if (by === undefined) at(`tick on ${event.id} not attributable; left open`)
      else if (by === me) at(`${event.id} ticked by the integration; left open`)
      else {
        at(`${event.id} ticked by ${by}`)
        const entry = accepted.get(event.id) ?? { indexes: [], by }
        entry.indexes.push(event.index)
        accepted.set(event.id, entry)
      }
    }
  }

  const answers: Answer[] = []
  const twoTicks: string[] = []
  const revisions: GroomTicks[] = []
  for (const decision of args.record.decisions) {
    const ticked = accepted.get(decision.id)
    if (ticked === undefined) continue
    if (decision.decidedBy === 'open') {
      if (ticked.indexes.length > 1) twoTicks.push(decision.id)
      else {
        const block = read.questions.find((entry) => entry.id === decision.id)
        const index = ticked.indexes[0]!
        answers.push({ id: decision.id, question: decision.question, answer: decision.options[index] ?? strip(block?.todos[index]?.text ?? '') })
      }
    } else revisions.push({ id: decision.id, indexes: ticked.indexes })
  }
  const merged = reviseAnswers(applyAnswersById(args.record.decisions, answers, twoTicks), revisions, today()).map((decision) => {
    const ticked = accepted.get(decision.id)
    const before = args.record.decisions.find((entry) => entry.id === decision.id)
    const changed = before?.decidedBy !== decision.decidedBy || before?.answer !== decision.answer
    return ticked !== undefined && changed && decision.decidedBy === 'author' ? { ...decision, tickedBy: { kind: 'notion' as const, id: ticked.by } } : decision
  })
  const confirmTicked = confirmBox?.checked === true && (ownConfirm || accepted.has('CONFIRM'))
  const confirmUnticked = confirmBox?.checked === false && (ownConfirm || confirmedLine(kept, GROOM_LINE_PATTERNS.confirmUnticked))
  return { record: { ...args.record, decisions: merged }, confirmTicked, confirmUnticked, carried: parse.carried }
}

const openCount = (record: GroomRecord): number => record.decisions.filter((decision) => decision.decidedBy === 'open').length

/** What the groomer's finish step leaves for the CLI and the remaining step: the recorded word, the page and the open questions. */
export type GroomFinish = { open: number; url?: string }

/**
 * The groomer's finish (F13, F15, F17, F19, F20, F37): delete this run's marker on every exit; on
 * success re-read the page, merge its ticks, render and replace it append-first; on a confirm write
 * the Idea summary; check the page again; re-read the Status and make the Shortlist move. The
 * recorded word is written into groom/trace/groom.json here and nowhere else.
 */
async function finishGroom(options: FinishOptions, client: Board, ticket: TicketRecord, trace: BoardTrace): Promise<FlowFinish> {
  const gate: Gate = GATES[options.skill]
  const title = gate.pulls?.[0]?.title ?? gate.pushes[0]?.title ?? ''
  const decisionsFile = join(options.folder, gate.pulls?.[0]?.file ?? gate.pushes[0]?.file ?? '')
  const pushFailures: string[] = []
  const notices: string[] = []
  let status = ticket.status
  const at = (action: BoardTraceEntry['action'], detail: string, ok = true, error?: string) => trace.actions.push(entry(action, detail, status, status, ok, error))
  const check = (detail: string) => at('check', detail)
  const fail = (detail: string) => {
    notices.push(detail)
    at('check', detail, false, detail)
  }

  let record = await readGroomRecord(options.folder).catch((error: unknown) => {
    fail(`${gate.record?.file ?? 'groom.json'} could not be read: ${message(error)}`)
    return undefined
  })
  // (a) This run's marker goes on every exit, before anything else.
  if (record?.markerBlockId !== undefined) {
    const { markerBlockId, ...rest } = record
    try {
      await client.deleteBlock(markerBlockId)
      at('unmark', `Run marker ${markerBlockId} deleted from ${title}`)
      record = rest
    } catch (error) {
      at('unmark', `Run marker ${markerBlockId} on ${title}`, false, message(error))
      notices.push(`the Run marker on ${title} could not be deleted (${message(error)}); the next run needs --force-run`)
    }
  }

  let final: RunStatus = options.runStatus
  let reported: string | undefined
  let url = record?.page.url
  const boardWorthy = final === 'ready' || final === 'needs-author'
  if (record === undefined) {
    if (boardWorthy) fail(`${join(options.folder, gate.record?.file ?? '')} is missing; the run left no record`)
    final = 'incomplete'
  } else if (boardWorthy) {
    const outcome = await groomBoardStep()
    record = outcome
  }

  async function groomBoardStep(): Promise<GroomRecord> {
    let working = record!
    const incomplete = (detail: string) => {
      fail(detail)
      final = 'incomplete'
      return working
    }
    // (b) The final re-read: the page is pulled again and its ticks merged before rendering.
    let pulled: (TicketPage & { markdown: string }) | undefined
    try {
      pulled = await client.pullPage(ticket.url, title)
    } catch (error) {
      return incomplete(`${title} could not be read: ${message(error)}`)
    }
    if (pulled === undefined) return incomplete(`${ticket.id} has no "${title}" page; rerun groomer to create it`)
    const own = runMarkerText(working.startedAt, 'agent')
    if (runMarkers(pulled.markdown).some((found) => found.line !== own)) return incomplete('another run wrote Grooming Decisions during this run')
    const classified = classifyRenderings(pulled.markdown)
    let confirmTicked = false
    let confirmUnticked = false
    let carried: (GroomCarried | string)[] = []
    if (classified.round === null) {
      check(`repaired from local round ${working.round}`)
      carried = readGroomPage(pulled.markdown).carried
    } else {
      if (working.round > classified.round) {
        const rebuilt = rebuildGroomRecord(classified.kept).record
        working = { ...working, decisions: rebuilt.decisions, branches: rebuilt.branches, round: rebuilt.round }
        check(`local round ${record!.round} discarded, page is at round ${classified.round}`)
      } else {
        // This run's rendering is the page's next round: the agent works at the page's round and the
        // finish, the one writer of the page, numbers what it writes (a discarded record only repairs).
        working = { ...working, round: classified.round + 1 }
      }
      if (classified.deleted.length > 0) check(`${classified.deleted.length} line(s) of an incomplete or older rendering replaced`)
      try {
        const merged = await mergeGroomTicks({ client, pageId: pulled.id, markdown: pulled.markdown, kept: classified.kept, record: working, at: check, notices })
        working = merged.record
        confirmTicked = merged.confirmTicked
        confirmUnticked = merged.confirmUnticked
        const keptTexts = new Set(merged.carried.map((note) => note.text))
        carried = [...merged.carried, ...classified.carried.filter((text) => !keptTexts.has(text))]
      } catch (error) {
        return incomplete(`${title} could not be read: ${message(error)}`)
      }
    }
    const open = openCount(working)
    if (confirmTicked && open > 0) {
      const sentence = `Confirm was ticked but ${open} question(s) are open; it is re-offered when they are answered`
      notices.push(sentence)
      check(sentence)
    }
    if (final === 'ready' && (open > 0 || !confirmTicked)) {
      reported = 'ready'
      final = 'needs-author'
      check(`confirmed reported, ${open} open on Grooming Decisions; recorded needs-author`)
    }
    working = { ...working, status: final, open }
    const markdown = renderGroomPage(working, { date: today(), notes: carried, ...(confirmUnticked && open === 0 && final !== 'ready' ? { confirmUnticked: true } : {}) })
    await writeInto(decisionsFile, markdown)
    try {
      const replaced = await client.replacePage(ticket.url, title, markdown)
      trace.pushed.push({ title, url: replaced.url })
      ticket.pages[title] = { id: replaced.id, title, url: replaced.url, lastEditedAt: replaced.lastEditedAt }
      url = replaced.url
      working = { ...working, page: { id: replaced.id, url: replaced.url } }
      at('replace', `${title} from ${decisionsFile} (append-first)`)
    } catch (error) {
      pushFailures.push(`${title}: ${message(error)}; the output is at ${decisionsFile}`)
      at('replace', `${title} from ${decisionsFile}`, false, message(error))
      final = 'incomplete'
      return working
    }
    // (c) The Idea summary, checked against the record before anything is written to the card.
    if (final === 'ready') {
      const summaryFile = join(options.folder, GROOM_IDEA_SUMMARY_FILE)
      const summary = await readFile(summaryFile, 'utf8').catch(() => null)
      const valid = summary === null ? { ok: false as const, reason: `${summaryFile} is missing` } : validateIdeaSummary(summary, working)
      if (!valid.ok || summary === null) return incomplete(`idea summary does not match groom.json: ${valid.ok ? `${summaryFile} is missing` : valid.reason}`)
      try {
        const written = await client.writeIdeaSummary(ticket.url, summary)
        working = { ...working, ideaBlocks: written.ids }
        at('write-idea', `Idea summary from ${summaryFile} (${written.ids.length} block(s) written, ${written.deleted.length} replaced)`)
      } catch (error) {
        pushFailures.push(`Idea summary: ${message(error)}; Grooming Decisions was written from ${decisionsFile}`)
        at('write-idea', `Idea summary from ${summaryFile}`, false, message(error))
        final = 'incomplete'
        return working
      }
    }
    // (d) The page as this run left it: a Confirm is checked on it, never on the run's word.
    let after: (TicketPage & { markdown: string }) | undefined
    try {
      after = await client.pullPage(ticket.url, title)
    } catch (error) {
      return incomplete(`${title} could not be read after the replace: ${message(error)}`)
    }
    const state = groomPageState(after?.markdown ?? '')
    if (final === 'ready' && (state.open > 0 || !state.confirmTicked)) {
      reported = 'ready'
      final = 'needs-author'
      check(`confirmed reported, ${state.open} open on Grooming Decisions; recorded needs-author`)
    } else if (final !== 'ready' && state.confirmTicked && state.open === 0) {
      const sentence = 'Confirm was ticked after this run wrote the page; rerun to complete grooming'
      notices.push(sentence)
      check(sentence)
    }
    if (final !== 'ready') return working
    // (e) The Status re-read: the end move keys on it, never on ticket.md.
    const wrong = (current: string) => incomplete(`${ticket.id} is in "${current}", not "${gate.inProgress}"; the Idea summary was written and stays`)
    let current: string
    try {
      current = (await client.resolveTicket(ticket.url)).status
      trace.actions.push(entry('resolve', `${ticket.id} re-read before the end move: "${current}"`, status, current))
      status = current
    } catch (error) {
      return incomplete(`${ticket.id} could not be re-read: ${message(error)}`)
    }
    if (current === gate.success) {
      check(`already in ${gate.success}; no move`)
      return working
    }
    const move = statusFlowOf(options.folder).statusFlow === false ? null : endMove(options.skill, final, current, false)
    if (move === null) return wrong(current)
    try {
      const moved = await client.moveTicket(ticket.url, move.from, move.to)
      trace.actions.push(entry('move', `${moved.before} -> ${moved.after}`, moved.before, moved.after))
      status = moved.after
      return working
    } catch (error) {
      at('move', `${move.from} -> ${move.to}`, false, message(error))
      const now = await client.resolveTicket(ticket.url).then((found) => found.status, () => status)
      status = now
      return wrong(now)
    }
  }

  const open = record === undefined ? 0 : openCount(record)
  if (record !== undefined) {
    const { reportedStatus: _previous, ...rest } = record
    await writeGroomRecord(options.folder, { ...rest, status: final, open, page: { ...rest.page, ...(url === undefined ? {} : { url }) }, ...(reported === undefined ? {} : { reportedStatus: reported }) })
  }
  ticket.status = status
  trace.statusAfter = status
  await writeInto(join(options.folder, TICKET_FILE), renderTicketMd(ticket))
  const telemetryFailures = await attachToTrace(options, client, ticket, trace)
  const traceFile = await writeBoardTrace(options.exportDir ?? options.folder, trace)
  const groom: GroomFinish = { open, ...(url === undefined ? {} : { url }) }
  const remaining = remainingStep(options.skill, status, false, final, options.reasonCode ?? null, groom)
  return { trace, traceFile, header: reportHeader(trace), pushFailures, telemetryFailures, remaining, runStatus: final, notices, groom }
}

export type FinishOptions = {
  skill: Skill
  folder: string
  /** The run's status word: pushes and the end move are derived from it alone (F53), no separate ok flag. */
  runStatus: RunStatus
  /** Which sub-case of runStatus this is (the groomer's round paused by Stop); affects remainingStep's wording only. */
  reasonCode?: ReasonCode | null
  /** The PR the implementor opened, when it did. */
  prUrl?: string
  /** The export directory the trace is written into; default: the working folder. */
  exportDir?: string
  board: string
  client?: Board
  env?: Record<string, string | undefined>
  /** The trace the start left, continued here. */
  trace?: BoardTrace
  /** A hand run's telemetry file, already written: attached to the ticket page under BOARD-003 (KIT-19). Absent: nothing is attached. */
  telemetry?: { runId: string; file: string }
}

export type FlowFinish = {
  trace: BoardTrace
  traceFile: string
  header: string[]
  pushFailures: string[]
  /** Every telemetry attach that did not happen, as its `Telemetry not attached: …` line. Never part of pushFailures and never the exit code (OBS-002). */
  telemetryFailures: string[]
  remaining: string | null
  /** The status after the board step: the requested word, or what the groomer's finish recorded instead. */
  runStatus: RunStatus
  /** Lines the groomer's finish prints after the header (a Confirm it did not act on, the reason a run ended incomplete). Empty for every other row. */
  notices: string[]
  /** The groomer's page and open questions, as groom/trace/groom.json records them. */
  groom?: GroomFinish
}

/** Push the outputs and make the success move (F7). A push failure is reported with the local path and the move is still made. */
export async function finishFlow(options: FinishOptions): Promise<FlowFinish> {
  const env = options.env ?? process.env
  const client = options.client ?? makeBoard({ board: options.board, token: env.NOTION_TOKEN })
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing; the start step writes it`)
  const trace: BoardTrace = options.trace ?? { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder: options.folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  if (GATES[options.skill].record !== undefined) return finishGroom(options, client, ticket, trace)
  const pushFailures: string[] = []
  let status = ticket.status
  let runStatus = options.runStatus
  for (const push of pushesFor(options.skill, runStatus)) {
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
  // A push whose file is missing (or that fails outright) means the run's output is not actually on
  // the card: the status it reports from here on is incomplete, and no move follows (F6, F53).
  if (pushFailures.length > 0) runStatus = 'incomplete'
  let prOpened = false
  if (options.skill === 'implementor' && runStatus === 'ready' && options.prUrl !== undefined && options.prUrl !== '') {
    try {
      await client.setProperty(ticket.url, 'PR', options.prUrl)
      ticket.pr = options.prUrl
      prOpened = true
      trace.actions.push(entry('set', `PR = ${options.prUrl}`, status, status))
    } catch (error) {
      trace.actions.push(entry('set', `PR = ${options.prUrl}`, status, status, false, message(error)))
    }
  }
  const move = pushFailures.length > 0 || statusFlowOf(options.folder).statusFlow === false ? null : endMove(options.skill, runStatus, status, prOpened)
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
  const telemetryFailures = await attachToTrace(options, client, ticket, trace)
  const traceFile = await writeBoardTrace(options.exportDir ?? options.folder, trace)
  const remaining = remainingStep(options.skill, status, prOpened, runStatus, options.reasonCode ?? null)
  return { trace, traceFile, header: reportHeader(trace), pushFailures, telemetryFailures, remaining, runStatus, notices: [] }
}

/** The finish's telemetry step: attach the run's file when there is one and record the result in the trace. Returns the failures. */
async function attachToTrace(options: FinishOptions, client: Board, ticket: TicketRecord, trace: BoardTrace): Promise<string[]> {
  if (options.telemetry === undefined) return []
  const ticketPageId = pageIdFrom(ticket.url)
  if (ticketPageId === undefined) {
    trace.telemetry = { file: basename(options.telemetry.file), error: 'the ticket has no page id' }
    return [telemetryNotice('the ticket has no page id', options.telemetry.file)]
  }
  const attached = await attachTelemetry({ client, ticketPageId, file: options.telemetry.file, runId: options.telemetry.runId, folder: options.folder })
  trace.telemetry = attached.trace
  return attached.failures
}

/**
 * Attach a run's telemetry file to the end of the ticket page body as one file block (KIT-19, F14),
 * for the separate-process finish of every row (finishFlow and finishGroom). Nothing is attached
 * when this run's attach record exists (a block a human deleted is not re-created), when the board
 * rules cannot be read or BOARD-003 does not list the run telemetry file block, or when the page
 * already holds a block named `<run-id>.json`. Every failure is returned as its notice line and
 * never thrown (OBS-002); an append that fails after its upload succeeded is reported once.
 */
export async function attachTelemetry(args: { client: Board; ticketPageId: string; file: string; runId: string; folder: string }): Promise<{ trace: BoardTraceTelemetry; failures: string[] }> {
  const { client, ticketPageId, file, runId, folder } = args
  const name = `${runId}.json`
  const failed = (reason: string) => ({ trace: { file: name, error: reason }, failures: [telemetryNotice(reason, file)] })
  const recorded = await readAttached(folder, runId)
  if (recorded !== null) return { trace: { file: name, blockId: recorded.blockId }, failures: [] }
  const rules = await client.rulesPage().catch(() => null)
  if (rules === null) return failed('board rules unreadable')
  if (!listsTelemetry(rules)) return failed('BOARD-003 does not list the run telemetry file block')
  let names: string[]
  try {
    names = await client.fileBlockNames(ticketPageId)
  } catch (error) {
    return failed(`the ticket page's file blocks could not be listed: ${message(error)}`)
  }
  if (names.includes(name)) return { trace: { file: name }, failures: [] }
  let content: string
  let upload: { id: string }
  try {
    content = await readFile(file, 'utf8')
    upload = await client.uploadFile(name, content)
  } catch (error) {
    return failed(`the upload failed: ${message(error)}`)
  }
  let blockId: string
  try {
    blockId = (await client.appendFileBlock(ticketPageId, upload.id)).id
  } catch (error) {
    return failed(`the file was uploaded but the append to the ticket page failed: ${message(error)}`)
  }
  try {
    await recordAttached(folder, { runId, blockId })
  } catch (error) {
    return { trace: { file: name, blockId }, failures: [`Telemetry attached but not recorded: ${message(error)}; the next attach of this run may append a second block`] }
  }
  return { trace: { file: name, blockId }, failures: [] }
}

/**
 * What is left for a human after the run, when the skill's success move was not made. The groomer's
 * rows are selected by `runStatus` and read the open questions and the page from its record.
 */
export function remainingStep(skill: Skill, status: string, prOpened: boolean, runStatus: RunStatus, reasonCode: ReasonCode | null = null, groom?: GroomFinish): string | null {
  const gate = GATES[skill]
  if (gate.record !== undefined && runStatus !== 'incomplete' && runStatus !== 'refused' && runStatus !== 'blocked') {
    const page = `${gate.pulls?.[0]?.title ?? 'the decisions page'} (${groom?.url ?? 'not created yet'})`
    if (runStatus === 'needs-author' && reasonCode === 'paused') return `Grooming stopped at the human's request; run ${skill} again to resume from the page.`
    if (runStatus === 'needs-author') return (groom?.open ?? 0) > 0 ? `Answer the ${groom?.open ?? 0} open question(s) on ${page}, then run ${skill} again; it reads the ticks.` : `Tick Confirm on ${page} to complete grooming.`
    if (runStatus === 'ready') return null
  }
  const failed = runStatus !== 'ready'
  // A spec step rerun from In Review: Spec that still needs the author (KIT-48): the decisions, not a failure, are what is left.
  if (skill === 'spec-writer' && runStatus === 'needs-author' && status === 'In Review: Spec') return `Answer the open decisions: write the answers into the reviewed spec (the Spec Reviewed page, pulled as spec.reviewed/spec.reviewed.md) or tick them in spec.reviewed/trace/decisions.md, then run ${skill} again from "${status}"; it reviews the answered spec and makes no move.`
  if (skill === 'implementor' && runStatus === 'ready' && !prOpened) return `The ticket stays in "${status}": opening the PR is the remaining step. Push the branch, open the PR, set the ticket's PR property and move it to "In Review: Implementation".`
  if (failed && gate.inProgress !== undefined) return `The run did not succeed, so the ticket stays in "${status}". Fix what stopped it and run ${skill} again; a rerun from "${gate.inProgress}" makes no start move.`
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
  /** The Dev ticket.md showed at the resolve: a row that never sets Dev refuses a verify that finds another. */
  devBefore?: string
  /** The groomer: the round the last end stage was for, and when it asked the session to replace the page. */
  round?: number
  pushAskedAt?: string
  /** The groomer: the round whose start asked the Grooming Decisions pull again (KIT-23), so each round reads the ticks made since the last, and each asked file's modified time before the pull (gone once the session wrote it). */
  syncedRound?: number
  roundPullBefore?: Record<string, string>
  /** The groomer: the start time in this run's `Run: <startedAt> local in progress` marker. */
  startedAt?: string
  /** The groomer: the Grooming Decisions URL ticket.md showed when the push was asked for (a different one is a new page), and the round the verify last recorded a push for. */
  pushUrlBefore?: string
  verifiedRound?: number
  /** A hand run's telemetry run id and start time, reserved when the board stage reached the ticket (KIT-19). The groomer clears them at the end of each round. */
  runId?: string
  runStartedAt?: string
  /** The `--parent-run` value of a run inside build-feature: it writes and attaches no telemetry of its own. */
  parentRun?: string
}

/** The telemetry fields of the local board state, the part afterRun reads (KIT-19). */
export type LocalRun = Pick<LocalBoardState, 'runId' | 'runStartedAt' | 'parentRun'>

export type LocalBoardOptions = {
  skill: Skill
  repo: string
  argument: TicketArgument
  board: string
  /** Where the driver keeps its state between calls (the run's work directory). */
  stateDir: string
  force?: boolean
  /** The groomer: the session clears another run's `Run:` marker instead of stopping (`--force-run`). */
  forceRun?: boolean
  dev?: string
  env?: Record<string, string | undefined>
  /** Runs after the resolve and before the claim (the Dev set and the start move) are printed; a check that refuses throws FlowRefused with its Next action (the implementor's branch gate, F22). */
  beforeClaim?: (ticket: TicketRecord) => void | Promise<void>
}

/** Where the --local driver keeps its board state for a skill: inside the working folder. */
export const localStateDir = (folder: string, skill: Skill): string => join(folder, '.local', skill)

const stateFile = (dir: string) => join(dir, 'board.json')

/** The telemetry fields of board.json, each checked on its own: a value that fails its schema is dropped. */
const localRunSchema = z.object({
  runId: z.string().regex(/^run-\d{8}T\d{6}Z(-\d+)?$/).optional().catch(undefined),
  runStartedAt: z.iso.datetime().optional().catch(undefined),
  parentRun: z.string().optional().catch(undefined),
})

async function readState(dir: string): Promise<LocalBoardState | null> {
  const text = await readFile(stateFile(dir), 'utf8').catch(() => null)
  if (text === null) return null
  const raw: unknown = JSON.parse(text)
  const { runId: _runId, runStartedAt: _runStartedAt, parentRun: _parentRun, ...rest } = raw as LocalBoardState
  const run = localRunSchema.safeParse(raw)
  const fields = run.success ? run.data : {}
  return {
    ...rest,
    ...(fields.runId === undefined ? {} : { runId: fields.runId }),
    ...(fields.runStartedAt === undefined ? {} : { runStartedAt: fields.runStartedAt }),
    ...(fields.parentRun === undefined ? {} : { parentRun: fields.parentRun }),
  }
}

/** The telemetry fields of a skill's local board state, or null when there is no state. */
export async function readLocalRun(stateDir: string): Promise<LocalRun | null> {
  const state = await readState(stateDir)
  if (state === null) return null
  return {
    ...(state.runId === undefined ? {} : { runId: state.runId }),
    ...(state.runStartedAt === undefined ? {} : { runStartedAt: state.runStartedAt }),
    ...(state.parentRun === undefined ? {} : { parentRun: state.parentRun }),
  }
}

/** Replace the telemetry fields of a skill's local board state; an empty value clears them. Does nothing when there is no state. */
export async function writeLocalRun(stateDir: string, run: LocalRun): Promise<void> {
  const state = await readState(stateDir)
  if (state === null) return
  const { runId: _runId, runStartedAt: _runStartedAt, parentRun: _parentRun, ...rest } = state
  await saveState(stateDir, { ...rest, ...run })
}

async function saveState(dir: string, state: LocalBoardState): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`)
}

const newerThan = async (file: string, since: string | null): Promise<boolean> => {
  const at = await modifiedAt(file)
  return at !== undefined && (since === null || Date.parse(at) >= Date.parse(since) - 1000)
}

const resolveAction = (ref: string, boardUrl: string, repo: string, folder: string | null, note?: string): BoardAction => ({
  action: 'resolve',
  ticket: ref,
  board: boardUrl,
  write: folder === null ? `${workDirFor(repo)}/<id in lower case>-<title as a slug>/${TICKET_FILE}` : join(folder, TICKET_FILE),
  folder: folder ?? `${workDirFor(repo)}/<id in lower case>-<title as a slug>`,
  format: ticketMdFormat(),
  note: note ?? `Resolve the ticket on the Feature Board with the Notion MCP (notion-fetch, read-only): by its ID property for an ID, by the page for a URL. Write ticket.md at "write" in exactly the "format" layout, with every property as the board shows it, the child pages with their last-edited times, and the Idea as plain markdown. The folder is .work/<id>-<slug>: the ID in lower case, then the title in lower case with runs of other characters as single dashes (nom-4-explore-pagination). The Idea is the ticket page body from the "## Idea" heading to the next heading of level 2 or shallower, keeping its "###" subsections, or the whole body when it has no Idea heading. The Pages table lists every child page, one row each, even when two share a title.`,
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
  const row = GATES[options.skill]
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
    const gate = checkGate(options.skill, ticket, statusFlowOf(options.repo))
    if (!gate.ok) throw new FlowRefused(gate.message)
    state.phase = 'sync'
    state.statusBefore = ticket.status
    state.devBefore = ticket.dev ?? ''
    state.trace = { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [entry('resolve', `${ticket.id} resolved from ${ref} by the session`, ticket.status, ticket.status)] }
    await writeInto(join(folder, IDEA_FILE), ticket.idea)
    await saveState(options.stateDir, state)
  }

  const folder = state.folder!
  const ticket = await readTicketMd(folder)
  if (ticket === null) throw new FlowRefused(`${join(folder, TICKET_FILE)} is missing or not a ticket file; delete ${options.stateDir} and start over`)
  const gate = checkGate(options.skill, ticket, statusFlowOf(options.repo))
  if (!gate.ok) throw new FlowRefused(gate.message)
  const plan = await pullPlan(options.skill, ticket, folder, state.previous, options.force === true)
  // The groomer's overwrite pull (Grooming Decisions) is asked again at the start of every round after
  // the first (KIT-23): the round that follows a verified one reads the ticks made on the page since,
  // between rounds or between runs of a paused round, instead of the copy the last round rendered.
  const nextRound = row.record !== undefined && state.round !== undefined && state.verifiedRound === state.round ? state.round + 1 : null
  if (nextRound !== null && state.syncedRound !== nextRound) {
    state.syncedRound = nextRound
    state.roundPullBefore = {}
    for (const item of plan) {
      if (item.decision !== 'write' || !(row.pulls ?? []).some((pull) => pull.title === item.title)) continue
      // The copy is pulled once its file changes, whatever the clock says: the last round rendered it moments ago.
      state.roundPullBefore[item.file] = (await modifiedAt(item.file)) ?? ''
      state.trace?.actions.push(entry('pull', `${item.title} -> ${item.file} (pulled over the local copy at the start of round ${nextRound}) by the session`, ticket.status, ticket.status))
    }
    await saveState(options.stateDir, state)
  }
  // A file the session wrote since the sync was asked for is the pull, not a local edit.
  const pending: typeof plan = []
  for (const item of plan) {
    const before = state.roundPullBefore?.[item.file]
    if (before !== undefined) {
      if (((await modifiedAt(item.file)) ?? '') === before) pending.push(item)
      else {
        delete state.roundPullBefore![item.file]
        await saveState(options.stateDir, state)
      }
      continue
    }
    if (item.decision === 'keep' || state.syncAskedAt === null || !(await newerThan(item.file, state.syncAskedAt))) pending.push(item)
  }
  const conflict = conflictMessage(pending)
  if (conflict !== null) throw new FlowRefused(conflict)
  const pulls: BoardAction[] = []
  for (const item of pending) {
    if (item.decision !== 'write') continue
    pulls.push({ action: 'pull', title: item.title, page: item.page, file: item.file, reason: item.reason, note: item.note ?? 'Fetch the child page with the Notion MCP and write its content as plain markdown (no Notion escapes; tables as pipe tables; callouts as block quotes).' })
  }
  if (options.beforeClaim !== undefined) await options.beforeClaim(ticket)
  const claim: BoardAction[] = []
  if (gate.startMove !== null) {
    if (row.setsDev !== false) claim.push({ action: 'set', page: ticket.url, name: 'Dev', value: dev, then: `set Dev to "${dev}" in ${join(folder, TICKET_FILE)}` })
    claim.push({ action: 'move', page: ticket.url, from: gate.startMove.from, to: gate.startMove.to, then: `set Status to "${gate.startMove.to}" in ${join(folder, TICKET_FILE)}` })
  }
  // The groomer's marker goes on the page with the first sync, after the pull, before the claim.
  const groomPull = row.pulls?.[0]
  const mark: BoardAction[] = []
  if (groomPull !== undefined && row.record !== undefined && (state.syncAskedAt === null || pulls.length + claim.length > 0)) {
    state.startedAt ??= new Date().toISOString()
    const text = runMarkerText(state.startedAt, 'local')
    const stale = options.forceRun === true ? 'delete any other "Run: ... in progress" paragraph on it first (--force-run)' : 'if it carries a "Run: ... in progress" paragraph from another run, stop and report that a groomer run is in progress (rerun with --force-run to clear it)'
    mark.push({
      action: 'mark',
      page: ticket.pages[groomPull.title]?.url ?? ticket.url,
      text,
      then: `append the paragraph ${text} to ${groomPull.title} (when the card has no ${groomPull.title} page, create it with its title and intro first and add its row to the Pages table in ${join(folder, TICKET_FILE)}); ${stale}; skip the append when the page already carries this exact paragraph`,
    })
  }
  const actions = [...pulls, ...mark, ...claim]
  const expected = gate.startMove?.to ?? ticket.status
  if (actions.length > 0) {
    if (state.syncAskedAt === null) state.syncAskedAt = new Date().toISOString()
    await saveState(options.stateDir, state)
    return { stage: stageOf(folder, actions, expected, 'Perform each action with the Notion MCP (notion-fetch for a pull, notion-update-page for a move or a property), update ticket.md as each "then" says, then call local again.') }
  }
  const trace = state.trace!
  if (state.phase === 'sync') {
    for (const item of plan) if (!pending.includes(item)) trace.actions.push(entry('pull', `${item.title} -> ${item.file} (${item.reason}) by the session`, state.statusBefore ?? ticket.status, state.statusBefore ?? ticket.status))
    await recordPulled(folder, plan.filter((item) => !pending.includes(item)).map((item) => item.file))
    if (groomPull !== undefined && row.record !== undefined && state.startedAt !== undefined) trace.actions.push(entry('mark', `${runMarkerText(state.startedAt, 'local')} -> ${groomPull.title} by the session`, state.statusBefore ?? ticket.status, state.statusBefore ?? ticket.status))
    if (state.statusBefore !== null && ticket.status !== state.statusBefore) {
      if (row.setsDev !== false) trace.actions.push(entry('set', `Dev = ${ticket.dev ?? dev} by the session`, state.statusBefore, state.statusBefore))
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

export type LocalBoardEndOptions = {
  skill: Skill
  folder: string
  runStatus: RunStatus
  /** Which sub-case of runStatus this is (the groomer's round paused by Stop); affects remainingStep's wording only. */
  reasonCode?: ReasonCode | null
  exportDir: string
  stateDir: string
  verifyCommand: string
  /** The groomer: the round this end stage is for (one end stage per round). */
  round?: number
  /** The Feature Board, for the groomer's final Status re-read. */
  board?: string
  /** A hand run's telemetry file, already written: the session reads the board rules and attaches it (KIT-19). */
  telemetry?: { runId: string; file: string }
  /**
   * Pushes a page through the Notion API (the board client's pushPage, with NOTION_TOKEN). When given, the
   * end stage pushes every page itself instead of handing the session a push action: the session would
   * otherwise retype the whole file through the Notion MCP, which takes minutes for a large Plan.
   * A push that fails falls back to the session's push action.
   */
  push?: (page: string, title: string, markdown: string) => Promise<{ id: string; url: string; created: boolean; lastEditedAt: string }>
}

/** Where the --local session saves the board rules for the attach check: beside the export's board trace. */
export const boardRulesFile = (exportDir: string): string => (existsSync(join(exportDir, 'trace')) ? join(exportDir, 'trace', 'board-rules.md') : join(exportDir, 'board-rules.md'))

/** The two strings a BOARD-003 line must carry for a run to attach its telemetry file (telemetry.ts listsTelemetry). */
const TELEMETRY_RULE = ['BOARD-003', 'run telemetry file']

/**
 * The --local telemetry actions (KIT-19, F14): read the board rules into the export, then attach the
 * run's file to the end of the ticket page body when the rules allow it. Records the file name in
 * the trace for the verify step; without a telemetry file there are no actions and no record.
 */
function telemetryActions(options: LocalBoardEndOptions, ticket: TicketRecord, trace: BoardTrace): BoardAction[] {
  delete trace.telemetry
  if (options.telemetry === undefined) return []
  const name = `${options.telemetry.runId}.json`
  const page = pageIdFrom(ticket.url) ?? ticket.url
  const rules = boardRulesFile(options.exportDir)
  trace.telemetry = { file: name }
  return [
    { action: 'read', target: 'board-rules', file: rules, note: 'Fetch the Feature Board rules page with the Notion MCP (notion-fetch, read-only; it is the "Feature Board" page under AI-DLC in Engineering Central) and write it to "file" as plain markdown, one rule per line. Write nothing to Notion.' },
    {
      action: 'attach',
      page,
      file: options.telemetry.file,
      name,
      onlyIf: TELEMETRY_RULE,
      note: `Only when one line of the rules you saved contains every string of "onlyIf": attach "file", as "name", in one file block at the end of the ticket page body "page" (notion-create-attachment for a file of at most 200 KiB, else notion-create-file-upload, then notion-update-page). Attach no other file, to no other page, and never edit or delete another block. Pass the result to the verify step as {"blockId": "<the new block id>"}, or {"error": "<why>"} when the rules do not allow it or the attach failed.`,
    },
  ]
}

export type LocalBoardEnd = { stage: 'board-end'; actions: BoardAction[]; verify: { command: string; file: string; status: string } | null; traceFile: string; remaining: string | null }

/** The end of a local run (F8): the pushes and the success or failure move as actions, and the trace written into the export with the Status the verify step expects. */
export async function localBoardEnd(options: LocalBoardEndOptions): Promise<LocalBoardEnd> {
  if (GATES[options.skill].record !== undefined) return localGroomEnd(options)
  const state = await readState(options.stateDir)
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing`)
  const trace: BoardTrace = state?.trace ?? { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder: options.folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  const actions: BoardAction[] = []
  let runStatus = options.runStatus
  let missing = false
  for (const push of pushesFor(options.skill, runStatus)) {
    const file = join(options.folder, push.file)
    if (!existsSync(file)) {
      missing = true
      trace.actions.push(entry('check', `${push.title} from ${file}: the file is missing, nothing to push`, ticket.status, ticket.status, false, 'file missing'))
      continue
    }
    if (options.push !== undefined) {
      try {
        const pushed = await options.push(ticket.url, push.title, await readFile(file, 'utf8'))
        ticket.pages[push.title] = { id: pushed.id, title: push.title, url: pushed.url, lastEditedAt: pushed.lastEditedAt }
        await writeInto(join(options.folder, TICKET_FILE), renderTicketMd(ticket))
        trace.pushed.push({ title: push.title, url: pushed.url })
        trace.actions.push(entry('push', `${push.title} from ${file} (${pushed.created ? 'created' : 'replaced'} through the Notion API)`, ticket.status, ticket.status))
        continue
      } catch (error) {
        trace.actions.push(entry('push', `${push.title} from ${file} through the Notion API; the session pushes it instead`, ticket.status, ticket.status, false, message(error)))
      }
    }
    actions.push({ action: 'push', page: ticket.url, title: push.title, file, then: `add or update the "${push.title}" row of the Pages table in ${join(options.folder, TICKET_FILE)} with the page URL and its last-edited time` })
  }
  // A planned push whose file never materialized means the run's output is not actually ready to
  // land on the card: the status is incomplete from here on, and no move action follows (F6, F53).
  if (missing) runStatus = 'incomplete'
  const move = missing || statusFlowOf(options.folder).statusFlow === false ? null : endMove(options.skill, runStatus, ticket.status, false)
  if (move !== null) actions.push({ action: 'move', page: ticket.url, from: move.from, to: move.to, then: `set Status to "${move.to}" in ${join(options.folder, TICKET_FILE)}` })
  actions.push(...telemetryActions(options, ticket, trace))
  const expected = move?.to ?? ticket.status
  trace.expected = expected
  trace.pushing = actions.filter((action) => action.action === 'push').map((action) => (action as { title: string }).title)
  // Nothing for the session to do: the trace is complete as it stands.
  trace.verified = actions.length === 0
  const traceFile = await writeBoardTrace(options.exportDir, trace)
  return { stage: 'board-end', actions, verify: actions.length === 0 ? null : { command: options.verifyCommand, file: join(options.folder, TICKET_FILE), status: expected }, traceFile, remaining: remainingStep(options.skill, expected, false, runStatus, options.reasonCode ?? null) }
}

/**
 * The groomer's end of a round in --local: the marker delete on every exit, the append-first replace
 * of Grooming Decisions, and on a confirm the Status re-read, the Idea write and the Shortlist move.
 * The trace is re-read from the export, so every round's push stays in it.
 */
async function localGroomEnd(options: LocalBoardEndOptions): Promise<LocalBoardEnd> {
  const row = GATES[options.skill]
  const title = row.pulls?.[0]?.title ?? row.pushes[0]?.title ?? ''
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing`)
  const ticketFile = join(options.folder, TICKET_FILE)
  const state: LocalBoardState = (await readState(options.stateDir)) ?? { skill: options.skill, ref: ticket.id, phase: 'ready', folder: options.folder, askedAt: null, syncAskedAt: null, previous: {}, statusBefore: ticket.status, trace: null }
  const trace: BoardTrace = (await readBoardTrace(options.exportDir))?.trace ?? state.trace ?? { skill: options.skill, ticket: { id: ticket.id, title: ticket.title, url: ticket.url }, folder: options.folder, statusBefore: ticket.status, statusAfter: ticket.status, pushed: [], actions: [] }
  const page = ticket.pages[title]?.url ?? ticket.url
  const marker = state.startedAt === undefined ? 'Run: <startedAt> local in progress' : runMarkerText(state.startedAt, 'local')
  const actions: BoardAction[] = [{ action: 'unmark', page, text: marker, then: `delete the paragraph ${marker} from ${title}; delete no other block` }]
  const final: RunStatus = options.runStatus
  const reasonCode = options.reasonCode ?? null
  const record = await readGroomRecord(options.folder)
  if (final === 'ready' || final === 'needs-author') {
    for (const push of pushesFor(options.skill, final)) {
      const file = join(options.folder, push.file)
      if (!existsSync(file)) throw new FlowRefused(`${file} is missing; the round did not render ${push.title}`)
      actions.push({
        action: 'replace',
        page: ticket.url,
        title: push.title,
        file,
        note: `Replace the body of the "${push.title}" child page with the file's content, verbatim: append the new rendering below the existing blocks first, and delete the previous blocks only after every append succeeded (never a child page, child database or synced block), so the page is never empty.`,
        then: `update the "${push.title}" row of the Pages table in ${ticketFile} with the page URL and its last-edited time as Notion reports it after the replace`,
      })
    }
  }
  let move: { from: string; to: string } | null = null
  if (final === 'ready') {
    const summaryFile = join(options.folder, GROOM_IDEA_SUMMARY_FILE)
    const summary = await readFile(summaryFile, 'utf8').catch(() => null)
    if (summary === null) throw new FlowRefused(`${summaryFile} is missing; the summary stage writes it before the board stage`)
    if (record === undefined) throw new FlowRefused(`${join(options.folder, row.record?.file ?? '')} is missing; the round did not record its decisions`)
    const valid = validateIdeaSummary(summary, record)
    if (!valid.ok) throw new FlowRefused(`${summaryFile}: ${valid.reason}`)
    actions.push(
      resolveAction(ticket.id, options.board ?? '', dirname(options.folder), options.folder, `Re-read the card with the Notion MCP (notion-fetch, read-only) and rewrite ticket.md at "write" in the "format" layout: the ${row.success} move below is made only from "${row.inProgress}"; from "${row.success}" make no move, and from any other Status make no move and stop.`),
    )
    actions.push({
      action: 'write-idea',
      page: ticket.url,
      afterBlockId: 'the last block of the Idea prose, or the paragraph that opens a previous summary ("Groomed with /aspira-groomer on ...")',
      file: summaryFile,
      then: 'write the file into the card body under ## Idea, replacing a previous summary found by its opening paragraph; delete no block the groomer did not write',
    })
    move = statusFlowOf(options.folder).statusFlow === false ? null : endMove(options.skill, final, ticket.status, false)
    if (move !== null) actions.push({ action: 'move', page: ticket.url, from: move.from, to: move.to, then: `set Status to "${move.to}" in ${ticketFile}` })
  }
  actions.push(...telemetryActions(options, ticket, trace))
  const open = record === undefined ? 0 : openCount(record)
  if (record !== undefined) await writeGroomRecord(options.folder, { ...record, status: final, reasonCode, open })
  state.round = options.round ?? record?.round ?? (state.round ?? 0) + 1
  state.pushAskedAt = new Date().toISOString()
  const before = ticket.pages[title]?.url
  if (before === undefined) delete state.pushUrlBefore
  else state.pushUrlBefore = before
  await saveState(options.stateDir, state)
  const expected = move?.to ?? ticket.status
  trace.expected = expected
  trace.pushing = actions.filter((action) => action.action === 'replace').map((action) => (action as { title: string }).title)
  trace.verified = false
  const traceFile = await writeBoardTrace(options.exportDir, trace)
  const url = record?.page.url
  return { stage: 'board-end', actions, verify: { command: options.verifyCommand, file: ticketFile, status: expected }, traceFile, remaining: remainingStep(options.skill, expected, false, final, reasonCode, { open, ...(url === undefined ? {} : { url }) }) }
}

/** A time floored to its minute, or NaN: the board records page edits at minute precision. */
const minuteOf = (iso: string): number => Math.floor(Date.parse(iso) / 60_000)

/** What the --local session reports for its telemetry attach action: the new block's id, or why it attached nothing. */
export type TelemetryAttachResult = { blockId: string } | { error: string }

/**
 * The verify step's telemetry part (KIT-19, F14, F16): record the session's attach result in the
 * trace and the attach record, checking the saved board rules itself. A missing, failed or not
 * allowed attach is returned as a notice; it never makes a problem. A run already recorded as
 * attached keeps its record, so a second verify changes nothing.
 */
async function verifyTelemetry(options: { folder: string; exportDir: string; attach?: TelemetryAttachResult }, trace: BoardTrace): Promise<string[]> {
  const current = trace.telemetry
  if (current === undefined || current.blockId !== undefined) return []
  const runId = current.file.replace(/\.json$/, '')
  const path = telemetryFile(options.folder, runId)
  const recorded = await readAttached(options.folder, runId)
  if (recorded !== null) {
    trace.telemetry = { file: current.file, blockId: recorded.blockId }
    return []
  }
  const rules = await readFile(boardRulesFile(options.exportDir), 'utf8').catch(() => null)
  const attach = options.attach
  let reason: string
  if (attach !== undefined && 'error' in attach) reason = attach.error
  else if (rules === null) reason = 'board rules unreadable'
  else if (!listsTelemetry(rules)) reason = 'BOARD-003 does not list the run telemetry file block'
  else if (attach === undefined) reason = 'the session reported no attach result'
  else {
    try {
      await recordAttached(options.folder, { runId, blockId: attach.blockId })
    } catch (error) {
      reason = `the attach record could not be written: ${message(error)}`
      trace.telemetry = { file: current.file, blockId: attach.blockId }
      return [`Telemetry attached but not recorded: ${reason}`]
    }
    trace.telemetry = { file: current.file, blockId: attach.blockId }
    return []
  }
  trace.telemetry = { file: current.file, error: reason }
  return [telemetryNotice(reason, path)]
}

/** The last local step: ticket.md must show the expected Status; the pushed pages are read from its Pages table; the trace is completed. `attach` is the session's telemetry attach result, reported as a notice only. */
export async function localBoardVerify(options: { skill: Skill; folder: string; exportDir: string; attach?: TelemetryAttachResult }): Promise<{ ok: boolean; header: string[]; trace: BoardTrace; traceFile: string; problem: string | null; notices: string[] }> {
  const found = await readBoardTrace(options.exportDir)
  if (found === null) throw new Error(`No board trace under ${options.exportDir}; run the export step first`)
  const { trace } = found
  const ticket = await readTicketMd(options.folder)
  if (ticket === null) throw new Error(`${join(options.folder, TICKET_FILE)} is missing`)
  const row = GATES[options.skill]
  const ticketFile = join(options.folder, TICKET_FILE)
  const expected = trace.expected ?? trace.statusAfter ?? ticket.status
  const before = trace.statusAfter ?? ticket.status
  let problem: string | null = null
  if (ticket.status !== expected) problem = `${ticketFile} shows "${ticket.status}", expected "${expected}". Make the move with the Notion MCP, update ticket.md, and run the verify step again.`
  else if (before !== expected) trace.actions.push(entry('move', `${before} -> ${expected} by the session`, before, expected))
  const stateDir = localStateDir(options.folder, options.skill)
  const state = row.setsDev === false || row.record !== undefined ? await readState(stateDir) : null
  if (row.setsDev === false && state?.devBefore !== undefined && (ticket.dev ?? '') !== state.devBefore) problem ??= `Dev changed from "${state.devBefore}" to "${ticket.dev ?? ''}"; the ${options.skill} never sets Dev`
  if (row.record === undefined) {
    for (const title of trace.pushing ?? []) {
      const page = ticket.pages[title]
      if (page === undefined) {
        problem ??= `${ticketFile} has no "${title}" row in its Pages table; push the page with the Notion MCP, add the row, and run the verify step again.`
        continue
      }
      if (trace.pushed.some((pushed) => pushed.title === title)) continue
      trace.pushed.push({ title, url: page.url })
      trace.actions.push(entry('push', `${title} -> ${page.url} by the session`, expected, expected))
    }
    trace.statusAfter = ticket.status
    trace.verified = problem === null
    const notices = await verifyTelemetry(options, trace)
    const traceFile = await writeBoardTrace(options.exportDir, trace)
    return { ok: problem === null, header: reportHeader(trace), trace, traceFile, problem, notices }
  }
  // The groomer: re-entrant, one verify per round. The replaced page must be newer than the ask (or new), and the session's copy carries no marker.
  const rows: { title: string; url: string }[] = []
  for (const title of trace.pushing ?? []) {
    const page = ticket.pages[title]
    if (page === undefined) {
      problem ??= `${ticketFile} has no "${title}" row in its Pages table; replace the page with the Notion MCP, add the row, and run the verify step again.`
      continue
    }
    const isNew = state?.pushUrlBefore === undefined || page.url !== state.pushUrlBefore
    const asked = state?.pushAskedAt
    const fresh = isNew || (asked !== undefined && minuteOf(page.lastEditedAt) >= minuteOf(asked))
    if (!fresh) problem ??= `${ticketFile} shows the "${title}" row last edited "${page.lastEditedAt}", before the replace was asked for (${asked ?? 'unknown'}). Replace the page with the Notion MCP, write the row's last-edited time as Notion reports it, and run the verify step again.`
    else rows.push({ title, url: page.url })
  }
  const output = row.record.file.split('/')[0] ?? ''
  const copy = state?.round === undefined ? null : join(options.folder, `${output}.local`, `page-${state.round}.md`)
  const copyText = copy === null ? null : await readFile(copy, 'utf8').catch(() => null)
  if (copy !== null && copyText !== null && runMarkers(copyText).length > 0) problem ??= `${copy} still carries a "Run:" line; delete the run marker from the page with the Notion MCP, fetch the page again into that file, and run the verify step again.`
  const record = await readGroomRecord(options.folder)
  if (problem === null) {
    if (state !== null && state.verifiedRound !== state.round) {
      for (const pushed of rows) {
        trace.pushed.push(pushed)
        trace.actions.push(entry('replace', `${pushed.title} -> ${pushed.url} by the session (round ${state.round ?? '?'})`, expected, expected))
      }
      state.verifiedRound = state.round
      await saveState(stateDir, state)
    }
    const url = rows[0]?.url
    if (record !== undefined && url !== undefined) await writeGroomRecord(options.folder, { ...record, page: { ...record.page, url } })
  }
  trace.statusAfter = ticket.status
  trace.verified = problem === null && (record?.status === 'ready' || (record?.status === 'needs-author' && record?.reasonCode === 'paused'))
  const notices = await verifyTelemetry(options, trace)
  const traceFile = await writeBoardTrace(options.exportDir, trace)
  return { ok: problem === null, header: reportHeader(trace), trace, traceFile, problem, notices }
}

/** The ticket's input file for a skill, checked to exist, with a message naming the page that is missing. */
export function inputFileFor(skill: Skill, folder: string, statusBefore?: string): string {
  const gate = GATES[skill]
  const input = statusBefore !== undefined && gate.inputByStatus?.[statusBefore] !== undefined ? gate.inputByStatus[statusBefore]! : gate.input
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
  const by: Record<string, string> = { Spec: 'The spec writer puts it there.', 'Spec Reviewed': 'The spec writer puts it there.', Plan: 'The planner puts it there.', Implementation: 'The implementor puts it there.' }
  return by[title] ?? ''
}

export { BoardError }
