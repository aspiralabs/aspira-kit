// The build-feature run state: `.work/<id>-<slug>/.local/build-feature/state.json`, the same
// `<folder>/.local/<name>` layout as agent-common's localStateDir. It is cumulative over every run
// of the ticket: each run, its approval, the moves it made, each step result, the decisions agents
// took, what was asked in chat, the reviews, Step 8 and Step 10 progress, and the one stage the
// session still has to answer. Read and written through a zod schema (TS-004); a file that does
// not match throws naming its path (PATTERN-012).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { GAPS, TIME_BASES, TOOL_COUNT_BASES, USAGE_SCOPE_VALUES } from '@aspiralabs/agent-common/lib/telemetry'

/** Where the driver keeps its files inside the ticket's working folder. */
export const stateDirOf = (folder: string): string => join(folder, '.local', 'build-feature')
export const stateFileOf = (folder: string): string => join(stateDirOf(folder), 'state.json')

const text = z.string().min(1)

const count = z.number().nonnegative()
const optionalCount = count.nullable().optional()

/** One subagent a step (or fix) subagent launched, as the Agent tool reported it; an entry that failed validation keeps only `gap: 'invalid'`. */
export const subagentUsageSchema = z.object({
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  totalTokens: count.optional(),
  toolUses: count.optional(),
  wallMs: count.optional(),
  model: z.string().optional(),
  gap: z.enum(GAPS).optional(),
})
export type SubagentUsage = z.infer<typeof subagentUsageSchema>

/** One reduced group of a cloud step's own usage file (a phase/model, a code-analyzer round or a pr-reviewer agent), numbers only. */
export const phaseUsageSchema = z.object({
  phase: z.string(),
  model: z.string().nullable().optional(),
  inputTokens: optionalCount,
  outputTokens: optionalCount,
  totalTokens: optionalCount,
  cacheRead: optionalCount,
  cacheWrite: optionalCount,
  toolCalls: optionalCount,
  costUsd: optionalCount,
  startedAt: z.string(),
  endedAt: z.string(),
  status: z.string().optional(),
  anchored: z.boolean().optional(),
  timeBasis: z.enum(TIME_BASES).optional(),
  toolCountBasis: z.enum(TOOL_COUNT_BASES).optional(),
  usageScope: z.enum(USAGE_SCOPE_VALUES).optional(),
  partial: z.boolean().optional(),
})
export type PhaseRecord = z.infer<typeof phaseUsageSchema>

/**
 * What a step (or fix) used. `tokens` and `wallMs` keep their meaning from before KIT-19: the total
 * tokens and the wall time the Agent tool reported for the step subagent. Every other field is
 * optional, so a state.json written before KIT-19 still parses (F22): the session's richer report
 * (input/output tokens, tool uses, model, start and end, one entry per subagent it launched), the
 * reduced groups of a cloud step's usage file (`phases`, read by the driver, never reported), and
 * the gap that kept a source out.
 */
export const usageSchema = z
  .object({
    tokens: count.nullable().default(null),
    wallMs: count.nullable().default(null),
    inputTokens: optionalCount,
    outputTokens: optionalCount,
    toolUses: optionalCount,
    model: z.string().nullable().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    subagents: z.array(subagentUsageSchema).optional(),
    phases: z.array(phaseUsageSchema).optional(),
    gap: z.enum(GAPS).optional(),
  })
  .nullable()
export type Usage = z.infer<typeof usageSchema>

/** `type`: the card's Type (Feature, Bug, Chore), which names the worktree and the branch prefix (F50). */
export const cardSchema = z.object({ id: text, title: z.string(), url: z.string(), status: text, pr: z.string().nullable(), dev: z.string().nullable(), type: z.string().nullable().default(null) })
export type Card = z.infer<typeof cardSchema>

const runSchema = z.object({
  runId: text,
  /** The command as the human invoked it. */
  command: text,
  startedAt: text,
  endedAt: z.string().nullable().default(null),
  /** Why it ended: stopped, finished, replaced, or moved (it went on in the ticket's worktree, F50). */
  ended: z.string().nullable().default(null),
  /** The run id this run replaced with --force-run. */
  replaced: z.string().optional(),
  /** The end stage, kept so a later --finish prints it again. */
  end: z.object({ message: z.string(), stopped: z.boolean() }).optional(),
  /** How each step ran (F2): 'local' (--local, in the session) or 'cloud' (each step skill's default mode). */
  mode: z.enum(['local', 'cloud']).default('local'),
  /** The ticket's worktree the run worked in (F50). */
  worktree: z.string().optional(),
  /** KIT-19: the run's telemetry file was written (once; a later --finish never rewrites it), where, and the file block it was attached as. */
  telemetry: z.object({ written: z.boolean(), attached: z.string().optional(), file: z.string().optional() }).optional(),
})
export type RunRecord = z.infer<typeof runSchema>

const approvalSchema = z.object({ runId: text, notionUserId: text, name: text, at: text, command: text })
export type Approval = z.infer<typeof approvalSchema>

const moveSchema = z.object({ from: text, to: text, at: text, runId: text })
export type MoveRecord = z.infer<typeof moveSchema>

const countsSchema = z.object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number(), info: z.number() })

