// Open decisions, shared by every agent that leaves one to a human (specs/agents-human-lists.md
// F3, F4): the shape a model must produce, the checkbox rendering the author ticks, the parser
// that reads the tick back on the next run, and the record that says who decided.

import { z } from 'zod'
import type { GroomDecision, GroomRecord } from './groom-record.ts'

const text = z.string().trim().min(1)

/** What an agent must say about every decision it leaves open. */
export const decisionSchema = z
  .object({
    /** The question, in one sentence. */
    question: text,
    /** The options, at least two, each a short phrase the author can tick. */
    options: z.array(text).min(2),
    /** One of the options. */
    recommended: text,
    /** One sentence: why the recommended option. */
    reasoning: text,
    /** One sentence: why the author, not the agent, decides this. */
    whyYours: text,
  })
  .refine((decision) => decision.options.includes(decision.recommended), { path: ['recommended'], message: 'recommended must be one of the options' })
export type Decision = z.infer<typeof decisionSchema>

/** The rule, stated once; every prompt that asks for decisions quotes it. */
export const DECISION_RULE =
  'every decision left to the author is written as: the question in one sentence; the options (at least two); recommended, one of the options, with reasoning in one sentence; and whyYours, one sentence on why it is the author\'s call and not the agent\'s'

/** open: nobody has answered. author: the author ticked an option. agent: the agent took the recommended option to keep going. */
export type DecidedBy = 'open' | 'author' | 'agent'

/** A decision as review.json records it. */
export type DecisionRecord = Decision & { id: string; decidedBy: DecidedBy; answer: string | null }

/** The recommended option first, then the rest in the order given. */
export const orderedOptions = (decision: Decision): string[] => [decision.recommended, ...decision.options.filter((option) => option !== decision.recommended)]

/** Questions compare by their words, not their punctuation or case. */
export const normalizeQuestion = (question: string): string => question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The recommended note after an option, as written (`_(…)_`) or as Notion hands it back (`*(…)*`). */
export const RECOMMENDED_SUFFIX = /\s*[_*]\((?:recommended|recommended, taken by the agent): .*\)[_*]\s*$/

/** The rule every downstream prompt quotes for a spec that carries the groomed `## Decisions`. Its carve-out keeps a
 * groomed answer from waiving a MUST guideline rule (review finding IRIS1.1). */
export const SETTLED_DECISIONS_RULE =
  "The items under the spec's ## Decisions section were decided by the author: treat each as settled input, and never re-raise one as an assumption, a question, a finding or a decision. The one exception: an item that contradicts a MUST rule in the required guidelines, or the rule to reuse @aspiralabs/ui components, is still a finding, citing the rule's ID and the item's ID; a settled decision never waives a mandatory rule."

/** The checkbox form of one decision: the author ticks an option in the file. */
export function renderDecision(decision: DecisionRecord): string {
  const ticked = decision.decidedBy === 'open' ? null : (decision.answer ?? decision.recommended)
  const taken = decision.decidedBy === 'agent' ? 'recommended, taken by the agent' : 'recommended'
  const lines = [`## ${decision.id} — ${decision.question}`, '']
  if (decision.decidedBy === 'author') lines.push(`Decided by the author: ${decision.answer ?? decision.recommended}.`, '')
  if (decision.decidedBy === 'agent') lines.push(`Taken by the agent to keep going: ${decision.recommended}. Tick another option to reverse it.`, '')
  for (const option of orderedOptions(decision)) {
    const mark = option === ticked ? 'x' : ' '
    lines.push(`- [${mark}] ${option}${option === decision.recommended ? ` _(${taken}: ${decision.reasoning})_` : ''}`)
  }
  lines.push('', `Why it is yours to decide: ${decision.whyYours}`)
  return lines.join('\n')
}

