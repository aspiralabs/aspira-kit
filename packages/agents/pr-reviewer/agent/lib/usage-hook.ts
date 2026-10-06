import { defineHook } from 'eve/hooks'
import { forgetSpend, recordSpend } from './budget'
import { forgetSession, recordCalls } from './call-cap'
import { USAGE_LEDGER, type UsageLine } from './usage'

// Appends one line per model call to the shared sandbox ledger. Mounted as
// hooks/usage.ts on the root and on every seat: hooks fire per agent scope,
// but the sandbox is shared, so one file collects all of them.
//
// Append through the shell so concurrent seat steps do not clobber each
// other the way a read-modify-write would. base64 sidesteps shell quoting.
//
// `step.completed` carries no duration, so `step.started` records the start in
// memory and the completed handler pairs them. Hooks for one agent run in one
// process, and a step cannot complete before it starts, so the map stays small;
// it is still drained on completion to bound a long session.
//
// The same hook keeps two in-memory counters the review reads back: the spend
// per root session, for the --max-cost budget, and the tool calls per child
// session, for the per-round call cap that read_files and search enforce.
const started = new Map<string, number>()
const stepKey = (sessionId: string, turnId: string, stepIndex: number) => `${sessionId}:${turnId}:${stepIndex}`

export default defineHook({
  events: {
    'step.started'(event, ctx) {
      started.set(stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex), Date.now())
    },
    'actions.requested'(event, ctx) {
      recordCalls(ctx.session.id, event.data.actions.length)
    },
    'session.completed'(_event, ctx) {
      forgetSession(ctx.session.id)
      // The root's spend is read by pr-debator during the run; a child's session end is not the root's.
      if (ctx.session.parent === undefined) forgetSpend(ctx.session.id)
    },
    async 'step.completed'(event, ctx) {
      const usage = event.data.usage
      if (usage === undefined) return
      const key = stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex)
      const startedMs = started.get(key)
      started.delete(key)
      const endedMs = Date.now()
      const line: UsageLine = {
        agent: ctx.agent.name,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        stepIndex: event.data.stepIndex,
        at: new Date(endedMs).toISOString(),
        ...(startedMs === undefined
          ? {}
          : { startedAt: new Date(startedMs).toISOString(), durationMs: endedMs - startedMs }),
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        costUsd: usage.costUsd ?? null,
      }
      recordSpend(ctx.session.parent?.rootSessionId ?? ctx.session.id, line.costUsd)
      try {
        const sandbox = await ctx.getSandbox()
        const b64 = Buffer.from(JSON.stringify(line) + '\n', 'utf8').toString('base64')
        await sandbox.run({ command: `printf '%s' '${b64}' | base64 -d >> ${USAGE_LEDGER}` })
      } catch (error) {
        // A thrown hook fails the turn. Losing a cost line is not worth that.
        console.warn('[usage] could not record step usage', error)
      }
    },
  },
})
