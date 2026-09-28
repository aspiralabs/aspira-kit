import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runReview } from '../lib/runner.ts'

export default defineTool({
  availableInSubagents: false,
  description: 'Review a spec against a local Git repository and required engineering guidelines. Runs frontier research, six parallel audits, and reconciliation with explicit cancellation and no elapsed-time limit. Writes a candidate without changing the original spec. guidelinesPath is the host requiredHostFile from load-knowledge or a user-provided complete snapshot.',
  inputSchema: z.object({ specPath: z.string().min(1), repoPath: z.string().min(1), guidelinesPath: z.string().min(1), outputDir: z.string().optional(), uiRequired: z.boolean().optional() }),
  async execute(input, ctx) { return runReview(input, { signal: ctx.abortSignal }) },
})
