import { defineWorkflowTool } from 'eve/tools'
import { z } from 'zod'
import { requireBound } from '../lib/bound.ts'
import { FACT_FINDING_JSON_SCHEMA, factFindingSchema, type FactFinding } from '../lib/fact-finding.ts'
// runner.ts reaches Node.js builtins: use it only inside the 'use step' functions below, never in the workflow body.
import { factFinderMessage, prepareGroom, runGroom, type GroomInput } from '../lib/runner.ts'

// One grooming round under eve. Round zero runs on the fact-finder subagent (the cheap tier; eve
// has no per-call model, so the tier is the subagent's own), only when no facts are recorded; the
// round itself is composed in the runner on the frontier tier. The board work around the run is the
// launcher's: this tool never moves the card, sets a property or writes Notion.

/** Whether this run needs round zero, and the fact-finder's message when it does. */
async function planStep(input: GroomInput): Promise<{ needsFacts: boolean; message: string }> {
  'use step'
  requireBound('folder', input.folder)
  requireBound('repository', input.repoPath)
  const prepared = await prepareGroom(input)
  return { needsFacts: prepared.needsFacts && !prepared.stopTicked && !prepared.confirmTicked, message: factFinderMessage(prepared, input.repoPath) }
}

async function roundStep(input: GroomInput, finding: FactFinding | undefined) {
  'use step'
  return runGroom(input, finding === undefined ? {} : { finding })
}

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    'Run one grooming round on a Feature Board ticket the launcher has already claimed and pulled into its working folder (.work/<id>-<slug>/). Finds the repository facts once, composes the round of open product questions, and writes groom/ (round-<n>.json, trace/groom.json, run-analysis.md). guidelinesPath is the requiredHostFile from load-knowledge. Never writes the card.',
  inputSchema: z.object({
    folder: z.string().min(1).describe('Absolute path of the ticket\'s working folder, .work/<id>-<slug>.'),
    repoPath: z.string().min(1).describe('Absolute path of the local repository.'),
    guidelinesPath: z.string().min(1).describe('The requiredHostFile load-knowledge returned, or a complete required-guidelines snapshot.'),
  }),
  async execute(input, ctx) {
    'use workflow'
    const plan = await planStep(input)
    const finding = plan.needsFacts ? factFindingSchema.parse(await ctx.agent('fact-finder', { message: plan.message, outputSchema: FACT_FINDING_JSON_SCHEMA })) : undefined
    return roundStep(input, finding)
  },
})
