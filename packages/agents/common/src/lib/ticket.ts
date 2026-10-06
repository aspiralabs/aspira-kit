// The ticket flow, pure: which Status each skill needs and which moves it makes, how a ticket's
// pages map onto the working folder, how `ticket.md` is written and read back, when a pulled file
// is left alone or refused, and how the ticket argument of a skill resolves. No node imports, so
// every rule here is unit tested without a repository or a board. `ticket-flow.ts` does the file
// system and board work on top of it.

import { BoardError, parseTicketRef, type Ticket, type TicketPage } from './board.ts'
import { pageIdFrom } from './knowledge.ts'

export const SKILLS = ['spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const
export type Skill = (typeof SKILLS)[number]

/** The folder under the repository root that holds one working folder per ticket. */
export const WORK_DIR = '.work'
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

/** One page a skill pushes on success: its fixed title and the file in the working folder it comes from. */
export type Push = { title: string; file: string; when?: 'needs-author' }

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
  /** The file in the working folder the skill takes as its input, when it takes one. */
  input?: string
}

export const GATES: Record<Skill, Gate> = {
  'spec-writer': { accepts: ['Ready: Idea'], inProgress: 'In Progress: Spec', success: 'In Review: Spec', pushes: [{ title: 'Spec', file: 'spec.md' }], input: IDEA_FILE },
  'spec-reviewer': {
    accepts: ['In Review: Spec'],
    pushes: [
      { title: 'Spec Reviewed', file: 'spec.reviewed/spec.reviewed.md' },
      { title: 'Spec Review Decisions', file: 'spec.reviewed/trace/decisions.md', when: 'needs-author' },
    ],
    input: 'spec.md',
  },
  planner: { accepts: ['Ready: Spec'], inProgress: 'In Progress: Plan', success: 'In Review: Plan', pushes: [{ title: 'Plan', file: 'plan.review/plan.reviewed.md' }], input: 'spec.reviewed/spec.reviewed.md' },
  implementor: {
    accepts: ['Ready: Plan'],
    inProgress: 'In Progress: Implementation',
    success: 'In Review: Implementation',
    pushes: [{ title: 'Implementation', file: 'plan.review/implementation.md' }],
    input: 'plan.review/plan.reviewed.md',
  },
  'code-analyzer': { accepts: ['In Progress: Implementation', 'In Review: Implementation'], pushes: [] },
  'pr-reviewer': { accepts: ['In Review: Implementation'], requires: 'PR', pushes: [{ title: 'PR Review', file: 'pr-review/review.md' }] },
}

/** Who moves a card into a Status, for a refusal message. A human owns every Ready column (BOARD-004). */
export function whoMoves(status: string): string {
  const moves: Record<string, string> = {
    'Ready: Idea': 'a human, after grooming the idea',
    'Ready: Spec': 'a human, after approving the spec',
    'Ready: Plan': 'a human, after approving the plan',
    'Ready: Implementation': 'a human, after merging the PR',
    'In Progress: Spec': 'the spec writer, when it claims the ticket',
    'In Review: Spec': 'the spec writer, when the spec is on the ticket',
    'In Progress: Plan': 'the planner, when it claims the ticket',
    'In Review: Plan': 'the planner, when the plan is on the ticket',
    'In Progress: Implementation': 'the implementor, when it claims the ticket',
    'In Review: Implementation': 'the implementor, when the PR is open and set on the ticket',
    Released: 'a human, when the release is cut',
  }
  return moves[status] ?? 'a human'
}

export type GateCheck =
  | { ok: true; retry: boolean; startMove: { from: string; to: string } | null }
  | { ok: false; message: string }

/** The gate: may this skill run on a ticket in this Status, and does it make a start move. */
export function checkGate(skill: Skill, ticket: Pick<Ticket, 'id' | 'title' | 'status' | 'pr'>): GateCheck {
  const gate = GATES[skill]
  const name = `${ticket.id} ${ticket.title}`.trim()
  if (gate.inProgress !== undefined && ticket.status === gate.inProgress) return { ok: true, retry: true, startMove: null }
  if (gate.accepts.includes(ticket.status)) {
    if (gate.requires === 'PR' && !ticket.pr) {
      return { ok: false, message: `${name} is "${ticket.status}" but its PR property is not set; ${skill} needs the PR. Set it (the implementor does, when it opens the PR). No model call was made.` }
    }
    return { ok: true, retry: false, startMove: gate.inProgress === undefined ? null : { from: ticket.status, to: gate.inProgress } }
  }
  const needs = gate.accepts.map((status) => `"${status}"`).join(' or ')
  const first = gate.accepts[0]!
  return { ok: false, message: `${name} is "${ticket.status}"; ${skill} needs ${needs}. "${first}" is set by ${whoMoves(first)}. No model call was made.` }
}

