// The five run statuses every Aspira skill's run ends in (ready, needs-author, incomplete,
// refused, blocked), the old per-skill words they replace, the exit codes a CLI reports them
// with, each skill's run record (where it lives and how it is read), and the board pushes and
// moves a status makes (F53). One module so every launcher, driver and kit command reads the same
// table instead of re-deriving it.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { endMove, pushesFor, type Push, type Skill } from './ticket.ts'
import { redact } from './redact.ts'

/** The five words every run ends in. */
export const RUN_STATUSES = ['ready', 'needs-author', 'incomplete', 'refused', 'blocked'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** A reason code a status can carry, naming which sub-case of the status this is. */
export const REASON_CODES = ['paused', 'no-analyzers', 'plan-drift'] as const
export type ReasonCode = (typeof REASON_CODES)[number]

/** The end of an exhaustive switch over a union (TS-008). */
function assertNever(value: never): never {
  throw new Error(`unhandled run status: ${JSON.stringify(value)}`)
}

/** The old per-skill words `readRunStatus` still understands, mapped onto a new status and reason code. */
const OLD_WORDS: Record<string, { status: RunStatus; reasonCode: ReasonCode | null }> = {
  complete: { status: 'ready', reasonCode: null },
  clean: { status: 'ready', reasonCode: null },
  confirmed: { status: 'ready', reasonCode: null },
  'nothing-detected': { status: 'ready', reasonCode: 'no-analyzers' },
  failed: { status: 'incomplete', reasonCode: null },
  partial: { status: 'incomplete', reasonCode: null },
  stopped: { status: 'needs-author', reasonCode: 'paused' },
}

/**
 * `word` read as a run status (Decision Q3.1, Assumption A1): one of the five new words as
 * itself, or an old per-skill word mapped onto its new status and reason code. `null` for
 * anything else, so the caller treats it as incomplete (F6, F7).
 */
export function readRunStatus(word: string): { status: RunStatus; reasonCode: ReasonCode | null } | null {
  if ((RUN_STATUSES as readonly string[]).includes(word)) return { status: word as RunStatus, reasonCode: null }
  return OLD_WORDS[word] ?? null
}

/** Reserved exit codes outside `exitCodeFor`'s range, so no status can collide with them. */
export const RUNNING_EXIT = 75
export const USAGE_EXIT = 2
export const MAX_COST_EXIT = 4
export const REFUSED_EXIT = 3
/** A run that stopped only on a human's open decisions (Decision Q4): its own code, so a script can tell it from a failure (1) or a refusal (3). */
export const NEEDS_AUTHOR_EXIT = 5

/**
 * The exit code a CLI reports for a run status (Assumption A2, Decision Q4): 0 only for ready, 1
 * for a failure (incomplete, blocked), REFUSED_EXIT (3) for a refusal and NEEDS_AUTHOR_EXIT (5)
 * for a run waiting on the author.
 */
export function exitCodeFor(status: RunStatus): number {
  switch (status) {
    case 'ready':
      return 0
    case 'needs-author':
      return NEEDS_AUTHOR_EXIT
    case 'incomplete':
    case 'blocked':
      return 1
    case 'refused':
      return REFUSED_EXIT
    default:
      return assertNever(status)
  }
}

/** Where each skill's run record lives, relative to its working folder (`folder`), except the code analyzer's, which is per app under the repository root (`repo`/`app`). */
export const RUN_RECORDS: Record<Skill, (args: { folder: string; repo?: string; app?: string }) => string> = {
  groomer: ({ folder }) => join(folder, 'groom', 'trace', 'groom.json'),
  'spec-writer': ({ folder }) => join(folder, 'spec.written', 'trace', 'review.json'),
  'spec-reviewer': ({ folder }) => join(folder, 'spec.reviewed', 'trace', 'review.json'),
  planner: ({ folder }) => join(folder, 'plan.review', 'trace', 'review.json'),
  implementor: ({ folder }) => join(folder, 'plan.review', 'trace', 'implementation-local.json'),
  'code-analyzer': ({ repo, app }) => join(repo ?? '', app ?? '', '.static-analysis', 'rounds.json'),
  'pr-reviewer': ({ folder }) => join(folder, 'pr-review', 'trace', 'review.json'),
}

/** A run's record, as every reader needs it: the status, its reason code when it has one, and the one sentence a report shows for a non-ready status. */
export type RunRecord = { status: RunStatus; reasonCode: ReasonCode | null; reason: string | null }

/** A trace file's shape, validated loosely at the boundary (PATTERN-012): real traces carry many more fields. */
const traceSchema = z.looseObject({ status: z.string().optional() })

/**
 * A skill's run record (F6, F7): a driver outcome of `refused` or `blocked` wins outright, even
 * with no trace file. Otherwise the skill's own trace file is read; a missing or unreadable file,
 * or a status word `readRunStatus` does not know, reads as `incomplete`, naming the file.
 */
export async function readRunRecord(skill: Skill, args: { folder: string; repo?: string; app?: string }, driverOutcome?: { status: 'refused' | 'blocked'; reason: string }): Promise<RunRecord> {
  if (driverOutcome !== undefined) return { status: driverOutcome.status, reasonCode: null, reason: driverOutcome.reason }
  const file = RUN_RECORDS[skill](args)
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return { status: 'incomplete', reasonCode: null, reason: `${file} is missing` }
  const json: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  const parsed = json === undefined ? undefined : traceSchema.safeParse(json)
  if (parsed === undefined || !parsed.success) return { status: 'incomplete', reasonCode: null, reason: `${file} could not be read as a run record` }
  const word = parsed.data.status
  if (word === undefined) return { status: 'incomplete', reasonCode: null, reason: `${file} has no status` }
  const read = readRunStatus(word)
  if (read === null) return { status: 'incomplete', reasonCode: null, reason: `${file}'s status is "${word}", which is not a known run status` }
  return { status: read.status, reasonCode: read.reasonCode, reason: null }
}

/** The report's first line, and a redacted reason line for any status but ready (F4, F18). */
export async function reportHead(record: { status: RunStatus; reason: string | null }, repo: string): Promise<string[]> {
  if (record.status === 'ready') return ['Run status: ready']
  const reason = record.reason === null ? '' : await redact(record.reason, repo)
  return [`Run status: ${record.status}`, reason]
}

/**
 * Every board effect a run status makes for a skill: its pushes (`ticket.ts`'s `pushesFor`) and
 * its move (`endMove`) (F12, F53). `_reasonCode` is accepted but not branched on: a reason code
 * (a groomer round paused by Stop, say) never changes which pushes or move happen, only the
 * report's wording.
 */
export function boardEffects(skill: Skill, status: RunStatus, _reasonCode: ReasonCode | null, current: string, prOpened: boolean): { pushes: Push[]; move: { from: string; to: string } | null } {
  return { pushes: pushesFor(skill, status), move: endMove(skill, status, current, prOpened) }
}

/**
 * Every record (file and symbol) that carries a word this module's search tests for but is never
 * read through `readRunStatus`/the five statuses: each is its own turn- or step-level outcome, not
 * a skill's run status.
 */
export const NOT_RUN_STATUS: readonly { file: string; symbol: string }[] = [
  { file: 'packages/agents/implementor/agent/lib/local-plan.ts', symbol: 'WORKER_REPORT' },
  { file: 'packages/agents/implementor/agent/lib/local-plan.ts', symbol: 'WAVE_RESULT' },
  { file: 'packages/agents/implementor/agent/lib/local-plan.ts', symbol: 'VERIFICATION' },
  { file: 'packages/agents/build-feature/src/gate.ts', symbol: 'the project gate record' },
  { file: 'packages/agents/build-feature/src/review-loop.ts', symbol: 'the fix step' },
  { file: 'packages/agents/code-analyzer/agent/lib/ledger.ts', symbol: 'the round ledger' },
  { file: 'packages/agents/common/src/lib/model-trace.ts', symbol: 'turn statuses' },
  { file: 'packages/agents/common/src/lib/run-analysis.ts', symbol: 'UsageEntry.status (a model turn, not a skill run)' },
  { file: 'packages/agents/spec-reviewer/agent/lib/models.ts', symbol: "the research ledger's turn.status (UsageEntry)" },
  { file: 'packages/agents/build-feature/src/driver.test-helper.ts', symbol: 'SUCCESS / writeStepExport (deliberate pre-upgrade word fixtures)' },
  { file: 'packages/agents/build-feature/src/driver.ts', symbol: "run-state.ts's run.ended ('stopped' | 'finished'): the run's own lifecycle word, not a skill run status" },
  { file: 'packages/agents/common/src/lib/telemetry.ts', symbol: 'STATUS_WORDS / STEP_RESULT_WORDS / statusCode: the source words a telemetry span may carry (KIT-19), read from old records, never emitted as a run status' },
  { file: 'packages/agents/common/src/lib/telemetry-sources.ts', symbol: 'groupStatus: a model-turn status, not a skill run status' },
]
