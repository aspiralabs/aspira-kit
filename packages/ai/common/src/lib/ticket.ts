// The ticket flow, pure: which Status each skill needs and which moves it makes, how a ticket's
// pages map onto the working folder, how `ticket.md` is written and read back, when a pulled file
// is left alone or refused, and how the ticket argument of a skill resolves. No node imports, so
// every rule here is unit tested without a repository or a board. `ticket-flow.ts` does the file
// system and board work on top of it.

import { join } from 'node:path'
import { workRootFor } from './aspira-config.ts'
import { BoardError, parseTicketRef, type Ticket, type TicketPage } from './board.ts'
import { pageIdFrom } from './knowledge.ts'
import { RUN_STATUSES, type RunStatus } from './run-status.ts'

/** Every run status word, and the type (moved to `run-status.ts`; re-exported here since most of this file's own callers already import it from `./ticket.ts`). */
export { RUN_STATUSES }
export type { RunStatus }

/** The skills a model may run through the board tool: every skill but the groomer, whose start and finish only its driver runs. */
export const TOOL_SKILLS = ['spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const
export type ToolSkill = (typeof TOOL_SKILLS)[number]

export const SKILLS = [...TOOL_SKILLS, 'groomer'] as const
export type Skill = (typeof SKILLS)[number]

/** The folder under the repository root that holds one working folder per ticket. */
export const WORK_DIR = '.work'

/** The folder holding a repo's working folders: the client file's `workRoot` when one applies (KIT-68), otherwise <repo>/.work. */
export function workDirFor(repo: string): string {
  return workRootFor(repo) ?? join(repo, WORK_DIR)
}
export const TICKET_FILE = 'ticket.md'
export const IDEA_FILE = 'idea.md'

/** The Dev the board records on a claim. The agent environment may override it. */
export const DEV_ENV = 'ASPIRA_DEV'
export const DEFAULT_DEV = 'Claude'

/** The ticket's child pages and where each lands in the working folder (F5). */
export const TICKET_PAGES: { title: string; file: string }[] = [
  { title: 'Spec', file: 'spec.md' },
  { title: 'Spec Reviewed', file: 'spec.reviewed/spec.reviewed.md' },
  { title: 'Plan', file: 'plan.review/plan.reviewed.md' },
  { title: 'Implementation', file: 'plan.review/implementation.md' },
]

/**
 * One page a skill pushes on success: its fixed title and the file in the working folder it comes
 * from. `pushOn` is every run status that makes this push (F53). `replace: 'append-first'` replaces
 * the page's body without ever leaving it empty; `note` is passed to the --local session with the
 * push action.
 */
export type Push = { title: string; file: string; pushOn: RunStatus[]; replace?: 'append-first'; note?: string }

/** One page a skill pulls before it runs, over the local file every time (`overwrite`). */
export type Pull = { title: string; file: string; overwrite: true; note?: string }

/** A skill's row of the gate table (F6 and F7). */
export type Gate = {
  /** The Statuses the skill runs from. */
  accepts: string[]
  /** The skill's own In Progress status: the start move's target, and where a retry proceeds without a move. */
  inProgress?: string
  /** The success move's target. The implementor only moves when it opened the PR. */
  success?: string
  /** The ticket property the skill needs set before it runs. */
  requires?: 'PR'
  pushes: Push[]
  /** The file in the working folder the skill takes as its input, when it takes one; a list is tried in order. */
  input?: string | string[]
  /** The input list for a run that starts from a given Status, when it differs (the spec writer reruns from In Review: Spec on the answered reviewed spec, KIT-48). */
  inputByStatus?: Record<string, string[]>
  /** The accepted Statuses that make the start move; any other accepted Status runs with none. Absent: every accepted Status outside inProgress moves. */
  startFrom?: string[]
  /** false: the claim sets no Dev. */
  setsDev?: false
  /** The card Types the skill runs on; any other is refused before a model call (F4). */
  types?: readonly string[]
  /** false: the skill refuses --no-ticket. */
  noTicket?: false
  /** Appended to the wrong-Status refusal: how a human reopens the skill's step. */
  reopen?: string
  /** The pages pulled before the run, over the local file. */
  pulls?: Pull[]
  /** The skill's run record in the working folder. */
  record?: { file: string }
  /** The run statuses that make the success move; any other makes none. Absent: the move never happens from a run status alone (the skill has no success/inProgress pair, or its move is gated some other way). */
  moveOn?: RunStatus[]
}

/** What the groomer's refusal adds on a Status it does not accept. */
export const GROOMER_REOPEN = 'grooming is finished; a human moves the card back to Grooming to reopen it (for Dropped, a human decides whether to revive it)'

export const GATES: Record<Skill, Gate> = {
  // One spec step (KIT-48): the writer explores, drafts and runs the one specialist review on its draft,
  // from Ready: Idea; from In Review: Spec it reruns the review on the answered reviewed spec, with no move.
  'spec-writer': {
    accepts: ['Ready: Idea', 'In Review: Spec'],
    inProgress: 'In Progress: Spec',
    success: 'In Review: Spec',
    startFrom: ['Ready: Idea'],
    pushes: [
      { title: 'Spec', file: 'spec.md', pushOn: ['ready', 'needs-author'] },
      { title: 'Spec Reviewed', file: 'spec.reviewed/spec.reviewed.md', pushOn: ['ready', 'needs-author'] },
      { title: 'Spec Review Decisions', file: 'spec.reviewed/trace/decisions.md', pushOn: ['needs-author'] },
    ],
    input: IDEA_FILE,
    inputByStatus: { 'In Review: Spec': ['spec.reviewed/spec.reviewed.md', 'spec.md'] },
    moveOn: ['ready', 'needs-author'],
  },
  planner: { accepts: ['Ready: Spec'], inProgress: 'In Progress: Plan', success: 'In Review: Plan', pushes: [{ title: 'Plan', file: 'plan.review/plan.reviewed.md', pushOn: ['ready', 'needs-author'] }], input: 'spec.reviewed/spec.reviewed.md', moveOn: ['ready', 'needs-author'] },
  implementor: {
    accepts: ['Ready: Plan'],
    inProgress: 'In Progress: Implementation',
    success: 'In Review: Implementation',
    pushes: [{ title: 'Implementation', file: 'plan.review/implementation.md', pushOn: ['ready'] }],
    input: 'plan.review/plan.reviewed.md',
    moveOn: ['ready'],
  },
  'code-analyzer': { accepts: ['In Progress: Implementation', 'In Review: Implementation'], pushes: [] },
  'pr-reviewer': { accepts: ['In Review: Implementation'], requires: 'PR', pushes: [{ title: 'PR Review', file: 'pr-review/review.md', pushOn: ['ready'] }] },
  groomer: {
    accepts: ['Idea', 'Grooming', 'Shortlist'],
    inProgress: 'Grooming',
    success: 'Shortlist',
    startFrom: ['Idea'],
    setsDev: false,
    types: ['Feature', 'Bug'],
    noTicket: false,
    reopen: GROOMER_REOPEN,
    pulls: [{ title: 'Grooming Decisions', file: 'groom/trace/decisions.md', overwrite: true }],
    pushes: [{ title: 'Grooming Decisions', file: 'groom/trace/decisions.md', replace: 'append-first', pushOn: ['ready', 'needs-author'] }],
    record: { file: 'groom/trace/groom.json' },
    input: IDEA_FILE,
    moveOn: ['ready'],
  },
}

/** Who moves a card into a Status, for a refusal message. A human owns every Ready column (BOARD-004). */
export function whoMoves(status: string): string {
  const moves: Record<string, string> = {
    'Ready: Idea': 'a human, after grooming the idea',
    'Ready: Spec': 'a human, after approving the spec',
    'Ready: Plan': 'a human, after approving the plan',
    'Ready: Implementation': 'a human, after merging the PR',
    'In Progress: Spec': 'the spec writer, when it claims the ticket',
    'In Review: Spec': 'the spec writer, when the reviewed spec is on the ticket',
    'In Progress: Plan': 'the planner, when it claims the ticket',
    'In Review: Plan': 'the planner, when the plan is on the ticket',
    'In Progress: Implementation': 'the implementor, when it claims the ticket',
    'In Review: Implementation': 'the implementor, when the PR is open and set on the ticket',
    Released: 'a human, when the release is cut',
  }
  return moves[status] ?? 'a human'
}

/** The child pages of a title the ticket has more than once, every one of them, the first first. */
export type DuplicatePages = NonNullable<Ticket['duplicatePages']>

/** The Type gate's refusals (F4). `name` is `<ID> <title>`; each ends with the sentence every gate refusal ends with. A Bug card is groomed like a Feature until the Diagnoser (KIT-9) exists (KIT-22). */
export const TYPE_EMPTY_MESSAGE = (name: string, types: readonly string[]): string => `${name} has no Type; set it to ${types.join(' or ')} to groom it. No model call was made.`
export const TYPE_OTHER_MESSAGE = (name: string, skill: Skill, type: string, types: readonly string[]): string => `${name} is a ${type} card; ${skill} grooms ${types.join(' and ')} cards only. No model call was made.`

/** The refusal when a pulled page's title is on more than one child page (F14): it names every one and picks none. */
export const DUPLICATE_PAGES_MESSAGE = (id: string, title: string, urls: string[]): string =>
  `${id} has ${urls.length} child pages titled "${title}" (${urls.join(', ')}); delete or rename all but one and rerun`

export type GateCheck =
  | { ok: true; retry: boolean; startMove: { from: string; to: string } | null }
  | { ok: false; message: string }

/** The gate: may this skill run on a ticket in this Status, and does it make a start move. */
export function checkGate(skill: Skill, ticket: Pick<Ticket, 'id' | 'title' | 'status' | 'pr' | 'type'> & { duplicatePages?: DuplicatePages }): GateCheck {
  const gate = GATES[skill]
  const name = `${ticket.id} ${ticket.title}`.trim()
  if (gate.types !== undefined) {
    const type = (ticket.type ?? '').trim()
    // `<Type>` is the unfilled placeholder of the ticket.md format: the session never read the Type.
    if (type === '' || type === '<Type>') return { ok: false, message: TYPE_EMPTY_MESSAGE(name, gate.types) }
    if (!gate.types.includes(type)) return { ok: false, message: TYPE_OTHER_MESSAGE(name, skill, type, gate.types) }
  }
  for (const pull of gate.pulls ?? []) {
    const duplicate = ticket.duplicatePages?.find((entry) => entry.title === pull.title)
    if (duplicate !== undefined) return { ok: false, message: DUPLICATE_PAGES_MESSAGE(ticket.id, pull.title, duplicate.pages.map((page) => page.url)) }
  }
  if (gate.inProgress !== undefined && ticket.status === gate.inProgress) return { ok: true, retry: true, startMove: null }
  if (gate.accepts.includes(ticket.status)) {
    if (gate.requires === 'PR' && !ticket.pr) {
      return { ok: false, message: `${name} is "${ticket.status}" but its PR property is not set; ${skill} needs the PR. Set it (the implementor does, when it opens the PR). No model call was made.` }
    }
    const moves = gate.inProgress !== undefined && (gate.startFrom === undefined || gate.startFrom.includes(ticket.status))
    return { ok: true, retry: false, startMove: moves && gate.inProgress !== undefined ? { from: ticket.status, to: gate.inProgress } : null }
  }
  const needs = gate.accepts.map((status) => `"${status}"`).join(' or ')
  const first = gate.accepts[0]!
  const refusal = `${name} is "${ticket.status}"; ${skill} needs ${needs}. "${first}" is set by ${whoMoves(first)}. No model call was made.`
  return { ok: false, message: gate.reopen === undefined ? refusal : `${refusal} ${gate.reopen}.` }
}

/** The pushes a skill makes for a run status: every push whose `pushOn` includes it (F53). */
export function pushesFor(skill: Skill, status: RunStatus): Push[] {
  return GATES[skill].pushes.filter((push) => push.pushOn.includes(status))
}

/**
 * The move a skill makes once its run ended (F12): only from its own In Progress status, only
 * when the status is in the gate's `moveOn`, and, for the implementor, only once the PR opened.
 */
export function endMove(skill: Skill, status: RunStatus, current: string, prOpened = false): { from: string; to: string } | null {
  const gate = GATES[skill]
  if (gate.success === undefined || gate.inProgress === undefined) return null
  if (gate.moveOn === undefined || !gate.moveOn.includes(status)) return null
  if (skill === 'implementor' && !prOpened) return null
  if (current !== gate.inProgress) return null
  return { from: gate.inProgress, to: gate.success }
}

/** The title as a folder slug: lower case, dashes, at most 60 characters. */
export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'ticket'
  )
}

