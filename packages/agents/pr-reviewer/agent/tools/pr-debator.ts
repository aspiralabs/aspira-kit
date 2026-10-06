import { defineWorkflowTool } from 'eve/tools'
import { z } from 'zod'
import { maxCostFromEnv } from '../lib/budget'
import { maxSeatCalls } from '../lib/call-cap'
import { oneRoundCheck } from '../lib/estimate'
import { runReviewLoop } from '../lib/loop'
import type { PlanTask } from '../lib/plan'
import { DEFAULT_MAX_ROUNDS, FILES, MAX_ROUNDS_LIMIT, OUTPUT_SCHEMAS, OUTPUT_VALIDATORS, SEATS, roundFilesInOrder, totalFindings, turnMessage, type PrContext } from '../lib/review'
import { prContextFrom } from '../lib/review-context'
import { contextFileFor, readContext } from '../lib/shared-prefix'
import { spentSoFar } from '../lib/spend-ledger'
import type { ReviewContextFile } from '../lib/target'

// Six lenses plus a verifier, looping until the fix list stops moving.
//
// The seats are declared subagents with `tool: false`: the root model never sees
// them, only this workflow calls them. They share the root's sandbox, so all six
// read the same /workspace/pr.patch and each other's rounds. Each seat writes its
// own file per round — six agents cannot append to one transcript concurrently
// without losing each other's writes — and reads every other file each turn.
// Every call is a fresh child turn; the files under /workspace/review are the memory.
//
// The loop itself is lib/loop.ts over lib/plan.ts: the same stages, prompts and
// stopping rule as --local, with ctx.agent behind the callback.
//
// What a seat receives: its system prompt is the shared prefix (the packet and the
// review instructions, identical for all seven), resolved by the seat's own dynamic
// instruction from the review context load-pr wrote; its message is its persona and
// then the turn. So every session of a round starts with the same bytes, which is
// what lets the provider serve one cached prefix to all of them.

/** The review context load-pr wrote for this root session, and where it was looked for. */
async function readContextStep(rootSessionId: string, contextFile: string | undefined): Promise<{ context: ReviewContextFile | null; path: string }> {
  'use step'
  const path = contextFile === undefined || contextFile === '' ? contextFileFor(rootSessionId) : contextFile
  return { context: await readContext(path), path }
}

async function readSettings(): Promise<{ maxCostUsd: number | null; maxSeatCalls: number; warmCache: boolean }> {
  'use step'
  return { maxCostUsd: maxCostFromEnv(), maxSeatCalls: maxSeatCalls(), warmCache: process.env.PR_REVIEW_WARM_CACHE !== 'off' }
}

/** The spend of this run so far, from the usage hook's on-disk ledger for the root session. */
async function spentStep(rootSessionId: string): Promise<number> {
  'use step'
  return (await spentSoFar(rootSessionId)).costUsd
}

/** What the cache warm-up asks: nothing. The call exists so the shared prefix is written once before six seats read it. */
export const WARM_UP_MESSAGE = 'Cache warm-up for this review. Reply with the single word "ready". Do not call any tool, do not read anything and do not write any file.'