/** The pushes a skill makes for a run status: every success push, plus the ones the status asks for. */
export function pushesFor(skill: Skill, runStatus: string): Push[] {
  return GATES[skill].pushes.filter((push) => push.when === undefined || push.when === runStatus)
}

/** The moves a skill makes once its run ended. `prOpened` is the implementor's condition for its success move. */
export function endMove(skill: Skill, ok: boolean, current: string, prOpened = false): { from: string; to: string } | null {
  const gate = GATES[skill]
  if (!ok || gate.success === undefined || gate.inProgress === undefined) return null
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

/** What `ticket.md` records: the ticket's properties, the pull time, the child pages with their last edit, and the Idea. */
export type TicketRecord = Pick<Ticket, 'id' | 'title' | 'url' | 'status' | 'type' | 'priority' | 'area' | 'dev' | 'pr' | 'version' | 'idea'> & { pulledAt: string; pages: Record<string, TicketPage> }

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
  const pages = Object.values(ticket.pages).map((page) => `| ${cell(page.title)} | ${cell(page.url)} | ${cell(page.lastEditedAt)} |`)
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
      pages[cells[0]!] = { id: pageIdFrom(url) ?? url, title: cells[0]!, url, lastEditedAt: cells[2]! }
    }
  }
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
  }
}

export type PullDecision = 'write' | 'keep' | 'conflict'

/**
 * Whether a pulled page replaces the local file (F5). A file the folder already has whose page has
 * not changed since the recorded pull is kept. A local file newer than its page is a conflict
 * unless the pull is forced. Everything else is written.
 */
export function pullDecision(args: { exists: boolean; localModifiedAt?: string; recordedAt?: string; pageEditedAt: string; force?: boolean }): PullDecision {
  if (!args.exists) return 'write'
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
  if (args.noTicket === true) {
    if (positional === undefined || positional === '') throw new TicketArgumentError(`--no-ticket runs ${args.skill} on a file path; give the path`)
    return { kind: 'path', path: positional }
  }
  if (positional !== undefined && positional !== '') {
    try {
      parseTicketRef(positional)
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      throw new TicketArgumentError(`"${positional}" is a file path, not a ticket. A ticket is a board ID such as NOM-4 or a Notion page URL. To run ${args.skill} on a path with no board, pass --no-ticket.`)
    }
    const known = args.workFolders.find((folder) => sameTicket(folder, positional))
    return known === undefined ? { kind: 'ticket', ref: positional } : { kind: 'ticket', ref: positional, folder: known.folder }
  }
  if (args.workFolders.length === 1) {
    const [only] = args.workFolders
    return { kind: 'folder', ref: only!.id, folder: only!.folder }
  }
  if (args.workFolders.length === 0) throw new TicketArgumentError(`No ticket given and no folder under ${WORK_DIR}/ holds a ${TICKET_FILE}. Name the ticket (an ID such as NOM-4, or its Notion URL), or pass --no-ticket with a file path.`)
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
  | { action: 'push'; page: string; title: string; file: string; then: string }

/** One board action as recorded in the run's trace, with the Status before and after it. */
export type BoardTraceEntry = { at: string; action: BoardAction['action']; detail: string; statusBefore: string; statusAfter: string; ok: boolean; error?: string }

/** The trace a run keeps of its board work: `trace/board.json`. */
export type BoardTrace = { skill: Skill; ticket: { id: string; title: string; url: string } | null; folder: string | null; statusBefore: string | null; statusAfter: string | null; expected?: string | null; pushing?: string[]; pushed: { title: string; url: string }[]; actions: BoardTraceEntry[]; verified?: boolean }

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
  return renderTicketMd({
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
  })
}
