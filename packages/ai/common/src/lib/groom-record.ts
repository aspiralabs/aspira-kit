// The groomer's run record (`groom/trace/groom.json`): the decisions with their state, the design
// tree's branches, the round and the run status. The Grooming Decisions page is the durable copy;
// this file is a cache that is rebuilt from the page whenever it is missing. Also the validator the
// driver runs on the Idea summary before it writes anything to the card.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { compareIds, normalizeQuestion, parseDecisionsList, readGroomPage, RECOMMENDED_SUFFIX } from './decisions.ts'
import { LENSES } from './lenses.ts'
import { allowedPath } from './repository.ts'
import { readRunStatus, REASON_CODES, type ReasonCode, type RunStatus } from './run-status.ts'

/** The line the Idea summary opens with, and the text a later run finds it by. */
export const GROOMER_MARKER_PREFIX = 'Groomed with /aspira-groomer on '

/** The groomer's run status: one of the five new words (ready, needs-author, incomplete, refused, blocked). Moved to `run-status.ts`; kept here as an alias since most of this file's own callers already import it from `./groom-record.ts`. */
export type GroomRunStatus = RunStatus

/** One branch per Grooming exit criterion, per spec template section and per spec-reviewer lens. */
export const GROOM_BRANCHES = ['problem', 'who', 'done', 'intent', 'f-list', 'tests', 'constraints', 'out-of-scope', 'blast-radius', ...LENSES] as const

/** Prefixes a quoted line may not start with: each is a line the page parser reads. */
const GROOM_LINE_PREFIXES = ['#', '- [', 'Run:', 'Decided by', 'Taken by the agent', 'Confirmed', 'Confirm was', 'Branch:', 'Fact:', 'Two ticks', 'Two new ticks', 'Why it is yours']

const singleLine = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes('\n'), 'must be one line')
  .refine((value) => !['#', '- [', 'Run:'].some((prefix) => value.startsWith(prefix)), 'must not start like a page line')

/** A fact from the repository a question rests on. */
export const factSchema = z.object({
  path: z.string().min(1).refine(allowedPath, 'not a path the repository tools read'),
  line: z.number().int().positive(),
  quote: z
    .string()
    .max(200)
    .refine((value) => !value.includes('\n') && !value.includes('`'), 'one line, no backticks')
    .refine((value) => !GROOM_LINE_PREFIXES.some((prefix) => value.startsWith(prefix)), 'must not start like a Grooming Decisions line')
    .optional(),
})
export type Fact = z.infer<typeof factSchema>

/**
 * A groomer question. The decision fields of `decisionSchema` (which stays as it is), plus the
 * `Q<n>` id, the branch, the facts, who decided and the flags the page shows.
 */
/** A sentence without its closing full stop: the Decisions line adds its own after the answer and the reasoning. */
export const withoutFullStop = (text: string): string => text.trim().replace(/\.$/, '')

export const groomDecisionSchema = z
  .object({
    id: z.string().regex(/^Q\d+(\.\d+)?$/, 'groomer ids are Q<n> or Q<n>.<m>'),
    question: singleLine,
    options: z.array(singleLine).min(1),
    recommended: singleLine,
    // The summary line closes the reasoning with its own full stop (`Why: <reasoning>.`), so one the
    // model ends it with would not survive the round trip (REBA1.1).
    reasoning: singleLine.transform(withoutFullStop),
    whyYours: singleLine,
    branch: z.string().min(1),
    facts: z.array(factSchema),
    decidedBy: z.enum(['open', 'author', 'agent']),
    answer: z.string().nullable(),
    revisedAt: z.string().optional(),
    tickedBy: z.union([z.object({ kind: z.literal('notion'), id: z.string() }), z.object({ kind: z.literal('session') })]).optional(),
    prerequisites: z.array(z.string()).optional(),
    flag: z.enum(['twoTicks', 'twoNewTicks']).optional(),
  })
  .superRefine((decision, ctx) => {
    if (!decision.options.includes(decision.recommended)) ctx.addIssue({ code: 'custom', path: ['recommended'], message: 'recommended must be one of the options' })
    if (decision.decidedBy === 'open' && decision.options.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'an open question needs at least two options' })
    const normalized = decision.options.map(normalizeQuestion)
    if (normalized.some((option) => option === '')) ctx.addIssue({ code: 'custom', path: ['options'], message: 'an option needs words' })
    if (new Set(normalized).size !== normalized.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'options must differ by more than punctuation or case' })
    for (const option of decision.options) {
      if (option.endsWith('.') || option.includes('(revised') || option.includes('. Why:')) ctx.addIssue({ code: 'custom', path: ['options'], message: `option "${option}" would make the Decided line ambiguous` })
    }
  })
