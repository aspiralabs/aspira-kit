// Whether the spec reviewer's own facts and UI evidence still describe the spec the planner is
// about to research, so research can start from them instead of re-reading the repository from
// scratch. "Still describe" means: the spec.reviewed.md the facts were taken from has not changed
// (by hash, or — after a Notion round-trip changed its bytes — because the Spec Reviewed page's
// last-edited time the ticket records is still the one the reviewer's trace recorded), and the
// repository is at or after the commit the reviewer read, with nothing uncommitted in between.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { readTicketMd } from '@aspiralabs/ai/common/lib/ticket-flow'

const exec = promisify(execFile)

/** The spec reviewer's exported trace, read loosely: only the fields review-facts needs. */
const traceSchema = z.looseObject({
  specSha256: z.string().optional(),
  specReviewedEditedAt: z.string().optional(),
  input: z.looseObject({ repoCommit: z.string().optional() }).optional(),
  reviews: z.array(z.looseObject({
    output: z.looseObject({ facts: z.array(z.string()).optional(), uiEvidence: z.array(z.string()).optional() }).optional(),
  })).optional(),
  // The spec writer's report (KIT-48, the one spec step) nests the review pipeline's result under `review`.
  review: z.looseObject({
    reviews: z.array(z.looseObject({
      output: z.looseObject({ facts: z.array(z.string()).optional(), uiEvidence: z.array(z.string()).optional() }).optional(),
    })).optional(),
  }).nullable().optional(),
})

/** Whether the reviewer's facts and UI evidence can be reused, and why (always set, even when included). */
export type ReviewFactsResult = { included: boolean; reason: string; facts: string[]; uiEvidence: string[] }

const noFacts = (reason: string): ReviewFactsResult => ({ included: false, reason, facts: [], uiEvidence: [] })

/** True when `ancestor` is `descendant` or reachable from it, in the repository at `repoPath`. False on any git error (an unknown commit included). */
async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

/** The paths `git diff --name-only` reports changed between two commits, or [] when the diff cannot be read. */
async function touchedFiles(repoPath: string, from: string, to: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', from, to], { cwd: repoPath })
    return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/**
 * The spec reviewer's facts and uiEvidence for the ticket at `folder` (its spec.reviewed/trace/review.json
 * and spec.reviewed/spec.reviewed.md), included only when they still match the current spec and are
 * datable against the repository at `repoPath`. `repo` is the repository's current HEAD and dirty state,
 * exactly as `repository()` reports it. Every refusal names the reason; researchSteps and renderFactsBlock
 * read it back off the result.
 */
export async function reviewFacts(args: { folder: string; repoPath: string; repo: { commit: string; dirty: boolean } }): Promise<ReviewFactsResult> {
  const { folder, repoPath, repo } = args
  const traceFile = join(folder, 'spec.reviewed', 'trace', 'review.json')
  const raw = await readFile(traceFile, 'utf8').catch(() => null)
  if (raw === null) return noFacts(`No spec-reviewer trace at ${traceFile}; nothing to reuse from review.json.`)

  let trace: z.infer<typeof traceSchema>
  try {
    const parsed = traceSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return noFacts(`${traceFile} does not look like a spec-reviewer review.json trace.`)
    trace = parsed.data
  } catch {
    return noFacts(`${traceFile} is not valid JSON.`)
  }

  const reviews = trace.reviews ?? trace.review?.reviews ?? []
  const facts = reviews.flatMap((review) => review.output?.facts ?? [])
  const uiEvidence = reviews.flatMap((review) => review.output?.uiEvidence ?? [])
  if (facts.length === 0 && uiEvidence.length === 0) return noFacts('The reviewer trace has no facts or uiEvidence to reuse.')

  const specPath = join(folder, 'spec.reviewed', 'spec.reviewed.md')
  const specText = await readFile(specPath, 'utf8').catch(() => null)
  const currentHash = specText === null ? null : createHash('sha256').update(specText).digest('hex')
  const hashMatches = trace.specSha256 !== undefined && currentHash !== null && currentHash === trace.specSha256

  let pulledMatches = false
  if (!hashMatches && trace.specReviewedEditedAt !== undefined) {
    const ticket = await readTicketMd(folder)
    const page = ticket?.pages['Spec Reviewed']
    pulledMatches = page !== undefined && page.lastEditedAt === trace.specReviewedEditedAt
  }
  if (!hashMatches && !pulledMatches) return noFacts('The spec hash and the Spec Reviewed last-edited time both differ from what the reviewer recorded; the facts may no longer describe this spec.')

  const recordedCommit = trace.input?.repoCommit
  if (recordedCommit === undefined) return noFacts('The reviewer trace is missing repoCommit, so the facts cannot be dated against the repository.')

  if (!(await isAncestor(repoPath, recordedCommit, repo.commit))) {
    return noFacts(`${recordedCommit} is not an ancestor of the repository's current HEAD (${repo.commit}); the facts cannot be dated against it.`)
  }

  if (repo.dirty) return { included: true, reason: 'The repository has uncommitted changes, so every fact must be re-read before it is cited.', facts, uiEvidence }
  if (recordedCommit === repo.commit) {
    return { included: true, reason: `The reviewer's facts were captured at the current HEAD (${recordedCommit}) with a clean working tree; cite them as evidence without re-reading.`, facts, uiEvidence }
  }

  const changed = await touchedFiles(repoPath, recordedCommit, repo.commit)
  const files = changed.length ? changed.join(', ') : 'no files the diff could list'
  return { included: true, reason: `The reviewer's facts were captured at an older commit (${recordedCommit}); ${files} changed since then, and any fact citing them must be re-read before use.`, facts, uiEvidence }
}

/** The research model's turn budget: fewer once it starts from the reviewer's reusable facts instead of reading the repository cold. */
export function researchSteps(withFacts: boolean): number {
  return withFacts ? 6 : 10
}

/** The block appended to the research prompt; '' when reviewFacts did not include anything. */
export function renderFactsBlock(result: ReviewFactsResult): string {
  if (!result.included) return ''
  const lines = [
    'SPEC REVIEW FACTS (from the spec reviewer\'s own research on this spec)', '',
    result.reason, '',
    ...result.facts.map((fact) => `- ${fact}`),
    ...result.uiEvidence.map((evidence) => `- ${evidence}`),
  ]
  return `\n\n${lines.join('\n')}`
}
