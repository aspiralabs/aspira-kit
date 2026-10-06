import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { callsSoFar, capRefusal, maxSeatCalls } from '../lib/call-cap'
import { REPO_PATH } from '../lib/review'
import { SEARCH_CONTEXT_LINES, formatSearchOutput, searchCommand } from '../lib/search'

// grep over the checked-out tree with two lines of context, for the seats and Quinn: where a
// symbol is defined and who calls it, in one call. Counts toward the per-round call cap.

export default defineTool({
  description: `Search the checked-out tree at ${REPO_PATH} for an extended regular expression and return every match with ${SEARCH_CONTEXT_LINES} lines of context, as path:line:text. Optional globs limit it to file names (\`*.ts\`, \`*.test.tsx\`). Use it to find definitions and callers before a read_files call. Counts as one tool call toward the per-round cap.`,
  inputSchema: z.object({
    pattern: z.string().min(1).describe('An extended regular expression (grep -E).'),
    globs: z.array(z.string().min(1)).max(10).optional().describe('File-name globs to search within, such as ["*.ts", "*.tsx"]. All files when omitted.'),
  }),
  async execute({ pattern, globs }, ctx) {
    const cap = maxSeatCalls()
    const made = callsSoFar(ctx.session.id)
    const refusal = capRefusal(made, cap, [`search ${pattern}`])
    if (refusal !== null) return refusal
    const sandbox = await ctx.getSandbox()
    const result = await sandbox.run({ command: searchCommand(pattern, globs, REPO_PATH) })
    if (result.exitCode !== 0) return { error: `search failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`.slice(0, 2000), calls: { made: made + 1, cap } }
    const output = formatSearchOutput(result.stdout)
    return { matches: output.text, truncated: output.truncated, calls: { made: made + 1, cap } }
  },
})