const stepSchema = z.object({
  step: text,
  runId: text,
  command: text,
  /** The status word read from the step's own export (or its report, for the pr-reviewer). */
  status: text,
  startedAt: text,
  endedAt: text,
  usage: usageSchema,
  resultLine: z.string().optional(),
  nonce: z.string().optional(),
  /** The report file the session wrote; a second file there is refused (F7). */
  report: z.string().optional(),
  /** pr-reviewer: the counts read from findings.md. */
  counts: countsSchema.nullable().optional(),
  /** The driver's verdict on the step (KIT-19: the step span's status code). */
  verdict: z.enum(['continue', 'stop']).optional(),
})
export type StepRecord = z.infer<typeof stepSchema>

/** A decision as review.json and plan.json record it. */
export const decisionRecordSchema = z.looseObject({
  id: text,
  question: text,
  options: z.array(z.string()),
  recommended: z.string(),
  reasoning: z.string(),
  whyYours: z.string(),
  decidedBy: z.enum(['open', 'author', 'agent']),
  answer: z.string().nullable(),
})

const takenSchema = z.object({ key: text, step: text, runId: text, decision: decisionRecordSchema })
export type TakenKey = z.infer<typeof takenSchema>

const askedSchema = z.object({ key: z.string().optional(), step: text, runId: z.string().optional(), id: z.string().optional(), question: text, answer: z.string().nullable() })
export type Asked = z.infer<typeof askedSchema>

const reviewSchema = z.looseObject({ n: z.number().int().positive(), headSha: z.string(), critical: z.number(), high: z.number(), runId: z.string() })
const remainingSchema = z.looseObject({ id: text, severity: text, title: z.string() })
const failureSchema = z.looseObject({ action: text, command: z.string().optional(), exitCode: z.number().optional(), output: z.string().optional(), message: z.string().optional() })
export type Failure = z.infer<typeof failureSchema>

const step8Schema = z.looseObject({ pushed: z.boolean(), prUrl: z.string().nullable(), prPropertySet: z.boolean(), moved: z.boolean() })
const step10Schema = z.looseObject({ committed: z.boolean(), changeset: z.string().nullable(), docsToPropagate: z.string().nullable(), releaseRow: z.string().nullable() })

const overrideSchema = z.object({ key: text, step: text, runId: text, from: z.string().nullable(), to: text, foundIn: text })
export type OverrideRecord = z.infer<typeof overrideSchema>

/** A question the driver still has to ask in chat (F13), and what comes after the asks. */
const queuedAskSchema = z.object({ step: text, runId: text, id: z.string().optional(), question: text })
export type QueuedAsk = z.infer<typeof queuedAskSchema>
const afterAsksSchema = z.object({ stop: z.string().nullable() })

/** The one stage the session has to answer next. `stage` is the stage exactly as printed. */
const pendingSchema = z.object({
  kind: text,
  nonce: text,
  output: text,
  stage: z.record(z.string(), z.unknown()),
  startedAt: text,
  /** The later-phase module that owns this stage (gate, step8, step10, review, release-row). */
  phase: z.string().optional(),
  /** What the driver needs back when the answer arrives. */
  data: z.record(z.string(), z.unknown()).optional(),
})
export type Pending = z.infer<typeof pendingSchema>

export const runStateSchema = z.object({
  runs: z.array(runSchema).default([]),
  /** The lock: the run in progress, if any (F48). */
  inProgress: z.object({ runId: text, startedAt: text }).nullable().default(null),
  approvals: z.array(approvalSchema).default([]),
  moves: z.array(moveSchema).default([]),
  steps: z.array(stepSchema).default([]),
  takenKeys: z.array(takenSchema).default([]),
  asked: z.array(askedSchema).default([]),
  reviews: z.array(reviewSchema).default([]),
  remaining: z.array(remainingSchema).default([]),
  failure: failureSchema.nullable().default(null),
  step8: step8Schema.default({ pushed: false, prUrl: null, prPropertySet: false, moved: false }),
  step10: step10Schema.default({ committed: false, changeset: null, docsToPropagate: null, releaseRow: null }),
  pending: pendingSchema.nullable().default(null),
  /** The card as this run last resolved it; null until the run's first resolution. */
  card: cardSchema.nullable().default(null),
  overrides: z.array(overrideSchema).default([]),
  queue: z.array(queuedAskSchema).default([]),
  afterAsks: afterAsksSchema.nullable().default(null),
  /** State the later-phase modules keep for themselves (gate, step8, step10, review, release-row). */
  phases: z.record(z.string(), z.unknown()).default({}),
})
export type RunState = z.infer<typeof runStateSchema>

export const emptyRunState = (): RunState => runStateSchema.parse({})

/** The run state in a ticket folder; an empty state when there is none. Throws naming the file when it is invalid. */
export async function readRunState(folder: string): Promise<RunState> {
  const file = stateFileOf(folder)
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return emptyRunState()
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = runStateSchema.safeParse(json)
  if (!parsed.success) throw new Error(`${file} is not a build-feature run state: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`)
  return parsed.data
}

/** Write the run state, validated, through a temp file so a crash never leaves half a file. */
export async function writeRunState(folder: string, state: RunState): Promise<void> {
  const file = stateFileOf(folder)
  const valid = runStateSchema.parse(state)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`)
  await rename(temp, file)
}