/** The decisions file: a header with the counts, then one checkbox block per decision. */
export function renderDecisions(decisions: readonly DecisionRecord[], options: { title?: string; status?: string; intro?: string } = {}): string {
  const open = decisions.filter((decision) => decision.decidedBy === 'open').length
  const lines = [`# ${options.title ?? 'Decisions'}`, '']
  if (options.status !== undefined) lines.push(`Status: ${options.status}`, '')
  lines.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'}: ${open} open · ${decisions.length - open} answered`, '')
  if (decisions.length > 0) lines.push(options.intro ?? 'Tick one option per decision to answer it; the next run of this stage reads the tick and records it as your decision.', '')
  for (const decision of decisions) lines.push(renderDecision(decision), '')
  return lines.join('\n')
}

/** An answer the author ticked in a decisions file. `takenByAgent`: the ticked option was still the
 * one the agent itself took (its `(recommended, taken by the agent: ...)` suffix), so this is the
 * agent's own tick, not a real answer from the author. */
export type Answer = { id: string; question: string; answer: string; takenByAgent?: boolean }

/** The suffix that marks a ticked option as the agent's own recommended pick, not the author's tick. */
const TAKEN_BY_AGENT_SUFFIX = /[_*]\(recommended, taken by the agent:/

/** The decisions with exactly one ticked option. Two ticks under one question is no answer. */
export function parseTickedDecisions(markdown: string): Answer[] {
  const answers: Answer[] = []
  let current: { id: string; question: string; ticked: { text: string; takenByAgent: boolean }[] } | null = null
  const flush = () => {
    if (current !== null && current.ticked.length === 1) {
      const only = current.ticked[0]!
      answers.push({ id: current.id, question: current.question, answer: only.text, ...(only.takenByAgent ? { takenByAgent: true } : {}) })
    }
  }
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^## (\S+) — (.+)$/)
    if (heading !== null) {
      flush()
      current = { id: heading[1]!, question: heading[2]!.trim(), ticked: [] }
      continue
    }
    const tick = line.match(/^- \[[xX]\] (.+)$/)
    if (tick !== null && current !== null) current.ticked.push({ text: tick[1]!.replace(RECOMMENDED_SUFFIX, '').trim(), takenByAgent: TAKEN_BY_AGENT_SUFFIX.test(tick[1]!) })
  }
  flush()
  return answers
}

/**
 * An open decision whose question the author answered becomes the author's; the agent's own tick
 * on an open decision is never read as the author's (F10). An agent decision whose tick still sits
 * on the recommended option stays the agent's; ticking a different option overrides it to the
 * author's (F19). An author decision is never moved.
 */
export function applyAnswers<T extends DecisionRecord>(decisions: readonly T[], answers: readonly Answer[]): T[] {
  const byQuestion = new Map(answers.map((answer) => [normalizeQuestion(answer.question), answer]))
  return decisions.map((decision) => {
    const found = byQuestion.get(normalizeQuestion(decision.question))
    if (decision.decidedBy === 'open') {
      if (found === undefined || found.takenByAgent === true) return decision
      return { ...decision, decidedBy: 'author' as const, answer: found.answer }
    }
    if (decision.decidedBy === 'agent' && found !== undefined && found.answer !== decision.answer) return { ...decision, decidedBy: 'author' as const, answer: found.answer }
    return decision
  })
}

/** The open decisions: what still needs the author. */
export const openDecisions = <T extends DecisionRecord>(decisions: readonly T[]): T[] => decisions.filter((decision) => decision.decidedBy === 'open')

/** A decision an agent settled itself: the recommended option, already taken. */
export const takenDecision = (id: string, decision: Decision): DecisionRecord => ({ ...decision, id, decidedBy: 'agent', answer: decision.recommended })

// ---------------------------------------------------------------------------------------------
// Grooming Decisions: the groomer's living record on the card (KIT-8). The page is the only
// durable copy of the interview, so everything the next run needs is readable from it, and the
// parser reads only the lines the groomer writes: everything else a person adds is carried to
// the Notes block, never read as an answer.
// ---------------------------------------------------------------------------------------------

const GROOM_TITLE = '# Grooming Decisions'
const GROOM_INTRO =
  'Tick one option per question. Only ticks are read as answers: anything else you write on this page is kept under the Notes block at the end and never read as an answer. Ticks made while a run is writing (the "Run: ... in progress" line is present) may need to be made again.'

