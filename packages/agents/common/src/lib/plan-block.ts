// The Plan page's fenced ```json block (F36, F37): the planner pushes one plan.json and the
// implementor's gate fields (status, decisions, repoCommit, problems) onto the Plan page, inside its
// own markdown, so a fresh machine's pull can rebuild plan.review/trace/plan.json and
// plan.review/trace/review.json from the page alone, or refuse cleanly when the block cannot be
// trusted: missing, malformed, failing planSchema, or either of its two hashes. `renderSha256`
// guards the plan's own content (tasks, tests, summary); `pageTextSha256` guards the prose outside
// the block (the page as a human reads it) against being edited after the push.

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DecisionRecord } from './decisions.ts'
import { planSchema, renderPlan, type Plan } from './plan.ts'

/** The two fixed destinations a recovered Plan page block ever writes to, inside the ticket's working
 * folder, repository-relative. Never a path the block itself names (F37's tamper case). */
export const PLAN_BLOCK_FILES = ['plan.review/trace/plan.json', 'plan.review/trace/review.json'] as const

/** The gate fields the Plan page's block carries: status, decisions, repoCommit and problems only.
 * Never input, models, mcp or timings: those are host-only (a local machine's paths, model ids, MCP
 * sources, run durations), dropped even when the caller's review object still has them. */
export type PlanBlockReview = { status: string; decisions: DecisionRecord[]; repoCommit: string; problems: string[] }

type PlanBlockData = { plan: Plan; review: PlanBlockReview; renderSha256: string; pageTextSha256: string | null }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A plan's content alone, independent of the status, repository commit and problems it is pushed
 * alongside: what `renderSha256` hashes, so only tampering with the plan itself (not the surrounding
 * gate fields, which are already covered separately by review.json) trips it. */
function canonicalPlanText(plan: Plan): string {
  return renderPlan(plan, 'ready', { specPath: '', commit: '', dirty: false }, [])
}

/** The trailing fenced ```json block `renderPlanBlock` appends, captured with its JSON body. */
const BLOCK_PATTERN = /\n```json\n([\s\S]*?)\n```\s*$/

/** The markdown with any trailing plan block stripped, trimmed: "the page text outside the block". */
function stripPlanBlock(markdown: string): string {
  const trimmed = markdown.replace(/\s+$/, '')
  const match = trimmed.match(BLOCK_PATTERN)
  return (match ? trimmed.slice(0, match.index) : trimmed).trim()
}

/** sha256 of the page's prose with any trailing plan block stripped and trimmed: stable across a
 * push/pull round trip as long as nobody edits the page afterward. */
export function pageTextHash(pageMarkdown: string): string {
  return sha256(stripPlanBlock(pageMarkdown))
}

/**
 * `pageMarkdown` with one more fenced ```json block appended: the plan, the gate fields (already
 * redacted to repository-relative paths by the caller; redaction is not this module's job), the
 * plan's content hash, and the page-text hash once known (`null` on the planner's first push, before
 * a read-back can tell it what Notion actually stored).
 */
export function renderPlanBlock(args: { pageMarkdown: string; plan: Plan; review: PlanBlockReview; pageTextSha256: string | null }): string {
  const data: PlanBlockData = {
    plan: args.plan,
    review: { status: args.review.status, decisions: args.review.decisions, repoCommit: args.review.repoCommit, problems: args.review.problems },
    renderSha256: sha256(canonicalPlanText(args.plan)),
    pageTextSha256: args.pageTextSha256,
  }
  const prose = stripPlanBlock(args.pageMarkdown)
  return `${prose}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`
}

export type RecoverResult = { recovered: true; files: string[] } | { recovered: false; reason: string; file: string }

const NAMED_FILES = PLAN_BLOCK_FILES.join(' and ')

const refused = (reason: string): RecoverResult => ({ recovered: false, reason, file: NAMED_FILES })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The decisions array as review.json carries it: whatever shape the block has, kept opaque (this
 * module never interprets a decision, only passes the array through). */