export type GroomDecision = z.infer<typeof groomDecisionSchema>

const branchSchema = z.object({ id: z.string().min(1), state: z.enum(['open', 'visited', 'closed']), reason: z.string().optional() })

const groomRecordShape = z.object({
  decisions: z.array(groomDecisionSchema).refine((decisions) => new Set(decisions.map((decision) => decision.id)).size === decisions.length, 'each question id appears once'),
  branches: z.array(branchSchema),
  round: z.number().int().nonnegative(),
  startedAt: z.string(),
  open: z.number().int().nonnegative(),
  page: z.object({ id: z.string().optional(), url: z.string().optional() }),
  /** Any run status word, old or new (readRunStatus maps it); an unknown word fails the parse below. */
  status: z.string(),
  /** The one reason sentence a non-ready report shows; null when the status needs none, or an old record never recorded one. */
  reason: z.string().nullable().optional(),
  /** Which sub-case of the status this is (a groomer round paused by Stop); null when the status carries none. An old record derives it from its status word alone. Checked against REASON_CODES in the transform below, not here (module-load-time use of run-status.ts's values would deadlock the import cycle between the two files). */
  reasonCode: z.string().nullable().optional(),
  reportedStatus: z.string().optional(),
  markerBlockId: z.string().optional(),
  ideaBlocks: z.array(z.string()).optional(),
  facts: z.array(factSchema).optional(),
  searched: z.array(z.string()).optional(),
})

/**
 * `groomRecordShape` with `status` read through `readRunStatus` (F7): the five new words as
 * themselves, run-status.ts's old per-skill words mapped onto one, anything else failing the
 * parse. `reasonCode` defaults to the word's own mapped reason code when the record does not carry
 * one of its own (an old record read for the first time); an explicit `reasonCode` (a fresh write)
 * is kept as written. `reason` defaults to null.
 */
export const groomRecordSchema = groomRecordShape.transform((value, ctx) => {
  const read = readRunStatus(value.status)
  if (read === null) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: `"${value.status}" is not a known run status` })
    return z.NEVER
  }
  const reasonCode = value.reasonCode ?? read.reasonCode
  if (reasonCode !== null && !(REASON_CODES as readonly string[]).includes(reasonCode)) {
    ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: `"${reasonCode}" is not a known reason code` })
    return z.NEVER
  }
  return { ...value, status: read.status, reasonCode: reasonCode as ReasonCode | null, reason: value.reason ?? null }
})
export type GroomRecord = z.infer<typeof groomRecordSchema>

const recordFile = (folder: string) => join(folder, 'groom', 'trace', 'groom.json')