/** Every line the groomer writes, so a line that matches none of them is a person's. */
export const GROOM_LINE_PATTERNS = {
  title: /^# Grooming Decisions$/,
  intro: /^Tick one option per question\. Only ticks are read as answers: /,
  rebuilt: /^Rebuilt from the Idea's Decisions list on \d{4}-\d{2}-\d{2}; the previous page was not found$/,
  run: /^Run: \S+ \S+ in progress$/,
  heading: /^## (\S+) — (.+)$/,
  branch: /^Branch: (\S+)$/,
  fact: /^Fact: (.+?):(\d+)(?: — `([^`]*)`)?$/,
  twoTicks: /^Two ticks on \d{4}-\d{2}-\d{2}; tick one to answer$/,
  twoNewTicks: /^Two new ticks on \d{4}-\d{2}-\d{2}; tick one to revise$/,
  decided: /^Decided by the author: (.+?)(?: \(revised (\d{4}-\d{2}-\d{2})\))?\.$/,
  taken: /^Taken by the agent to keep going: (.+?)\. Tick another option to reverse it\.$/,
  todo: /^- \[([ xX])\] (.*)$/,
  why: /^Why it is yours to decide: (.+)$/,
  confirmed: /^Confirmed \d{4}-\d{2}-\d{2}$/,
  confirmUnticked: /^Confirm was unticked on \d{4}-\d{2}-\d{2}; tick it again to re-confirm$/,
  notes: /^## Notes$/,
  trailer: /^Round (\d+) · written (\S+) · (\d+) open(?: · branches: (.*?))?(?: · options: (.*))?$/,
} as const

/** Ids compare by each dotted number: Q1, Q1.2, Q1.10, Q2, Q10. A parent sorts before its follow-ups. */
export function compareIds(a: string, b: string): number {
  const parts = (id: string) => (id.match(/\d+/g) ?? []).map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p !== q) return p - q
  }
  return a.localeCompare(b)
}

/** The option of a decision a text names, compared as questions are: by words, not punctuation. */
const optionIndex = (options: readonly string[], text: string): number => options.findIndex((option) => normalizeQuestion(option) === normalizeQuestion(text))

/**
 * Ticks read from the page, applied by id (never by wording) to open questions only. A question
 * with two or more ticks stays open and is flagged so the page asks for one tick.
 */
export function applyAnswersById<T extends GroomDecision>(decisions: readonly T[], answers: readonly Answer[], twoTicks: readonly string[] = []): T[] {
  const byId = new Map(answers.map((answer) => [answer.id, answer.answer]))
  return decisions.map((decision) => {
    if (decision.decidedBy === 'agent') {
      if (twoTicks.includes(decision.id)) return { ...decision, flag: 'twoTicks' as const }
      const answer = byId.get(decision.id)
      if (answer === undefined || normalizeQuestion(answer) === normalizeQuestion(decision.recommended)) return decision
      const { flag: _flag, ...rest } = decision
      const index = optionIndex(decision.options, answer)
      return { ...rest, decidedBy: 'author' as const, answer: index === -1 ? answer : decision.options[index]! } as T
    }
    if (decision.decidedBy !== 'open') return decision
    if (twoTicks.includes(decision.id)) return { ...decision, flag: 'twoTicks' as const }
    const answer = byId.get(decision.id)
    if (answer === undefined) return decision
    const { flag: _flag, ...rest } = decision
    const index = optionIndex(decision.options, answer)
    return { ...rest, decidedBy: 'author' as const, answer: index === -1 ? answer : decision.options[index]! } as T
  })
}

/** The option positions ticked under each readable question block. */
export type GroomTicks = { id: string; indexes: number[] }

/**
 * A confirmed answer the person changed on the page: exactly one ticked option other than the
 * recorded one revises it in place; none leaves it as it was; two or more asks for one tick.
 */
export function reviseAnswers<T extends GroomDecision>(decisions: readonly T[], ticks: readonly GroomTicks[], date: string): T[] {
  const byId = new Map(ticks.map((entry) => [entry.id, entry.indexes]))
  return decisions.map((decision) => {
    if (decision.decidedBy !== 'author' || decision.answer === null) return decision
    const indexes = byId.get(decision.id)
    if (indexes === undefined) return decision
    const recorded = optionIndex(decision.options, decision.answer)
    const candidates = indexes.filter((index) => index !== recorded)
    if (candidates.length === 0) return decision
    if (candidates.length > 1) return { ...decision, flag: 'twoNewTicks' as const }
    const { flag: _flag, ...rest } = decision
    return { ...rest, answer: decision.options[candidates[0]!]!, revisedAt: date } as T
  })
}

/** A block of the page that is not the groomer's, with the question it sat under. */
export type GroomCarried = { under?: string; text: string; /** Line position on the page it came from. */ at?: number }

export type GroomRenderOptions = {
  /** The date for the dated lines (`Two ticks on`, `Confirmed`, …), YYYY-MM-DD. */
  date: string
  /** The trailer's written time; the date when absent. */
  writtenAt?: string
  /** The `Run: <time> <mode> in progress` paragraph, while a run is writing. */
  runMarker?: string
  /** Blocks carried from the previous page, in page order. */
  notes: readonly (GroomCarried | string)[]
  /** The page was re-created from the Idea's Decisions list on this date. */
  rebuiltOn?: string
  /** A person unticked Confirm after a confirmed run. */
  confirmUnticked?: boolean
}

/** A carried block as the Notes region holds it: headings and to-dos demoted so they are never read. */
const demote = (text: string): string => text.replace(/^#{1,6} (.+)$/, '**$1**').replace(/^- \[([ xX])\] (.*)$/, '[$1] $2')
const carriedLine = (note: GroomCarried | string): string => {
  if (typeof note === 'string') return note
  const text = demote(note.text)
  return note.under !== undefined && /^Q\d/.test(note.under) ? `(under ${note.under}) ${text}` : text
}

const isOpen = (decision: GroomDecision): boolean => decision.decidedBy === 'open'

/** The Grooming Decisions page for a record, in the layout the parser reads back. */
export function renderGroomPage(record: GroomRecord, options: GroomRenderOptions): string {
  const blocks: string[] = [GROOM_TITLE, GROOM_INTRO]
  if (options.rebuiltOn !== undefined) blocks.push(`Rebuilt from the Idea's Decisions list on ${options.rebuiltOn}; the previous page was not found`)
  if (options.runMarker !== undefined) blocks.push(options.runMarker)
  const decisions = [...record.decisions].sort((a, b) => compareIds(a.id, b.id))
  for (const decision of decisions) {
    blocks.push(`## ${decision.id} — ${decision.question}`, `Branch: ${decision.branch}`)
    for (const fact of decision.facts) blocks.push(`Fact: ${fact.path}:${fact.line}${fact.quote === undefined ? '' : ` — \`${fact.quote}\``}`)
    if (decision.flag === 'twoTicks') blocks.push(`Two ticks on ${options.date}; tick one to answer`)
    if (decision.flag === 'twoNewTicks') blocks.push(`Two new ticks on ${options.date}; tick one to revise`)
    const ticked =
      decision.decidedBy === 'author' && decision.answer !== null
        ? optionIndex(decision.options, decision.answer)
        : decision.decidedBy === 'agent'
          ? optionIndex(decision.options, decision.recommended)
          : -1
    if (decision.decidedBy === 'author' && decision.answer !== null) blocks.push(`Decided by the author: ${decision.answer}${decision.revisedAt === undefined ? '' : ` (revised ${decision.revisedAt})`}.`)
    if (decision.decidedBy === 'agent') blocks.push(`Taken by the agent to keep going: ${decision.recommended}. Tick another option to reverse it.`)
    blocks.push(decision.options.map((option, index) => `- [${index === ticked ? 'x' : ' '}] ${option}${option === decision.recommended ? ` _(recommended: ${decision.reasoning})_` : ''}`).join('\n'))
    blocks.push(`Why it is yours to decide: ${decision.whyYours}`)
  }
  const open = decisions.filter(isOpen).length
  const branchesOpen = record.branches.some((branch) => branch.state === 'open')
  if (open > 0 || branchesOpen) {
    blocks.push('## STOP — Stop grooming', '- [ ] Stop grooming')
  } else {
    blocks.push('## CONFIRM — Grooming is complete')
    if (record.status === 'ready') blocks.push('- [x] Confirm', `Confirmed ${options.date}`)
    else if (options.confirmUnticked === true) blocks.push('- [ ] Confirm', `Confirm was unticked on ${options.date}; tick it again to re-confirm`)
    else blocks.push('- [ ] Confirm')
  }
  if (options.notes.length > 0) blocks.push('## Notes', ...options.notes.map(carriedLine))
  const branches = record.branches.map((branch) => (branch.state === 'closed' ? `${branch.id}=closed (${branch.reason ?? ''})` : `${branch.id}=${branch.state}`))
  const counts = decisions.map((decision) => `${decision.id}=${decision.options.length}`)
  blocks.push(`Round ${record.round} · written ${options.writtenAt ?? options.date} · ${open} open${branches.length > 0 ? ` · branches: ${branches.join(', ')}` : ''}${counts.length > 0 ? ` · options: ${counts.join(', ')}` : ''}`)
  return `${blocks.join('\n\n')}\n`
}

type GroomToDo = { checked: boolean; text: string; line: string; at: number }

/** One question block as the page holds it. */
export type GroomPageBlock = {
  id: string
  question: string
  branch?: string
  facts: { path: string; line: number; quote?: string }[]
  decided?: { answer: string; revisedAt?: string }
  /** The recommended option, when the agent took it to keep going. */
  taken?: string
  todos: GroomToDo[]
  whyYours?: string
}

/** Everything the groomer's lines say on a page, and every other block in page order. */
export type GroomPageRead = {
  questions: GroomPageBlock[]
  confirm?: GroomToDo[]
  stop?: GroomToDo[]
  carried: GroomCarried[]
  trailer?: { round: number; written: string; open: number; branches?: { id: string; state: 'open' | 'visited' | 'closed'; reason?: string }[]; options?: Map<string, number> }
}

/**
 * Reads a page the groomer rendered. Column 0 only; a `##` heading or the trailer ends the
 * current block; reading stops at `## Notes`. Throws on a question id that appears twice, or
 * one not in `knownIds` when given.
 */
export function readGroomPage(markdown: string, knownIds?: readonly string[]): GroomPageRead {
  const read: GroomPageRead = { questions: [], carried: [] }
  type Region = { kind: 'head' } | { kind: 'question'; block: GroomPageBlock } | { kind: 'confirm' | 'stop' } | { kind: 'notes' } | { kind: 'other' } | { kind: 'after' }
  let region: Region = { kind: 'head' }
  const seen = new Set<string>()
  const P = GROOM_LINE_PATTERNS
  for (const [at, line] of markdown.split('\n').entries()) {
    if (line.trim() === '') continue
    // The run marker is the groomer's own line wherever the page holds it (the mark action may append it
    // after the trailer or the Notes): never a person's note, so it is never carried into a rendering.
    if (P.run.test(line)) continue
    if (region.kind !== 'after') {
      const trailer = line.match(P.trailer)
      if (trailer !== null) {
        const branches = trailer[4] === undefined ? undefined : [...trailer[4].matchAll(/([\w-]+)=(visited|open|closed)(?: \(([^)]*)\))?/g)].map((m) => ({ id: m[1]!, state: m[2] as 'open' | 'visited' | 'closed', ...(m[3] !== undefined ? { reason: m[3] } : {}) }))
        const options = trailer[5] === undefined ? undefined : new Map([...trailer[5].matchAll(/(Q[\d.]+)=(\d+)/g)].map((m) => [m[1]!, Number(m[2])] as const))
        read.trailer = { round: Number(trailer[1]), written: trailer[2]!, open: Number(trailer[3]), ...(branches !== undefined ? { branches } : {}), ...(options !== undefined ? { options } : {}) }
        region = { kind: 'after' }
        continue
      }
    }
    if (region.kind === 'notes' || region.kind === 'after') {
      read.carried.push({ text: line, at })
      continue
    }
    if (P.notes.test(line)) {
      region = { kind: 'notes' }
      continue
    }
    const heading = line.match(P.heading)
    if (heading !== null) {
      const [, id, title] = heading as unknown as [string, string, string]
      if (id === 'CONFIRM' || id === 'STOP') {
        region = { kind: id === 'CONFIRM' ? 'confirm' : 'stop' }
        if (id === 'CONFIRM') read.confirm ??= []
        else read.stop ??= []
        continue
      }
      if (/^Q\d+(?:\.\d+)*$/.test(id)) {
        if (seen.has(id)) throw new Error(`Grooming Decisions has two blocks for ${id}`)
        if (knownIds !== undefined && !knownIds.includes(id)) throw new Error(`Grooming Decisions has a block for ${id}, which is not in groom.json`)
        seen.add(id)
        const block: GroomPageBlock = { id, question: title.trim(), facts: [], todos: [] }
        read.questions.push(block)
        region = { kind: 'question', block }
        continue
      }
    }
    if (/^#{1,6} /.test(line)) {
      if (region.kind === 'head' && P.title.test(line)) continue
      read.carried.push({ text: line, at })
      region = { kind: 'other' }
      continue
    }
    const todo = line.match(P.todo)
    if (region.kind === 'head') {
      if (P.intro.test(line) || P.rebuilt.test(line)) continue
      read.carried.push({ text: line, at })
    } else if (region.kind === 'question') {
      const block = region.block
      const branch = line.match(P.branch)
      const fact = line.match(P.fact)
      const decided = line.match(P.decided)
      const taken = line.match(P.taken)
      const why = line.match(P.why)
      if (todo !== null) block.todos.push({ checked: todo[1] !== ' ', text: todo[2]!, line, at })
      else if (branch !== null && block.branch === undefined) block.branch = branch[1]!
      else if (fact !== null) block.facts.push({ path: fact[1]!, line: Number(fact[2]), ...(fact[3] !== undefined ? { quote: fact[3] } : {}) })
      else if (P.twoTicks.test(line) || P.twoNewTicks.test(line)) continue
      else if (decided !== null && block.decided === undefined) block.decided = { answer: decided[1]!, ...(decided[2] !== undefined ? { revisedAt: decided[2] } : {}) }
      else if (taken !== null && block.taken === undefined) block.taken = taken[1]!.trim()
      else if (why !== null && block.whyYours === undefined) block.whyYours = why[1]!
      else read.carried.push({ under: block.id, text: line, at })
    } else if (region.kind === 'confirm' || region.kind === 'stop') {
      const box = region.kind === 'confirm' ? 'Confirm' : 'Stop grooming'
      if (todo !== null && todo[2] === box) (region.kind === 'confirm' ? read.confirm! : read.stop!).push({ checked: todo[1] !== ' ', text: todo[2]!, line, at })
      else if (region.kind === 'confirm' && (P.confirmed.test(line) || P.confirmUnticked.test(line))) continue
      else read.carried.push({ text: line, at })
    } else {
      read.carried.push({ text: line, at })
    }
  }
  return read
}