export default defineWorkflowTool({
  description:
    'Review a loaded pull request. Six seats (security, performance, architecture, testing, DX, design system) review the diff in parallel and answer each other, an independent verifier rules on every finding, and the loop runs until a round has no dispute and no new finding, or the round cap, or the budget. Then it writes /workspace/findings.md and /workspace/review.md. Call load-pr first. With a budget, refuses before any model call when one round is estimated to cost more than it.',
  inputSchema: z.object({
    label: z.string().min(1).describe('The `label` load-pr returned. Names the PR in every prompt and in the transcript.'),
    repoPath: z
      .string()
      .nullable()
      .optional()
      .describe('The `repoPath` load-pr returned. Null when only a patch was loaded, and the seats are told so.'),
    contextFile: z
      .string()
      .optional()
      .describe('The `contextFile` load-pr returned: the review context on the host. Pass it exactly as returned.'),
    knowledgePath: z
      .string()
      .optional()
      .describe('Sandbox path of the engineering guidelines loaded with load-knowledge (its `path`). The seats read them and treat them as rules.'),
    knowledgeRequiredFile: z
      .string()
      .optional()
      .describe('The `requiredFile` load-knowledge returned: REQUIRED.md, the pages every seat reads in full first. Pass it whenever load-knowledge returned one.'),
    maxRounds: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROUNDS_LIMIT)
      .optional()
      .describe(`Safety cap on rounds (one round = six seats in parallel, then the verifier). Default ${DEFAULT_MAX_ROUNDS}.`),
    maxCostUsd: z
      .number()
      .positive()
      .optional()
      .describe('Budget in USD: the run refuses to start when one round is estimated above it, and otherwise stops after the stage that crosses it and exports what exists as incomplete. Default MAX_COST_USD from the environment; unset means no cap.'),
  }),
  async *execute({ label, repoPath, contextFile, knowledgePath, knowledgeRequiredFile, maxRounds = DEFAULT_MAX_ROUNDS, maxCostUsd }, ctx) {
    'use workflow'
    const rootSessionId = ctx.session.id
    const loaded = await readContextStep(rootSessionId, contextFile)
    if (loaded.context === null) throw new Error(`No review context for this session (${loaded.path}). Call load-pr first, in this same session.`)
    const context = loaded.context
    const settings = await readSettings()
    const budget = maxCostUsd ?? settings.maxCostUsd
    // The same PrContext the seats' system prompt is built from; the prompt bytes match because the source does.
    const pr: PrContext = {
      ...prContextFrom(context, {}),
      label,
      repoPath: repoPath ?? context.pr.repoPath,
      knowledgePath: knowledgePath ?? context.pr.knowledgePath,
      knowledgeRequiredFile: knowledgeRequiredFile ?? context.pr.knowledgeRequiredFile,
      maxSeatCalls: settings.maxSeatCalls,
    }

    // The budget pre-check: one round estimated above the budget is refused before any model call.
    const check = oneRoundCheck({ changedLines: context.changedLines, seats: SEATS.length, samples: context.costSamples, maxCostUsd: budget })
    if (check.exceeds) {
      return {
        label,
        refused: true as const,
        reason: check.message,
        estimate: { oneRoundUsd: check.oneRoundUsd, changedLines: context.changedLines, samples: context.costSamples.length },
        budget: { maxCostUsd: budget },
        verdict: null,
        counts: null,
        rounds: 0,
        maxRounds,
        agreed: false,
        settled: false,
        stopped: null,
        missing: [],
        target: context.target,
        packet: context.stats,
      }
    }

    // All six seats of a stage in parallel: they are independent lenses on the same diff, and
    // each one's own file means no write races. Quinn and the document stages are one or two tasks.
    const run = (tasks: PlanTask[]) => Promise.all(tasks.map((task) => ctx.agent(task.agent, { message: turnMessage(context.personas[task.agent], task.prompt), outputSchema: OUTPUT_SCHEMAS[task.kind] })))
    // One seat call writes the shared prefix to the cache before the six parallel seats read it:
    // a provider only serves a cache entry once the request that wrote it has started answering.
    const warm = settings.warmCache ? () => ctx.agent('ava', { message: WARM_UP_MESSAGE }).then(() => undefined) : undefined
    const result = yield* runReviewLoop({ pr, maxRounds, run, spent: () => spentStep(rootSessionId), maxCostUsd: budget, ...(warm === undefined ? {} : { warm }) })

    // The check outputs, validated once more rather than cast: planStep stored what the schema accepted.
    const output = (id: string) => result.calls.find((call) => call.id === id && call.error === undefined)?.output
    const findingsCheck = OUTPUT_VALIDATORS.findings.safeParse(output('check-findings')).data
    const reviewCheck = OUTPUT_VALIDATORS.doc.safeParse(output('check-review')).data

    return {
      label,
      refused: false as const,
      repoPath: pr.repoPath,
      agreed: result.agreed,
      settled: result.settled,
      rounds: result.rounds,
      maxRounds,
      // Arithmetic, not an opinion: no model gets to declare this PR fine. Null when the
      // budget stopped the run before a fix list existed: that is not an approve.
      verdict: result.verdict,
      counts: result.counts,
      findings: result.counts === null ? null : totalFindings(result.counts),
      openPoints: result.openPoints,
      rejected: result.rejected,
      duplicates: result.duplicates,
      stopped: result.stopped,
      budget: { maxCostUsd: budget },
      missing: result.missing,
      target: context.target,
      packet: context.stats,
      files: FILES,
      roundFiles: roundFilesInOrder(result.rounds),
      review: {
        findings: findingsCheck === undefined ? null : { changedByQuinn: findingsCheck.changed, note: findingsCheck.note },
        summary: reviewCheck === undefined ? null : { changedByNova: reviewCheck.changed, note: reviewCheck.note },
      },
    }
  },
})