/** The working folder name: `<id in lower case>-<slug>`. */
export function workFolderName(ticket: Pick<Ticket, 'id' | 'title'>): string {
  return `${ticket.id.toLowerCase()}-${slug(ticket.title)}`
}

/** What `ticket.md` records: the ticket's properties, the pull time, the child pages with their last edit (the first of a repeated title in `pages`, every one of it in `duplicatePages`), and the Idea. */
export type TicketRecord = Pick<Ticket, 'id' | 'title' | 'url' | 'status' | 'type' | 'priority' | 'area' | 'dev' | 'pr' | 'version' | 'idea'> & { pulledAt: string; pages: Record<string, TicketPage>; duplicatePages?: DuplicatePages }

const cell = (text: string | undefined) => (text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim()

/** ticket.md: the ticket as a table, its pages as a table, the Idea body under its heading (F5). */
export function renderTicketMd(ticket: TicketRecord): string {
  const rows: [string, string | undefined][] = [
    ['ID', ticket.id],
    ['URL', ticket.url],
    ['Status', ticket.status],
    ['Type', ticket.type],
    ['Priority', ticket.priority],
    ['Area', ticket.area.join(', ')],
    ['Dev', ticket.dev],
    ['PR', ticket.pr],
    ['Version', ticket.version],
    ['Pulled', ticket.pulledAt],
  ]
  // One row per child page: a repeated title writes every one of its pages, the first one first.
  const children = Object.values(ticket.pages).flatMap((page) => ticket.duplicatePages?.find((entry) => entry.title === page.title)?.pages ?? [page])
  const pages = children.map((page) => `| ${cell(page.title)} | ${cell(page.url)} | ${cell(page.lastEditedAt)} |`)
  return [
    `# ${ticket.id}: ${ticket.title}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${key} | ${cell(value)} |`),
    '',
    '## Pages',
    '',
    '| Title | URL | Last edited |',
    '| --- | --- | --- |',
    ...pages,
    '',
    '## Idea',
    '',
    ticket.idea.trim(),
    '',
  ].join('\n')
}

