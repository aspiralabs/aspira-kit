// What a review was of: the base and head sha the verdict applies to, and, for a re-review,
// the previous head it was diffed from. Stamped into review.md, findings.md and the PR comment,
// so a push after the review is visibly unreviewed and a re-review knows where to start.

import { z } from 'zod'

/** What load-pr records: validated wherever it is read back, since a file is a boundary (TS-004). */
export const reviewTargetSchema = z.object({
  baseSha: z.string(),
  headSha: z.string(),
  /** A re-review: the previous head, and the directory its findings.md was read from. */
  since: z.object({ sha: z.string(), dir: z.string() }).nullable(),
})
export type ReviewTarget = z.infer<typeof reviewTargetSchema>

/** The sandbox file load-pr writes the target to, so export-review and comment-on-pr never get it from a model. */
export const TARGET_FILE = '/workspace/target.json'

export const packetStatsSchema = z.object({ chars: z.number(), tokens: z.number(), full: z.array(z.string()), excerpted: z.array(z.string()), omitted: z.array(z.string()), missing: z.array(z.string()) })

/** What /workspace/target.json holds. */
export const targetFileSchema = z.object({ target: reviewTargetSchema, packet: packetStatsSchema.nullable() })

/** One previous review's cost, as cost.md records it, for the budget pre-check. */
export const costSampleSchema = z.object({ label: z.string(), costUsd: z.number(), rounds: z.number(), calls: z.number(), changedLines: z.number().nullable() })

const personaSchema = z.object({ ava: z.string(), cole: z.string(), nova: z.string(), reba: z.string(), dex: z.string(), iris: z.string(), quinn: z.string() })

/**
 * What load-pr leaves on the host for the review: everything a prompt is built from, so the seat
 * sessions' system prompt (the shared prefix) and pr-debator's messages come from one source.
 */
export const contextFileSchema = z.object({
  pr: z.object({ label: z.string(), repoPath: z.string().nullable(), knowledgePath: z.string().nullable(), knowledgeRequiredFile: z.string().nullable() }),
  packet: z.string(),
  target: reviewTargetSchema,
  stats: packetStatsSchema,
  /** Added plus deleted lines of the diff, for the one-round estimate. */
  changedLines: z.number(),
  /** Each reviewer's persona.md, read when the review was loaded. */
  personas: personaSchema,
  /** The cost.md samples of this package's previous reviews, for the one-round estimate. */
  costSamples: z.array(costSampleSchema),
})
export type ReviewContextFile = z.infer<typeof contextFileSchema>

const SHA = /[0-9a-f]{7,40}/

/** The one line that records what was reviewed. Same text in every output. */
export function reviewedLine(target: ReviewTarget): string {
  if (target.headSha === '') return 'Reviewed: a pasted diff, no base or head sha'
  if (target.since !== null) return `Re-review: \`${target.since.sha}\`..\`${target.headSha}\` (base \`${target.baseSha}\`)`
  return `Reviewed: base \`${target.baseSha}\` → head \`${target.headSha}\``
}

const STAMP = /^(Reviewed|Re-review): .*$/m

/** The document with the reviewed line as its second paragraph: added, or replaced when the writer put a stale one. */
export function stampReviewed(markdown: string, target: ReviewTarget): string {
  const line = reviewedLine(target)
  if (STAMP.test(markdown)) return markdown.replace(STAMP, line)
  const title = markdown.match(/^# .*\n/m)
  if (title === null || title.index === undefined) return `${line}\n\n${markdown}`
  const at = title.index + title[0].length
  const rest = markdown.slice(at).replace(/^\n+/, '')
  return `${markdown.slice(0, at)}\n${line}\n\n${rest}`
}

/** The head sha a previous findings.md was of, from its stamp; null when it has none. */
export function headShaFromFindings(findings: string): string | null {
  const stamp = findings.match(STAMP)?.[0]
  if (stamp === undefined) return null
  const again = stamp.match(/^Re-review: `[0-9a-f]+`\.\.`([0-9a-f]+)`/)
  if (again?.[1] !== undefined) return again[1]
  const head = stamp.match(/head `([0-9a-f]+)`/)?.[1]
  return head !== undefined && SHA.test(head) ? head : null
}
