import { defineWorkflowTool } from 'eve/tools'
import { z } from 'zod'
import {
  DEFAULT_MAX_ROUNDS,
  DOC_OUTPUT_SCHEMA,
  FILES,
  FINDINGS_OUTPUT_SCHEMA,
  LENS,
  MAX_ROUNDS_LIMIT,
  SEATS,
  TURN_OUTPUT_SCHEMA,
  VERIFY_OUTPUT_SCHEMA,
  checkFindingsPrompt,
  normalizeCounts,
  openingPrompt,
  reviewDocPrompt,
  roundFilesInOrder,
  totalFindings,
  turnPrompt,
  verdictFrom,
  verifyPrompt,
  writeFindingsPrompt,
  writeReviewPrompt,
  type DocOutput,
  type FindingsOutput,
  type PrContext,
  type Seat,
  type TurnOutput,
  type VerifyOutput,
} from '../lib/review'

// Six lenses plus a verifier, looping until the fix list stops moving.
//
// The seats are declared subagents with `tool: false`: the root model never sees
// them, only this workflow calls them. They share the root's sandbox, so all six
// read the same /workspace/pr.patch and each other's rounds. Each seat writes its
// own file per round — six agents cannot append to one transcript concurrently
// without losing each other's writes — and reads every other file each turn.
// Every call is a fresh child turn; the files under /workspace/review are the memory.

const NO_TURN: TurnOutput = { agreed: false, openPoints: [], note: '' }
const NO_VERIFY: VerifyOutput = { agreed: false, openPoints: [], rejected: [], duplicates: [], note: '' }

export default defineWorkflowTool({
  description:
    'Review a loaded pull request. Six seats (security, performance, architecture, testing, DX, design system) review the diff in parallel and answer each other, an independent verifier rules on every finding, and the loop runs until all seven agree on the fix list or the round cap is hit. Then it writes /workspace/findings.md and /workspace/review.md. Call load-pr first.',
  inputSchema: z.object({
    label: z.string().min(1).describe('The `label` load-pr returned. Names the PR in every prompt and in the transcript.'),
    repoPath: z
      .string()
      .nullable()
      .optional()
      .describe('The `repoPath` load-pr returned. Null when only a patch was loaded, and the seats are told so.'),
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
  }),
  async *execute({ label, repoPath, knowledgePath, knowledgeRequiredFile, maxRounds = DEFAULT_MAX_ROUNDS }, ctx) {
    'use workflow'
    const pr: PrContext = { label, repoPath: repoPath ?? null, knowledgePath: knowledgePath ?? null, knowledgeRequiredFile: knowledgeRequiredFile ?? null }

    let round = 0
    let seats: TurnOutput[] = SEATS.map(() => NO_TURN)
    let quinn: VerifyOutput = NO_VERIFY

    while (round < maxRounds) {
      round += 1
      yield { status: 'reviewing', round, maxRounds, seats: SEATS.map((seat) => LENS[seat]) }

      // All six in parallel: they are independent lenses on the same diff, and each
      // one's own file means no write races.
      seats = await Promise.all(
        SEATS.map((seat: Seat) =>
          ctx.agent(seat, {
            message: round === 1 ? openingPrompt(seat, pr) : turnPrompt(seat, round, pr),
            outputSchema: TURN_OUTPUT_SCHEMA,
          }),
        ),
      )

      yield { status: 'verifying', round, notes: seats.map((seat) => seat.note) }

      quinn = await ctx.agent('quinn', { message: verifyPrompt(round, pr), outputSchema: VERIFY_OUTPUT_SCHEMA })

      if (seats.every((seat) => seat.agreed) && quinn.agreed) break
    }

    const agreed = seats.every((seat) => seat.agreed) && quinn.agreed
    yield { status: 'writing documents', round, agreed }

    const [findingsDoc] = (await Promise.all([
      ctx.agent('nova', { message: writeFindingsPrompt(pr, agreed), outputSchema: FINDINGS_OUTPUT_SCHEMA }),
      ctx.agent('dex', { message: writeReviewPrompt(pr, agreed), outputSchema: DOC_OUTPUT_SCHEMA }),
    ])) as [FindingsOutput, DocOutput]

    yield { status: 'checking documents', round, agreed }

    // Quinn signs off the fix list, Nova checks the summary. Quinn's counts win:
    // it read the file last, and the verdict is computed from what is in the file.
    const [findingsCheck, reviewCheck] = (await Promise.all([
      ctx.agent('quinn', { message: checkFindingsPrompt(pr), outputSchema: FINDINGS_OUTPUT_SCHEMA }),
      ctx.agent('nova', { message: reviewDocPrompt('nova', FILES.review, pr), outputSchema: DOC_OUTPUT_SCHEMA }),
    ])) as [FindingsOutput, DocOutput]

    const counts = normalizeCounts(findingsCheck.counts ?? findingsDoc.counts)
    const openPoints = agreed ? [] : [...new Set([...seats.flatMap((seat) => seat.openPoints), ...quinn.openPoints])]

    return {
      label,
      repoPath: pr.repoPath,
      agreed,
      rounds: round,
      maxRounds,
      // Arithmetic, not an opinion: no model gets to declare this PR fine.
      verdict: verdictFrom(counts),
      counts,
      findings: totalFindings(counts),
      openPoints,
      rejected: quinn.rejected,
      duplicates: quinn.duplicates,
      files: FILES,
      roundFiles: roundFilesInOrder(round),
      review: {
        findings: { changedByQuinn: findingsCheck.changed, note: findingsCheck.note },
        summary: { changedByNova: reviewCheck.changed, note: reviewCheck.note },
      },
    }
  },
})