/** What a run takes from the page: answers, ticks for revision, flags, Confirm and Stop, and the blocks to carry. */
export type GroomPageParse = {
  answers: Answer[]
  ticks: GroomTicks[]
  twoTicks: string[]
  confirmTicked: boolean
  stopTicked: boolean
  unread: string[]
  carried: GroomCarried[]
}

/** The page read against the ids groom.json knows. Options map by position only when the box count matches. */
export function parseGroomPage(markdown: string, knownIds: readonly string[]): GroomPageParse {
  const read = readGroomPage(markdown, knownIds)
  const result: GroomPageParse = { answers: [], ticks: [], twoTicks: [], confirmTicked: false, stopTicked: false, unread: [], carried: [] }
  const extra: GroomCarried[] = []
  for (const block of read.questions) {
    const recorded = read.trailer?.options?.get(block.id) ?? block.todos.length
    if (block.todos.length !== recorded) {
      result.unread.push(`${block.id}: ${block.todos.length} boxes on the page, ${recorded} options recorded; ticks under it were not read`)
      for (const todo of block.todos.slice(recorded)) extra.push({ under: block.id, text: todo.line, at: todo.at })
      continue
    }
    const indexes = block.todos.flatMap((todo, index) => (todo.checked ? [index] : []))
    result.ticks.push({ id: block.id, indexes })
    if (indexes.length === 1) result.answers.push({ id: block.id, question: block.question, answer: block.todos[indexes[0]!]!.text.replace(RECOMMENDED_SUFFIX, '').trim() })
    if (indexes.length > 1) result.twoTicks.push(block.id)
  }
  result.confirmTicked = (read.confirm ?? []).some((todo) => todo.checked)
  result.stopTicked = (read.stop ?? []).some((todo) => todo.checked)
  // Extra boxes are carried where they sat, in page order with everything else carried.
  result.carried = [...read.carried, ...extra].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return result
}

