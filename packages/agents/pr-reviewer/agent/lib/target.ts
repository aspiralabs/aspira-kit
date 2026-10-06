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

/** What load-pr leaves on the host for pr-debator: the packet text beside the target. */
export const contextFileSchema = z.object({ packet: z.string(), target: reviewTargetSchema, stats: packetStatsSchema })

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
