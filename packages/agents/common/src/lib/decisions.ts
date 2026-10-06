// Open decisions, shared by every agent that leaves one to a human (specs/agents-human-lists.md
// F3, F4): the shape a model must produce, the checkbox rendering the author ticks, the parser
// that reads the tick back on the next run, and the record that says who decided.

import { z } from 'zod'

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

const RECOMMENDED_SUFFIX = /\s*_\((?:recommended|recommended, taken by the agent): .*\)_\s*$/

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

/** An answer the author ticked in a decisions file. */
export type Answer = { id: string; question: string; answer: string }

/** The decisions with exactly one ticked option. Two ticks under one question is no answer. */
export function parseTickedDecisions(markdown: string): Answer[] {
  const answers: Answer[] = []
  let current: { id: string; question: string; ticked: string[] } | null = null
  const flush = () => {
    if (current !== null && current.ticked.length === 1) answers.push({ id: current.id, question: current.question, answer: current.ticked[0]! })
  }
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^## (\S+) — (.+)$/)
    if (heading !== null) {
      flush()
      current = { id: heading[1]!, question: heading[2]!.trim(), ticked: [] }
      continue
    }
    const tick = line.match(/^- \[[xX]\] (.+)$/)
    if (tick !== null && current !== null) current.ticked.push(tick[1]!.replace(RECOMMENDED_SUFFIX, '').trim())
  }
  flush()
  return answers
}

/** An open decision whose question the author answered becomes the author's; the rest stay as they are. */
export function applyAnswers<T extends DecisionRecord>(decisions: readonly T[], answers: readonly Answer[]): T[] {
  const byQuestion = new Map(answers.map((answer) => [normalizeQuestion(answer.question), answer.answer]))
  return decisions.map((decision) => {
    if (decision.decidedBy !== 'open') return decision
    const answer = byQuestion.get(normalizeQuestion(decision.question))
    return answer === undefined ? decision : { ...decision, decidedBy: 'author' as const, answer }
  })
}

/** The open decisions: what still needs the author. */
export const openDecisions = <T extends DecisionRecord>(decisions: readonly T[]): T[] => decisions.filter((decision) => decision.decidedBy === 'open')

/** A decision an agent settled itself: the recommended option, already taken. */
export const takenDecision = (id: string, decision: Decision): DecisionRecord => ({ ...decision, id, decidedBy: 'agent', answer: decision.recommended })