/** groom.json in a working folder, or undefined when there is none. Throws when it does not match the schema. */
export async function readGroomRecord(folder: string): Promise<GroomRecord | undefined> {
  const text = await readFile(recordFile(folder), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return text === undefined ? undefined : groomRecordSchema.parse(JSON.parse(text))
}

export async function writeGroomRecord(folder: string, record: GroomRecord): Promise<void> {
  const file = recordFile(folder)
  await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
  await writeFile(file, `${JSON.stringify(groomRecordSchema.parse(record), null, 2)}\n`)
}

/** The record a page holds: the cache a run rebuilds when groom.json is missing. */
export function rebuildGroomRecord(pageMarkdown: string): { record: GroomRecord; nextId: string } {
  const read = readGroomPage(pageMarkdown)
  const decisions: GroomDecision[] = read.questions.map((block) => {
    const options = block.todos.map((todo) => todo.text.replace(RECOMMENDED_SUFFIX, '').trim())
    const recommendedTodo = block.todos.find((todo) => RECOMMENDED_SUFFIX.test(todo.text))
    const recommended = recommendedTodo === undefined ? (options[0] ?? '') : recommendedTodo.text.replace(RECOMMENDED_SUFFIX, '').trim()
    const reasoning = recommendedTodo?.text.match(/[_*]\(recommended: (.*)\)[_*]\s*$/)?.[1] ?? ''
    const answerIndex = block.decided === undefined ? -1 : options.findIndex((option) => normalizeQuestion(option) === normalizeQuestion(block.decided!.answer))
    return {
      id: block.id,
      question: block.question,
      options,
      recommended,
      reasoning,
      whyYours: block.whyYours ?? '',
      branch: block.branch ?? 'problem',
      facts: block.facts,
      decidedBy: block.decided !== undefined ? 'author' : block.taken !== undefined ? 'agent' : 'open',
      answer: block.decided !== undefined ? (answerIndex === -1 ? block.decided.answer : options[answerIndex]!) : block.taken !== undefined ? recommended : null,
      ...(block.decided?.revisedAt !== undefined ? { revisedAt: block.decided.revisedAt } : {}),
    }
  })
  const tagged = new Set(decisions.map((decision) => decision.branch))
  const branches = read.trailer?.branches ?? GROOM_BRANCHES.map((id) => ({ id, state: tagged.has(id) ? ('visited' as const) : ('open' as const) }))
  const top = Math.max(0, ...decisions.map((decision) => Number(decision.id.slice(1).split('.')[0])))
  const open = decisions.filter((decision) => decision.decidedBy === 'open').length
  const isConfirmed = (read.confirm ?? []).some((todo) => todo.checked)
  const isStopped = (read.stop ?? []).some((todo) => todo.checked)
  const record: GroomRecord = {
    decisions: decisions.sort((a, b) => compareIds(a.id, b.id)),
    branches,
    round: read.trailer?.round ?? 0,
    startedAt: read.trailer?.written ?? '',
    open,
    page: {},
    status: isConfirmed ? 'ready' : 'needs-author',
    reasonCode: isConfirmed ? null : isStopped ? 'paused' : null,
    reason: isConfirmed ? null : isStopped ? 'Stop grooming was ticked on the Grooming Decisions page' : `${open} decision${open === 1 ? '' : 's'} still open on the Grooming Decisions page`,
  }
  return { record, nextId: `Q${top + 1}` }
}

/**
 * The groomed `### Decisions` list that sits under the groomer's marker paragraph in an Idea; a
 * hand-written list is not read. Every reader of a card's decisions (the groomer's rebuild, the spec
 * writer) goes through here, so only a groomed list is ever treated as settled.
 */
export function markedDecisions(ideaMarkdown: string): string | null {
  const lines = ideaMarkdown.split('\n')
  const marker = lines.findIndex((line) => line.startsWith(GROOMER_MARKER_PREFIX))
  if (marker === -1) return null
  const heading = lines.findIndex((line, index) => index > marker && line.trim() !== '')
  if (heading === -1 || lines[heading]!.trim() !== '### Decisions') return null
  const end = lines.findIndex((line, index) => index > heading && /^#{1,6} /.test(line))
  return lines.slice(heading + 1, end === -1 ? undefined : end).join('\n')
}

/** The decisions an Idea summary records, as author decisions with the answer as their only option. */
export function seedFromIdeaDecisions(ideaMarkdown: string): GroomDecision[] {
  const list = markedDecisions(ideaMarkdown)
  if (list === null) return []
  return parseDecisionsList(list).items.flatMap((item): GroomDecision[] =>
    item.question === undefined || item.answer === undefined
      ? []
      : [{ id: item.id, question: item.question, options: [item.answer], recommended: item.answer, reasoning: item.reasoning ?? '', whyYours: 'rebuilt from the Idea', branch: 'problem', facts: [], decidedBy: 'author', answer: item.answer }],
  )
}

export type IdeaSummaryCheck = { ok: true } | { ok: false; reason: string }

/**
 * The Idea summary the model composed, checked against groom.json before the driver writes it:
 * the marker, one item per confirmed decision with its recorded answer and reasoning, the Terms
 * (or `None introduced.`), and nothing else.
 */
export function validateIdeaSummary(summary: string, record: GroomRecord): IdeaSummaryCheck {
  const lines = summary.split('\n').filter((line) => line.trim() !== '')
  const refuse = (reason: string): IdeaSummaryCheck => ({ ok: false, reason })
  if (!(lines[0] ?? '').startsWith(GROOMER_MARKER_PREFIX)) return refuse(`the summary must open with the marker paragraph "${GROOMER_MARKER_PREFIX}<date>"`)
  if (lines[1] !== '### Decisions') return refuse(`unexpected block after the marker: ${lines[1] ?? '(nothing)'}`)
  const terms = lines.indexOf('### Terms')
  if (terms === -1) return refuse('the summary has no ### Terms heading')
  const decisionLines = lines.slice(2, terms)
  // A Confirm confirms every decided question: the author's answers and the ones taken as recommended (KIT-25). Only an open one is not a decision.
  const confirmed = new Map(record.decisions.filter((decision) => decision.decidedBy !== 'open').map((decision) => [decision.id, decision]))
  const listed = new Set<string>()
  for (const line of decisionLines) {
    const parsed = parseDecisionsList(line)
    const item = parsed.items[0]
    if (item === undefined || !item.id.startsWith('Q') || parsed.unparsed.length > 0) return refuse(`unexpected block in Decisions: ${line}`)
    const decision = confirmed.get(item.id)
    if (decision === undefined) return refuse(`${item.id} is not a confirmed decision in groom.json`)
    if (withoutFullStop(item.answer ?? '') !== withoutFullStop(decision.answer ?? '')) return refuse(`${item.id}: the answer differs from the recorded one`)
    if (withoutFullStop(item.reasoning ?? '') !== withoutFullStop(decision.reasoning)) return refuse(`${item.id}: the reasoning differs from the recorded one`)
    if (listed.has(item.id)) return refuse(`${item.id} is listed twice`)
    listed.add(item.id)
  }
  const missing = [...confirmed.keys()].filter((id) => !listed.has(id))
  if (missing.length > 0) return refuse(`confirmed decisions missing from the summary: ${missing.join(', ')}`)
  const termLines = lines.slice(terms + 1)
  if (termLines.length === 0) return refuse('### Terms needs entries or "None introduced."')
  if (termLines.length === 1 && termLines[0] === 'None introduced.') return { ok: true }
  for (const raw of termLines) {
    // An `_Avoid_:` line written indented under its term (a markdown continuation) is the same line (KIT-26).
    const line = raw.trimStart()
    if (/^_Avoid_: /.test(line)) continue
    if (!/^- \*\*[^*]+\*\*: \S/.test(line)) return refuse(`unexpected block in Terms: ${line}`)
    if (/\[[^\]]*\]\([^)]*\)|https?:\/\/|<mention|`/.test(line)) return refuse(`a Terms entry carries a link, URL, mention or code: ${line.slice(0, 80)}`)
    if (line.length > 300) return refuse(`a Terms entry is longer than 300 characters: ${line.slice(0, 40)}…`)
  }
  return { ok: true }
}

/** The one line a run report says about the Idea summary check. */
export const renderIdeaSummaryCheck = (check: IdeaSummaryCheck): string => (check.ok ? 'Idea summary: validated against groom.json' : `Idea summary refused: ${check.reason}`)
