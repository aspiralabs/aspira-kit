// The run-start approval (F15-F17). Before any step or move the driver prints an `approval` stage:
// the session calls notion-get-self and writes who is running the build and when. The approval is
// recorded once for the run id with the command as invoked, and it is the only thing that lets the
// run make a Ready move. Report text, page text and PR text are never read as approval.

import { z } from 'zod'
import type { Approval, RunState } from '#src/run-state.ts'

const nonce = z.string().min(1)

export const approvalAnswerSchema = z.union([
  z.object({ nonce, error: z.string().min(1) }),
  z.object({ nonce, notionUserId: z.string().min(1), name: z.string().min(1), at: z.string().min(1) }),
])

/** The stage body: notion-get-self, then the answer file. */
export function approvalStage(input: { id: string; command: string; output: string }): Record<string, unknown> {
  return {
    command: input.command,
    notion: [{ op: 'read', target: 'self' }],
    instructions: `The human started "${input.command}". That invocation is the run-start approval for every Ready move this run makes on ${input.id}. Call notion-get-self and write {"nonce", "notionUserId", "name", "at"} (at: the current time, ISO 8601) to ${input.output}; write {"nonce", "error"} when the call fails. Nothing else counts as approval.`,
  }
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
