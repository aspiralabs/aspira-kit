import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runPlan } from '../lib/runner.ts'

export default defineTool({
  availableInSubagents: false,
  description: 'Turn an approved business spec into a concrete test-first implementation plan using a local Git repo and complete required guidelines. Read-only research; writes only plan artifacts. guidelinesPath is a supplied host file or requiredHostFile from load-knowledge.',
  inputSchema: z.object({ specPath: z.string().min(1), repoPath: z.string().min(1), guidelinesPath: z.string().min(1), outputDir: z.string().optional(), uiRequired: z.boolean().optional() }),
  async execute(input, ctx) { return runPlan(input, { signal: ctx.abortSignal }) },
})