/** The open questions, Confirm and Stop, read from a page without groom.json. */
export function groomPageState(markdown: string): { open: number; confirmTicked: boolean; stopTicked: boolean; ids: string[] } {
  const read = readGroomPage(markdown)
  const ids = read.questions.filter((block) => block.decided === undefined).map((block) => block.id).sort(compareIds)
  return { open: ids.length, confirmTicked: (read.confirm ?? []).some((todo) => todo.checked), stopTicked: (read.stop ?? []).some((todo) => todo.checked), ids }
}

/** One item of a Decisions list: the groomer's `Q` form, or a hand-groomed `D` item. */
export type DecisionsListItem = { id: string; adr: boolean; question?: string; answer?: string; reasoning?: string; title?: string; body?: string }

/** Reads a `### Decisions` list: `- **Q<n> — <question>** Answer: <a>. Why: <r>.[ **ADR candidate**]` or `- **D<n> — <title>.** <body>`. */
export function parseDecisionsList(markdown: string): { items: DecisionsListItem[]; unparsed: string[] } {
  const items: DecisionsListItem[] = []
  const unparsed: string[] = []
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('- ')) continue
    const q = line.match(/^- \*\*(Q\d+(?:\.\d+)*) — (.+?)\*\* Answer: (.+?)\. Why: (.+?)\.( \*\*ADR candidate\*\*)?$/)
    if (q !== null) {
      items.push({ id: q[1]!, question: q[2]!, answer: q[3]!, reasoning: q[4]!, adr: q[5] !== undefined })
      continue
    }
    const d = line.match(/^- \*\*(D\d+) — (.+?)\.\*\* (.*)$/)
    if (d !== null) {
      items.push({ id: d[1]!, title: d[2]!, body: d[3]!, adr: d[3]!.includes('**ADR candidate**') })
      continue
    }
    unparsed.push(line)
  }
  return { items, unparsed }
}