const uncell = (text: string) => text.trim().replaceAll('\\|', '|')

/** ticket.md read back. Returns null when the file is not one `renderTicketMd` wrote. */
export function parseTicketMd(text: string): TicketRecord | null {
  const title = text.match(/^# ([^:\n]+): (.*)$/m)
  if (title === null) return null
  const fields: Record<string, string> = {}
  const pages: Record<string, TicketPage> = {}
  const repeated: Record<string, TicketPage[]> = {}
  let section: 'fields' | 'pages' | 'idea' = 'fields'
  const idea: string[] = []
  for (const line of text.split('\n')) {
    if (/^## Pages\s*$/.test(line)) { section = 'pages'; continue }
    if (/^## Idea\s*$/.test(line)) { section = 'idea'; continue }
    if (section === 'idea') { idea.push(line); continue }
    const row = line.match(/^\|(.*)\|\s*$/)
    if (row === null) continue
    const cells = row[1]!.split(/(?<!\\)\|/).map(uncell)
    if (cells[0] === 'Field' || cells[0] === 'Title' || cells.every((value) => /^-+$/.test(value))) continue
    if (section === 'fields' && cells.length >= 2) fields[cells[0]!] = cells[1]!
    if (section === 'pages' && cells.length >= 3 && cells[0] !== '') {
      const url = cells[1]!
      const page = { id: pageIdFrom(url) ?? url, title: cells[0]!, url, lastEditedAt: cells[2]! }
      // First wins in pages; a later row of the same title makes it a duplicate, every row kept.
      const known = pages[page.title]
      if (known === undefined) pages[page.title] = page
      else (repeated[page.title] ??= [known]).push(page)
    }
  }
  const duplicatePages = Object.entries(repeated).map(([title, list]) => ({ title, pages: list }))
  const optional = (key: string) => (fields[key] === undefined || fields[key] === '' ? undefined : fields[key])
  return {
    id: fields.ID ?? title[1]!.trim(),
    title: title[2]!.trim(),
    url: fields.URL ?? '',
    status: fields.Status ?? '',
    type: optional('Type'),
    priority: optional('Priority'),
    area: (fields.Area ?? '').split(',').map((part) => part.trim()).filter((part) => part !== ''),
    dev: optional('Dev'),
    pr: optional('PR'),
    version: optional('Version'),
    pulledAt: fields.Pulled ?? '',
    idea: idea.join('\n').trim() === '' ? '' : `${idea.join('\n').trim()}\n`,
    pages,
    ...(duplicatePages.length === 0 ? {} : { duplicatePages }),
  }
}

export type PullDecision = 'write' | 'keep' | 'conflict'

/**
 * Whether a pulled page replaces the local file (F5). A gate row's `overwrite` pull always writes
 * (the page is the durable copy). A file the folder already has whose page has not changed since
 * the recorded pull is kept. A local file newer than its page is a conflict unless the pull is
 * forced. Everything else is written.
 */
export function pullDecision(args: { exists: boolean; localModifiedAt?: string; recordedAt?: string; pageEditedAt: string; force?: boolean; overwrite?: boolean }): PullDecision {
  if (!args.exists || args.overwrite === true) return 'write'
  if (args.recordedAt !== undefined && args.recordedAt !== '' && Date.parse(args.recordedAt) >= Date.parse(args.pageEditedAt)) return 'keep'
  if (args.force !== true && args.localModifiedAt !== undefined && Date.parse(args.localModifiedAt) > Date.parse(args.pageEditedAt)) return 'conflict'
  return 'write'
}

/** A folder under .work/ that holds a ticket.md, as the argument resolution sees it. */
export type WorkFolder = { folder: string; id: string; url: string }

export type TicketArgument =
  /** A ticket named on the command line, as a board ID or a page URL. */
  | { kind: 'ticket'; ref: string; folder?: string }
  /** No argument: the one working folder, whose ticket.md names the ticket. */
  | { kind: 'folder'; ref: string; folder: string }
  /** --no-ticket: a file path, no board. */
  | { kind: 'path'; path: string }

export class TicketArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TicketArgumentError'
  }
}

/** The first argument of every skill (F1): a ticket ID, a page URL, nothing, or a path with --no-ticket. */
export function ticketArgument(args: { positional?: string; noTicket?: boolean; workFolders: WorkFolder[]; skill: Skill }): TicketArgument {
  const positional = args.positional?.trim()
  const offersNoTicket = GATES[args.skill].noTicket !== false
  if (args.noTicket === true) {
    if (!offersNoTicket) throw new TicketArgumentError(`the ${args.skill} writes to the card; it needs a Feature Board ticket`)
    if (positional === undefined || positional === '') throw new TicketArgumentError(`--no-ticket runs ${args.skill} on a file path; give the path`)
    return { kind: 'path', path: positional }
  }
  if (positional !== undefined && positional !== '') {
    try {
      parseTicketRef(positional)
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      const hint = offersNoTicket ? ` To run ${args.skill} on a path with no board, pass --no-ticket.` : ''
      throw new TicketArgumentError(`"${positional}" is a file path, not a ticket. A ticket is a board ID such as NOM-4 or a Notion page URL.${hint}`)
    }
    const known = args.workFolders.find((folder) => sameTicket(folder, positional))
    return known === undefined ? { kind: 'ticket', ref: positional } : { kind: 'ticket', ref: positional, folder: known.folder }
  }
  if (args.workFolders.length === 1) {
    const [only] = args.workFolders
    return { kind: 'folder', ref: only!.id, folder: only!.folder }
  }
  if (args.workFolders.length === 0) {
    const hint = offersNoTicket ? ', or pass --no-ticket with a file path' : ''
    throw new TicketArgumentError(`No ticket given and no folder under ${WORK_DIR}/ holds a ${TICKET_FILE}. Name the ticket (an ID such as NOM-4, or its Notion URL)${hint}.`)
  }
  throw new TicketArgumentError(`No ticket given and ${args.workFolders.length} folders under ${WORK_DIR}/ hold a ${TICKET_FILE}: ${args.workFolders.map((folder) => folder.folder).join(', ')}. Name the ticket.`)
}

function sameTicket(folder: WorkFolder, ref: string): boolean {
  const parsed = parseTicketRef(ref)
  if (parsed.kind === 'id') {
    const own = parseTicketRef(folder.id)
    return own.kind === 'id' && own.number === parsed.number && (parsed.prefix === undefined || own.prefix === parsed.prefix)
  }
  try {
    const own = parseTicketRef(folder.url)
    return own.kind === 'url' && own.pageId === parsed.pageId
  } catch {
    return false
  }
}

/** One board action, as the --local driver lists it for the session or the flow performs it itself (F8). */
export type BoardAction =
  | { action: 'resolve'; ticket: string; board: string; write: string; folder: string; format: string; note: string }
  | { action: 'pull'; title: string; page: string; file: string; reason: string; note: string }
  | { action: 'move'; page: string; from: string; to: string; then: string }
  | { action: 'set'; page: string; name: string; value: string; then: string }
  | { action: 'push'; page: string; title: string; file: string; then: string; note?: string }
  /** Append the run marker paragraph to a page. */
  | { action: 'mark'; page: string; text: string; then: string }
  /** Delete the run marker paragraph (by its block id when known). */
  | { action: 'unmark'; page: string; text: string; blockId?: string; then: string }
  /** Replace a page's body with a file's, appending the new body before deleting the old so the page is never empty. */
  | { action: 'replace'; page: string; title: string; file: string; note: string; then: string }
  /** Write a file into the ticket page's body after a block. */
  | { action: 'write-idea'; page: string; afterBlockId: string; file: string; then: string }
  /** Read the Feature Board rules page into a file, so the driver can check what BOARD-003 allows (KIT-19). */
  | { action: 'read'; target: 'board-rules'; file: string; note: string }
  /** Attach a run's telemetry file to the end of the ticket page body as one file block, only when the saved rules carry every string of `onlyIf` (KIT-19). */
  | { action: 'attach'; page: string; file: string; name: string; onlyIf: string[]; note: string }

/** One board action as recorded in the run's trace, with the Status before and after it. `check` records a gate check that made no board write. */
export type BoardTraceEntry = { at: string; action: BoardAction['action'] | 'check'; detail: string; statusBefore: string; statusAfter: string; ok: boolean; error?: string }

/** The attach of a run's telemetry file as the trace records it: the file name and the block id or the reason it was not attached, never an upload or download URL (KIT-19). */
export type BoardTraceTelemetry = { file: string; blockId?: string; error?: string }

/** The trace a run keeps of its board work: `trace/board.json`. */
export type BoardTrace = {
  skill: Skill
  ticket: { id: string; title: string; url: string } | null
  folder: string | null
  statusBefore: string | null
  statusAfter: string | null
  expected?: string | null
  pushing?: string[]
  pushed: { title: string; url: string }[]
  actions: BoardTraceEntry[]
  verified?: boolean
  telemetry?: BoardTraceTelemetry
}

/** The report's first lines (F10): the ticket, the moves, the pages pushed, the working folder. */
export function reportHeader(trace: BoardTrace): string[] {
  if (trace.ticket === null) return ['Ticket: none (--no-ticket)']
  const moves = trace.actions.filter((entry) => entry.action === 'move' && entry.ok).map((entry) => `${entry.statusBefore} -> ${entry.statusAfter}`)
  const pushed = trace.pushed.map((page) => `${page.title} (${page.url})`)
  return [
    `Ticket: ${trace.ticket.id} ${trace.ticket.title} (${trace.ticket.url})`,
    `Status: ${trace.statusBefore ?? '?'} -> ${trace.statusAfter ?? trace.statusBefore ?? '?'}${moves.length === 0 ? ' (no move)' : ''}`,
    `Pages pushed: ${pushed.length === 0 ? 'none' : pushed.join(', ')}`,
    `Working folder: ${trace.folder ?? 'none'}`,
  ]
}

/** The ticket.md the session writes at the resolve step, with placeholders, so the layout is given not guessed. */
export function ticketMdFormat(): string {
  const [title = '', ...rest] = renderTicketMd({
    id: '<ID, such as NOM-4>',
    title: '<title>',
    url: '<the ticket page URL>',
    status: '<Status, exactly as the board shows it>',
    type: '<Type>',
    priority: '<Priority>',
    area: ['<Area, comma separated>'],
    dev: '<Dev>',
    pr: '<PR URL, or empty>',
    version: '<Version, or empty>',
    pulledAt: '<ISO time of this pull>',
    idea: '<the Idea section of the ticket page as plain markdown, or the whole body when it has no Idea heading>',
    pages: { '<child page title>': { id: '', title: '<child page title>', url: '<child page URL>', lastEditedAt: '<its last edited time, ISO>' } },
  }).split('\n')
  const rules = [
    'The Pages table lists every child page, one row each, even when two share a title.',
    "The Type cell is the card's Type select value or is left blank.",
    'The Idea is the ticket page body from the `## Idea` heading to the next heading of level 2 or shallower, keeping `###` subsections, or the whole body with its heading levels unchanged when there is no Idea heading.',
    'Do not write a partial ticket.md: stop and say so when the page fetch is truncated.',
  ]
  return [title, '', rules.join(' '), ...rest].join('\n')
}
