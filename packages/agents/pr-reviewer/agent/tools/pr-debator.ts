import { readFile } from 'node:fs/promises'
import { defineWorkflowTool } from 'eve/tools'
import { z } from 'zod'
import { maxCostFromEnv, spentSoFar } from '../lib/budget'
import { maxSeatCalls } from '../lib/call-cap'
import type { PlanTask } from '../lib/local'
import { runReviewLoop } from '../lib/loop'
import type { PacketStats } from '../lib/packet'
import { DEFAULT_MAX_ROUNDS, FILES, MAX_ROUNDS_LIMIT, OUTPUT_SCHEMAS, OUTPUT_VALIDATORS, roundFilesInOrder, totalFindings, type PrContext } from '../lib/review'
import { contextFileSchema, type ReviewTarget } from '../lib/target'

// Six lenses plus a verifier, looping until the fix list stops moving.
//
// The seats are declared subagents with `tool: false`: the root model never sees
// them, only this workflow calls them. They share the root's sandbox, so all six
// read the same /workspace/pr.patch and each other's rounds. Each seat writes its
// own file per round — six agents cannot append to one transcript concurrently
// without losing each other's writes — and reads every other file each turn.
// Every call is a fresh child turn; the files under /workspace/review are the memory.
//
// The loop itself is lib/loop.ts over lib/local.ts's planStep: the same stages,
// prompts and stopping rule as --local, with ctx.agent behind the callback.

/** What load-pr wrote beside the sandbox for this workflow: the packet and the target, never retyped by a model. */
type LoadedContext = { packet: string | null; target: ReviewTarget | null; stats: PacketStats | null }

async function readContext(path: string | undefined): Promise<LoadedContext> {
  'use step'
  if (path === undefined || path === '') return { packet: null, target: null, stats: null }
  const parsed = contextFileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  return { packet: parsed.packet, target: parsed.target, stats: parsed.stats }
}

async function readSettings(): Promise<{ maxCostUsd: number | null; maxSeatCalls: number }> {
  'use step'
  return { maxCostUsd: maxCostFromEnv(), maxSeatCalls: maxSeatCalls() }
}

/** The spend of this run so far, from the usage hook's ledger for the root session. */
async function spentStep(rootSessionId: string): Promise<number> {
  'use step'
  return spentSoFar(rootSessionId).costUsd
}

export default defineWorkflowTool({
  description:
    'Review a loaded pull request. Six seats (security, performance, architecture, testing, DX, design system) review the diff in parallel and answer each other, an independent verifier rules on every finding, and the loop runs until a round has no dispute and no new finding, or the round cap, or the budget. Then it writes /workspace/findings.md and /workspace/review.md. Call load-pr first.',
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
      .describe('The `contextFile` load-pr returned: the review packet and the shas, on the host. Pass it exactly as returned.'),
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
      .describe('Budget in USD: the run stops after the call that crosses it and exports what exists as incomplete. Default MAX_COST_USD from the environment; unset means no cap.'),
  }),
  async *execute({ label, repoPath, contextFile, knowledgePath, knowledgeRequiredFile, maxRounds = DEFAULT_MAX_ROUNDS, maxCostUsd }, ctx) {
    'use workflow'
    const context = await readContext(contextFile)
    const settings = await readSettings()
    const budget = maxCostUsd ?? settings.maxCostUsd
    const pr: PrContext = {
      label,
      repoPath: repoPath ?? null,
      knowledgePath: knowledgePath ?? null,
      knowledgeRequiredFile: knowledgeRequiredFile ?? null,
      packet: context.packet,
      target: context.target,
      maxSeatCalls: settings.maxSeatCalls,
    }
    const rootSessionId = ctx.session.id

    // All six seats of a stage in parallel: they are independent lenses on the same diff, and
    // each one's own file means no write races. Quinn and the document stages are one or two tasks.
    const run = (tasks: PlanTask[]) => Promise.all(tasks.map((task) => ctx.agent(task.agent, { message: task.prompt, outputSchema: OUTPUT_SCHEMAS[task.kind] })))
    const result = yield* runReviewLoop({ pr, maxRounds, run, spent: () => spentStep(rootSessionId), maxCostUsd: budget })

    // The check outputs, validated once more rather than cast: planStep stored what the schema accepted.
    const output = (id: string) => result.calls.find((call) => call.id === id && call.error === undefined)?.output
    const findingsCheck = OUTPUT_VALIDATORS.findings.safeParse(output('check-findings')).data
    const reviewCheck = OUTPUT_VALIDATORS.doc.safeParse(output('check-review')).data

    return {
      label,
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
