import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { checkout } from '../lib/checkout-state.ts'
import { pushCommand, pushGuard, redact, shellQuote } from '../lib/github.ts'
import { verification } from '../lib/verification-state.ts'

export default defineTool({
  availableInSubagents: false,
  description: 'Push the branch checkout-repo created, and open a draft pull request against its base when pullRequest is true (only when the request asked for one). Call once at the end, after record-verification and after implementation.md is committed, including for partial or blocked builds so the work is not lost. Refuses to run before record-verification. Never pushes any other branch.',
  inputSchema: z.object({
    pullRequest: z.boolean().describe('Also open a draft pull request. True only when the request asked for a pull request.'),
    title: z.string().min(1).describe('Pull request title, e.g. "feat: <feature>".'),
    body: z.string().min(1).describe('Pull request body: status, feature table, deviations and blockers from implementation.md.'),
  }),
  async execute({ pullRequest, title, body }, ctx) {
    const state = checkout.get()
    if (!state) throw new Error('Nothing to publish: call checkout-repo first')
    if (!verification.get()) throw new Error('No final verification recorded: call record-verification first with the feature table, dependenciesAdded, notesRewritten and slopEntries (or slopJustification)')
    const token = process.env.GITHUB_TOKEN?.trim() || undefined
    if (!token) throw new Error('GITHUB_TOKEN is not set; cannot push or open a pull request')
    const sandbox = await ctx.getSandbox()
    const cd = `cd ${shellQuote(state.root)}`
    const current = (await sandbox.run({ command: `${cd} && git rev-parse --abbrev-ref HEAD` })).stdout.trim()
    const refused = pushGuard(current, state.branch)
    if (refused) throw new Error(refused)
    const status = await sandbox.run({ command: `${cd} && git status --porcelain && git rev-list --count ${shellQuote(state.commit)}..HEAD` })
    const lines = status.stdout.trim().split('\n')
    const ahead = Number(lines.pop())
    if (lines.some(Boolean)) throw new Error(`Uncommitted changes remain; commit or discard them first:\n${lines.join('\n')}`)
    if (!ahead) throw new Error('The branch has no commits beyond its starting point')
    const push = await sandbox.run({ command: `${cd} && ${pushCommand(state.repo, token, state.branch)}` })
    if (push.exitCode !== 0) throw new Error(`Push failed: ${redact(push.stderr || push.stdout, token).trim().slice(-600)}`)
    if (!pullRequest) return { pushed: true, branch: state.branch, commits: ahead, pullRequest: null }
    const response = await fetch(`https://api.github.com/repos/${state.repo.owner}/${state.repo.name}/pulls`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'aspiralabs-implementor', 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, head: state.branch, base: state.base, draft: true }),
    })
    if (!response.ok) return { pushed: true, branch: state.branch, commits: ahead, pullRequest: null, problem: `GitHub API ${response.status}: ${redact(await response.text(), token).slice(0, 300)}` }
    const pr = (await response.json()) as { html_url?: string }
    return { pushed: true, branch: state.branch, commits: ahead, pullRequest: pr.html_url ?? null }
  },
})
