import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { countsFromFindings, reviewCommentBody, upsertReviewComment } from '../lib/github-comment'
import { FILES } from '../lib/review'

// Posts the finished review to the GitHub PR it was of: one conversation comment, updated
// on a rerun. Reads review.md and findings.md from the sandbox itself so the model never
// retypes them. Never throws for a refused post: the review is already exported.

export default defineTool({
  availableInSubagents: false,
  description:
    'Post the finished review to the GitHub PR it reviewed, as one comment with the computed verdict and counts followed by review.md; a rerun updates that comment. Only for a GitHub PR: pass `github` exactly as load-pr returned it. Call after export-review. Returns posted false with a reason when posting is off or GitHub refuses.',
  inputSchema: z.object({
    github: z
      .object({ owner: z.string().min(1), name: z.string().min(1), number: z.number().int().positive() })
      .describe('The `github` object load-pr returned for a GitHub PR.'),
  }),
  async execute({ github }, ctx) {
    if (process.env.PR_REVIEW_COMMENT === 'off') return { posted: false, reason: 'PR_REVIEW_COMMENT is off' }
    const token = process.env.GITHUB_TOKEN
    if (token === undefined || token === '') return { posted: false, reason: 'GITHUB_TOKEN is not set' }
    const sandbox = await ctx.getSandbox()
    const [review, findings] = await Promise.all([sandbox.readTextFile({ path: FILES.review }), sandbox.readTextFile({ path: FILES.findings })])
    if (review === null || findings === null) return { posted: false, reason: 'review.md or findings.md is missing from the sandbox' }
    const counts = countsFromFindings(findings)
    if (counts === null) return { posted: false, reason: 'findings.md is missing or is not a findings file, so the verdict cannot be computed' }
    try {
      const { action, url } = await upsertReviewComment(github, reviewCommentBody(review, counts), token)
      return { posted: true, action, url }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(token, '***')
      return { posted: false, reason: message }
    }
  },
})
