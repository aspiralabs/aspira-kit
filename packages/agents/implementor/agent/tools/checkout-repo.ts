import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { checkout } from '../lib/checkout-state.ts'
import { branchName, cloneCommand, parseRepo, redact, shellQuote } from '../lib/github.ts'

const ROOT = '/workspace/repo'

export default defineTool({
  availableInSubagents: false,
  description: `Clone a GitHub repository into the sandbox at ${ROOT} and check out a fresh implement/<feature>-<timestamp> branch to build on. Call once, before loading the plan. The GitHub token is used for the clone and removed from the checkout's git config.`,
  inputSchema: z.object({
    repo: z.string().min(1).describe('GitHub repository: URL, git@ URL or owner/name, exactly as the person gave it.'),
    ref: z.string().optional().describe('Branch to start from. Default: the repository default branch.'),
    feature: z.string().optional().describe('Short feature name for the branch slug, e.g. the plan folder name.'),
  }),
  async execute({ repo: input, ref, feature }, ctx) {
    const repo = parseRepo(input)
    const token = process.env.GITHUB_TOKEN?.trim() || undefined
    const branch = branchName(feature)
    const sandbox = await ctx.getSandbox()
    const clone = await sandbox.run({ command: cloneCommand(repo, token, ROOT, branch, ref) })
    if (clone.exitCode !== 0) throw new Error(`Clone of ${repo.label} failed: ${redact(clone.stderr || clone.stdout, token).trim().slice(-600)}`)
    const commit = clone.stdout.trim().split('\n').pop() ?? ''
    const head = await sandbox.run({ command: `cd ${shellQuote(ROOT)} && git symbolic-ref --short refs/remotes/origin/HEAD` })
    const base = ref ?? head.stdout.trim().replace(/^origin\//, '')
    if (!base) throw new Error(`Could not determine the default branch of ${repo.label}; pass ref`)
    checkout.update(() => ({ repo, root: ROOT, branch, base, commit }))
    return { root: ROOT, repo: repo.label, branch, base, commit }
  },
})
