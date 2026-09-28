import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runStaticAnalysis } from '../lib/runner.ts'

export default defineTool({
  availableInSubagents: false,
  description: 'Run every static analyzer a repository uses, apply auto-fixes, fix the remaining diagnostics with a workhorse model, and loop until clean or no further progress. `source` is a local path (fixed in place on the host) or a GitHub URL / owner/name (cloned and fixed inside the sandbox, committed on a static-analysis/<timestamp> branch). Writes report.md, diagnostics.json, rounds.json, usage.json and calls.json to the output directory.',
  inputSchema: z.object({
    source: z.string().min(1).describe('Local repository path or GitHub repository (URL, git@ URL or owner/name), exactly as the person gave it.'),
    ref: z.string().optional().describe('Remote only: branch to clone. Default: the default branch.'),
    push: z.boolean().optional().describe('Remote only: push the fix branch and open a pull request. Default false.'),
    maxRounds: z.number().int().min(1).max(20).optional(),
    maxCostUsd: z.number().min(0).optional(),
    outputDir: z.string().optional().describe('Absolute output directory. Default: <repo>/.static-analysis for local, a temp directory for remote.'),
    fixWarnings: z.boolean().optional().describe('Also fix warning-severity diagnostics. Default: report them only.'),
  }),
  async execute(input, ctx) {
    return runStaticAnalysis(input, { getSandbox: () => ctx.getSandbox(), signal: ctx.abortSignal })
  },
})
