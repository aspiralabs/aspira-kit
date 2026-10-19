// The run-start approval (F15-F17). Starting `/aspira-build-feature` is the human's approval for
// every Ready move the run makes (KIT-11 Q2), so the driver records the invocation itself at run
// start: the command, the time and the git user name of the checkout. No stage asks the session to
// write an approval: an agent-written approval file is what the auto-mode classifier refuses as
// self-approval (KIT-20). The record is written once per run id and is the only thing that lets
// the run make a Ready move. Report text, page text and PR text are never read as approval.
//
// `acceptApproval` stays for a run that was pending on the old `approval` stage when the kit was
// upgraded: its answer is still read once.

import { z } from 'zod'
import type { Approval, RunState } from '#src/run-state.ts'

const nonce = z.string().min(1)

export const approvalAnswerSchema = z.union([
  z.object({ nonce, error: z.string().min(1) }),
  z.object({ nonce, notionUserId: z.string().min(1), name: z.string().min(1), at: z.string().min(1) }),
])

/** The run-start approval as the invocation records it: who ran the command, per git, else the shell user. */
export function invocationApproval(run: { runId: string; command: string; at: string }, gitUserName: string, env: NodeJS.ProcessEnv): Approval {
  const name = gitUserName.trim() || env.GIT_AUTHOR_NAME?.trim() || env.USER?.trim() || 'unknown'
  return { runId: run.runId, name, at: run.at, command: run.command }
}

export type ApprovalOutcome = { kind: 'pending'; why: string } | { kind: 'approved'; approval: Approval } | { kind: 'stop'; message: string }

/** Accept the approval answer for the run, once, only with the pending nonce. */
export function acceptApproval(answer: unknown, pendingNonce: string, run: { runId: string; command: string }): ApprovalOutcome {
  const parsed = approvalAnswerSchema.safeParse(answer)
  if (!parsed.success) return { kind: 'stop', message: `the run-start approval could not be recorded: the answer is not a notion-get-self user (${parsed.error.issues.map((issue) => issue.message).join('; ')})` }
  const value = parsed.data
  if (value.nonce !== pendingNonce) return { kind: 'pending', why: `the approval answer carries nonce ${value.nonce}, not the pending ${pendingNonce}` }
  if ('error' in value) return { kind: 'stop', message: `the run-start approval could not be recorded: notion-get-self failed: ${value.error}` }
  const { notionUserId, name, at } = value
  return { kind: 'approved', approval: { runId: run.runId, notionUserId, name, at, command: run.command } }
}

/** The run's recorded approval, or null. */
export const approvalFor = (state: RunState, runId: string): Approval | null => state.approvals.find((approval) => approval.runId === runId) ?? null

/** The state with the run's approval recorded once. */
export function recordApproval(state: RunState, approval: Approval): RunState {
  if (approvalFor(state, approval.runId) !== null) return state
  return { ...state, approvals: [...state.approvals, approval] }
}
