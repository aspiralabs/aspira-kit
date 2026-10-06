// Severity order and the plain-English rule, shared by every agent that hands a list to a human
// (specs/agents-human-lists.md F1, F2). One order, one counter and one checker, so no renderer
// invents its own and the count in a header always equals the items under it.

import { z } from 'zod'

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]
export type Counts = Record<Severity, number>

export const severitySchema = z.enum(SEVERITIES)

export const EMPTY_COUNTS: Counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }

/** 0 for critical through 4 for info. */
export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity)

/** Critical first, info last; within a severity the input order (the order the verifier confirmed them) is kept. */
export function sortBySeverity<T>(items: readonly T[], severityOf: (item: T) => Severity): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => severityRank(severityOf(a.item)) - severityRank(severityOf(b.item)) || a.index - b.index).map(({ item }) => item)
}

export function countBySeverity<T>(items: readonly T[], severityOf: (item: T) => Severity): Counts {
  const counts = { ...EMPTY_COUNTS }
  for (const item of items) counts[severityOf(item)] += 1
  return counts
}

export const totalFindings = (counts: Counts): number => SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0)

/** `2 critical · 0 high · 1 medium · 0 low · 0 info`. */
export const countsLine = (counts: Counts): string => SEVERITIES.map((severity) => `${counts[severity]} ${severity}`).join(' · ')

/** The header line above a findings list: the total, then the breakdown. The total is what the body must hold. */
export const findingsHeader = (counts: Counts, noun = 'findings'): string => `${totalFindings(counts)} ${noun}: ${countsLine(counts)}`

/** `## Critical`, the heading a severity section carries in a findings file. */
export const severityHeading = (severity: Severity): string => severity.charAt(0).toUpperCase() + severity.slice(1)

/** The plain-English rule, stated once; every prompt that asks for the field quotes it. */
export const WHAT_THIS_MEANS_RULE =
  'one to three plain-English sentences for a reader who knows the product but not the code: what a user or the team would see go wrong, in ordinary words, with any technical term (a backticked path, symbol or command) defined in the sentence that uses it'

/** The sentences of a paragraph. A backticked token never splits a sentence, whatever it contains. */
export function sentencesOf(text: string): string[] {
  // Punctuation inside backticks is swapped for a placeholder before the split and restored after.
  const PLACEHOLDER = '\uE000'
  const protectedText = text.replace(/`[^`]*`/g, (token) => token.replace(/[.!?]/g, PLACEHOLDER))
  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replaceAll(PLACEHOLDER, '.').trim())
    .filter((sentence) => sentence !== '')
}

const WORD = /^[A-Za-z0-9_$-]+$/
const DEFINITION = /\b(?:is|are|was|were|means|meaning|refers to|which is|that is|in other words|i\.e\.)\b|\(|: /

/**
 * What is wrong with a What-this-means paragraph: it must be one to three sentences, and a
 * backticked token longer than one word (a path, a call, a command, a phrase) must be defined in
 * the sentence that uses it. A single identifier counts as one word and needs no definition.
 */
export function whatThisMeansProblems(text: string): string[] {
  const problems: string[] = []
  const sentences = sentencesOf(text)
  if (sentences.length === 0) problems.push('whatThisMeans is empty')
  if (sentences.length > 3) problems.push(`whatThisMeans has ${sentences.length} sentences; the limit is 3`)
  for (const sentence of sentences) {
    for (const token of [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim())) {
      if (WORD.test(token)) continue
      const prose = sentence.replace(/`[^`]*`/g, ' ')
      if (!DEFINITION.test(prose)) problems.push(`whatThisMeans uses \`${token}\` without defining it in the same sentence`)
    }
  }
  return problems
}

/** The field every finding carries: checked as the rule says, so a finding without a plain-English line never reaches a human. */
export const whatThisMeansSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((text, ctx) => {
    for (const problem of whatThisMeansProblems(text)) ctx.addIssue({ code: 'custom', message: problem })
  })