/**
 * A page that holds more than one rendering (a write that failed part-way, or two runs): the
 * highest complete rendering is kept, every other groomer block is deleted, and every block a
 * person wrote is carried.
 */
export function classifyRenderings(markdown: string): { round: number | null; kept: string; deleted: string[]; carried: string[] } {
  const segments: string[][] = []
  for (const line of markdown.split('\n')) {
    if (GROOM_LINE_PATTERNS.title.test(line) || segments.length === 0) segments.push([])
    segments[segments.length - 1]!.push(line)
  }
  const reads = segments.map((lines) => {
    const text = lines.join('\n')
    const read = readGroomPage(text)
    return { text, lines, read, complete: read.trailer !== undefined }
  })
  const complete = reads.filter((segment) => segment.complete)
  const kept = complete.reduce<(typeof reads)[number] | null>((best, segment) => (best === null || segment.read.trailer!.round > best.read.trailer!.round ? segment : best), null)
  const carried: string[] = []
  const deleted: string[] = []
  for (const segment of reads) {
    const human = new Set(segment.read.carried.map((note) => note.text))
    for (const line of segment.lines) {
      if (line.trim() === '') continue
      if (human.has(line)) carried.push(line)
      else if (segment !== kept) deleted.push(line)
    }
  }
  return { round: kept?.read.trailer?.round ?? null, kept: kept?.text ?? '', deleted, carried }
}
