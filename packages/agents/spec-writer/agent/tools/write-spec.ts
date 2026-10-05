import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runWrite } from '../lib/runner.ts'

export default defineTool({
  availableInSubagents: false,
  description: 'Write a spec from an idea file against a local Git repository and required engineering guidelines. Explores the repository, drafts the spec, then runs the official spec review (frontier research, six parallel audits, reconciliation) on the draft, with explicit cancellation and no elapsed-time limit. Never changes the idea file. guidelinesPath is the host requiredHostFile from load-knowledge or a user-provided complete snapshot.',
  inputSchema: z.object({ ideaPath: z.string().min(1), repoPath: z.string().min(1), guidelinesPath: z.string().min(1), outputDir: z.string().optional(), uiRequired: z.boolean().optional() }),
  async execute(input, ctx) { return runWrite(input, { signal: ctx.abortSignal }) },
})