function decisionsOf(value: unknown): DecisionRecord[] {
  return Array.isArray(value) ? (value as DecisionRecord[]) : []
}

function problemsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

/**
 * Rebuilds `plan.review/trace/plan.json` and `plan.review/trace/review.json` inside `folder` from a
 * Plan page's markdown, or refuses and writes nothing: Notion truncated the page; the page has no
 * block, a malformed one, or one whose plan fails `planSchema`; the plan does not match
 * `renderSha256` (the reviewed plan's tasks or tests were tampered with); or the page's prose no
 * longer matches `pageTextSha256` (someone edited the page after the push). `review.json` always
 * carries `recoveredFrom: pageUrl`, and never the fields a block might also (legitimately or not)
 * carry beyond status, decisions, repoCommit and problems.
 */
export async function recoverPlan(args: { pageMarkdown: string; truncated: boolean; folder: string; pageUrl: string }): Promise<RecoverResult> {
  if (args.truncated) return refused(`Notion truncated the Plan page (${args.pageUrl}); not rebuilding ${NAMED_FILES} from a partial copy.`)

  const match = args.pageMarkdown.match(BLOCK_PATTERN)
  if (match?.[1] === undefined) return refused(`The Plan page (${args.pageUrl}) carries no plan block; cannot rebuild ${NAMED_FILES}.`)

  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch (cause) {
    return refused(`The Plan page's (${args.pageUrl}) block is not valid JSON; cannot rebuild ${NAMED_FILES}: ${cause instanceof Error ? cause.message : String(cause)}.`)
  }
  if (!isRecord(raw) || !isRecord(raw.review)) return refused(`The Plan page's (${args.pageUrl}) block is missing its plan or review object; cannot rebuild ${NAMED_FILES}.`)

  const planResult = planSchema.safeParse(raw.plan)
  if (!planResult.success) return refused(`The Plan page's (${args.pageUrl}) block fails planSchema; cannot rebuild ${PLAN_BLOCK_FILES[0]}.`)
  const plan = planResult.data

  const renderSha256 = typeof raw.renderSha256 === 'string' ? raw.renderSha256 : ''
  if (sha256(canonicalPlanText(plan)) !== renderSha256) {
    return refused(`The Plan page's (${args.pageUrl}) plan does not match the reviewed plan (renderSha256 mismatch); cannot rebuild ${PLAN_BLOCK_FILES[0]}.`)
  }

  const pageTextSha256 = typeof raw.pageTextSha256 === 'string' ? raw.pageTextSha256 : null
  if (pageTextSha256 === null) return refused(`The Plan page's (${args.pageUrl}) block has no recorded page-text hash yet; cannot rebuild ${NAMED_FILES}.`)
  if (pageTextHash(args.pageMarkdown) !== pageTextSha256) {
    return refused(`The Plan page was edited after planning (its prose no longer matches the hash recorded at the push); recovery is refused. Next action: Step 5, \`/aspira-planner KIT-2 --local\`.`)
  }

  const review: PlanBlockReview & { recoveredFrom: string } = {
    status: typeof raw.review.status === 'string' ? raw.review.status : '',
    decisions: decisionsOf(raw.review.decisions),
    repoCommit: typeof raw.review.repoCommit === 'string' ? raw.review.repoCommit : '',
    problems: problemsOf(raw.review.problems),
    recoveredFrom: args.pageUrl,
  }

  await mkdir(join(args.folder, dirname(PLAN_BLOCK_FILES[0])), { recursive: true })
  await writeFile(join(args.folder, PLAN_BLOCK_FILES[0]), `${JSON.stringify(plan, null, 2)}\n`)
  await writeFile(join(args.folder, PLAN_BLOCK_FILES[1]), `${JSON.stringify(review, null, 2)}\n`)
  return { recovered: true, files: [...PLAN_BLOCK_FILES] }
}
