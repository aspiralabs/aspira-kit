// The merge, after the review loop and the release row: the last review left nothing medium or
// above and the gate passed on the fix, so the run merges the PR itself and moves the card to
// Ready: Implementation (BOARD-004 as revised 2026-10-23: a build-feature run merges on its
// recorded run-start approval). The session waits for the PR's checks and merges with a merge
// commit; the driver reads the PR back and accepts the merge only when GitHub says MERGED. When
// aspira.json names `releases`, a subagent then brings the feature's entry on the open release page
// up to date with the merge (REL-002): the Features row's state, the checklist, the lows left open
// as follow-ups, and the customer summary and technical steps checked against the merged diff.
// Then the move. A failed check or a refused merge stops the run with the PR open.

import { join } from 'node:path'
import { z } from 'zod'
import type { Phase, PhaseContext, PhaseResult } from '#build-feature/driver.ts'
import { MERGE_MOVE } from '#build-feature/route.ts'
import type { Pending, RunState } from '#build-feature/run-state.ts'
import { GH_ARGS, shown, system, type System } from '#build-feature/system.ts'

const IN_REVIEW = 'In Review: Implementation'

const recordSchema = z.object({ url: z.string(), mergedAt: z.string(), releasePage: z.enum(['updated']).optional() })
export type MergeRecord = z.infer<typeof recordSchema>

/** The merge this run recorded (state.phases.merge), or null. */
export function mergeRecordOf(state: { phases?: Record<string, unknown> }): MergeRecord | null {
  const parsed = recordSchema.safeParse(state.phases?.merge)
  return parsed.success ? parsed.data : null
}

const answerSchema = z.union([z.object({ nonce: z.string(), merged: z.literal(true) }), z.object({ nonce: z.string(), error: z.string().min(1) })])

const releaseAnswer = z.union([z.object({ nonce: z.string(), done: z.literal(true) }), z.object({ nonce: z.string(), error: z.string().min(1) })])

const moveOf = (context: PhaseContext, state: RunState): PhaseResult => ({ kind: 'move', state, from: MERGE_MOVE.from, to: MERGE_MOVE.to, expect: { status: IN_REVIEW, pr: context.card.pr, dev: context.card.dev } })

/** After the merge: the release page update when aspira.json names `releases` and it is not done, else the move. */
function afterMerge(context: PhaseContext, state: RunState, record: MergeRecord): PhaseResult {
  const releases = context.aspira.releases?.trim() ?? ''
  if (releases === '' || record.releasePage === 'updated') return moveOf(context, state)
  return {
    kind: 'stage',
    state,
    stage: 'release-row',
    body: {
      part: 'merged',
      releases,
      card: context.card.url,
      pr: record.url,
      mergedAt: record.mergedAt,
      findingsFile: join(context.folder, 'pr-review/findings.md'),
      notion: [{ op: 'write', target: 'release-page' }],
      instructions: [
        `${record.url} was merged on ${record.mergedAt.slice(0, 10)}. On the open release page under ${releases}, update ${context.id}'s entry to match (REL-002); change nothing that is not this feature's.`,
        `Features row (the one linking ${context.card.url}): set its state to "On \`main\` since <date> (merge <short sha>)", the sha from \`gh pr view ${record.url} --json mergeCommit\`, and keep the PR link.`,
        `Release checklist: tick (or add, ticked) "PR #<n> merged (<date>)", and keep or add an unticked "checked on dev: <what to check>" item for this feature: the merge is not the dev check.`,
        `Known follow-ups: add each Low finding of the last review in the findings file, one line each; skip any already listed.`,
        'Customer summary and technical steps: read them against the merged diff and correct what the review fixes made untrue; keep REL-004 (no ticket IDs or internal names in customer text).',
        'Merge nothing and move no card. Write {"nonce", "done": true}, or {"nonce", "error"}, to the output file.',
      ].join(' '),
    },
    data: { part: 'merged' },
  }
}

/** The merge stage, or what follows it when the PR is already merged. */
export async function mergeStage(context: PhaseContext, state: RunState): Promise<PhaseResult> {
  if (context.card.status !== IN_REVIEW) return { kind: 'done', state }
  const merged = mergeRecordOf(state)
  if (merged !== null) return afterMerge(context, state, merged)
  const url = state.step8.prUrl ?? context.card.pr
  if (url === null) return { kind: 'stop', state, message: 'the run has no PR to merge', failure: { action: 'merge', message: 'the run has no PR to merge' } }
  return {
    kind: 'stage',
    state,
    stage: 'merge',
    body: {
      pr: url,
      run: [`gh pr checks ${url} --watch --fail-fast`, `gh pr merge ${url} --merge`],
      instructions: `Run the first line of "run" in ${context.repo} and wait for it to end. When every check passed, run the second line. Run nothing else and change no file. Write {"nonce", "merged": true} when the merge command exited 0, else {"nonce", "error": "<the failing command and the last lines it printed>"}, to the output file.`,
    },
    data: { url },
  }
}

/** The session's merge answer: read the PR back, record the merge, then the move to Ready: Implementation. */
export async function acceptMerge(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>, sys: System = system): Promise<PhaseResult> {
  const url = String(pending.data?.url ?? '')
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success || 'error' in parsed.data) {
    const message = `the PR was not merged: ${parsed.success && 'error' in parsed.data ? parsed.data.error : `the answer at ${pending.output} is not {"merged": true} or {"error"}`}. The PR stays open and the card stays in ${IN_REVIEW}`
    return { kind: 'stop', state, message, failure: { action: 'merge', message } }
  }
  const viewed = await sys.ghPrView({ cwd: context.repo, env: context.env }, url)
  const prState = viewed.code === 0 ? z.object({ state: z.string() }).safeParse(JSON.parse(viewed.stdout)) : null
  if (prState === null || !prState.success || prState.data.state !== 'MERGED') {
    const message = `the session reported ${url} merged, but GitHub reads it back as ${prState?.success ? prState.data.state : 'unreadable'}, so the card is not moved`
    return { kind: 'stop', state, message, failure: { action: 'merge', command: shown('gh', GH_ARGS.prView(url)), message } }
  }
  const record: MergeRecord = { url, mergedAt: context.now }
  return afterMerge(context, { ...state, phases: { ...state.phases, merge: record } }, record)
}

/** The release page answer: recorded, then the move. A failed update stops the run after the merge, before the move. */
function acceptRelease(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): PhaseResult {
  const record = mergeRecordOf(state)
  const parsed = releaseAnswer.safeParse(answer)
  if (record === null || !parsed.success || 'error' in parsed.data) {
    const message = `the PR is merged, but the release page could not be updated: ${parsed.success && 'error' in parsed.data ? parsed.data.error : `the answer at ${pending.output} did not say it was done`}. The card stays in ${IN_REVIEW}; resume the run to try again`
    return { kind: 'stop', state, message, failure: { action: 'release-row', message } }
  }
  const updated: MergeRecord = { ...record, releasePage: 'updated' }
  return moveOf(context, { ...state, phases: { ...state.phases, merge: updated } })
}

/** The driver's merge phase (PHASES.merge). */
export const mergePhase: Phase = {
  next: (context, state) => mergeStage(context, state),
  accept: async (context, state, pending, answer) => (pending.data?.part === 'merged' ? acceptRelease(context, state, pending, answer) : acceptMerge(context, state, pending, answer)),
}
