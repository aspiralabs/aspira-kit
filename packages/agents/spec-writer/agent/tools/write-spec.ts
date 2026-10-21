import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runWrite } from '../lib/runner.ts'

export default defineTool({
  availableInSubagents: false,
  description: 'The one spec step. With ideaPath: write a spec from the idea file against a local Git repository and required engineering guidelines: explore the repository, draft the spec, then run the official spec review (frontier research, six parallel audits, reconciliation) on the draft. With specPath: review that spec again (the answered spec, after the author ticked its decisions), nothing explored or drafted. Explicit cancellation, no elapsed-time limit. Never changes the idea or the input spec. guidelinesPath is the host requiredHostFile from load-knowledge or a user-provided complete snapshot.',
  inputSchema: z.object({ ideaPath: z.string().min(1).optional(), specPath: z.string().min(1).optional(), repoPath: z.string().min(1), guidelinesPath: z.string().min(1), outputDir: z.string().optional(), uiRequired: z.boolean().optional() }).refine((input) => input.ideaPath !== undefined || input.specPath !== undefined, { message: 'ideaPath (write) or specPath (review) is required' }),
  async execute(input, ctx) { return runWrite(input, { signal: ctx.abortSignal }) },
})
