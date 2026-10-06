// The review, posted back to the GitHub PR it was of: one conversation comment per PR,
// updated on a rerun. Pure helpers plus one fetch-injected function, so it is testable
// without a network. The tool around it decides whether to post at all.
import { countsFromFindings, renderFindingsList } from './findings.ts'
import { SEVERITIES, verdictFrom, type Counts } from './review.ts'
import { reviewedLine, type ReviewTarget } from './target.ts'

/** The counts come from the severity sections of findings.md; see findings.ts. */
export { countsFromFindings }

/** Hidden first line: how a rerun finds its own earlier comment. */
export const REVIEW_COMMENT_MARKER = '<!-- aspiralabs-pr-reviewer -->'
/** GitHub rejects comment bodies over 65,536 characters; stay under it. */
export const MAX_COMMENT_CHARS = 65_000

export type GithubPr = { owner: string; name: string; number: number }

const API = 'https://api.github.com'

/**
 * Marker, the verdict computed from the counts, the counts, the shas reviewed, then every finding
 * in severity order with its plain-English line (when findings.md is given), then review.md,
 * within GitHub's limit. The findings list is never cut: the review is what gives way.
 */
export function reviewCommentBody(review: string, counts: Counts, target: ReviewTarget | null = null, findings: string | null = null): string {
  const totals = SEVERITIES.map((severity) => `${counts[severity]} ${severity}`).join(' · ')
  const reviewed = target === null ? '' : `${reviewedLine(target)}\n\n`
  const list = findings === null ? '' : `${renderFindingsList(findings)}\n\n`
  const head = `${REVIEW_COMMENT_MARKER}\n**Verdict: ${verdictFrom(counts)}** — ${totals}\n\n${reviewed}${list}`
  const foot = '\n\n---\n_Posted by the Aspira pr-reviewer. Rerunning the review updates this comment._\n'
  const cut = '\n\n_The review was cut to fit GitHub\'s comment limit; the full text is in the exported review.md._'
  const room = MAX_COMMENT_CHARS - head.length - foot.length
  const text = review.trim()
  const fitted = text.length <= room ? text : `${text.slice(0, room - cut.length)}${cut}`
  return `${head}${fitted}${foot}`
}

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Create the review comment on the PR, or update the token user's earlier one. Throws with
 * the HTTP status when GitHub refuses, so the tool can report it without failing the review.
 */
export async function upsertReviewComment(pr: GithubPr, body: string, token: string, request: Fetch = fetch): Promise<{ action: 'created' | 'updated'; url: string }> {
  const call = async (method: string, path: string, payload?: unknown): Promise<unknown> => {
    const response = await request(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'aspiralabs-pr-reviewer',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })
    if (!response.ok) throw new Error(`GitHub API ${response.status} on ${method} ${path}`)
    return response.json()
  }
  const { login } = (await call('GET', '/user')) as { login: string }
  const base = `/repos/${pr.owner}/${pr.name}/issues`
  let mine: { id: number } | undefined
  // Up to 1,000 comments; a PR with more than that has bigger problems than a duplicate.
  for (let page = 1; page <= 10; page++) {
    const comments = (await call('GET', `${base}/${pr.number}/comments?per_page=100&page=${page}`)) as { id: number; body?: string; user?: { login?: string } }[]
    for (const comment of comments) if (comment.user?.login === login && (comment.body ?? '').startsWith(REVIEW_COMMENT_MARKER)) mine = comment
    if (comments.length < 100) break
  }
  if (mine !== undefined) {
    const updated = (await call('PATCH', `${base}/comments/${mine.id}`, { body })) as { html_url: string }
    return { action: 'updated', url: updated.html_url }
  }
  const created = (await call('POST', `${base}/${pr.number}/comments`, { body })) as { html_url: string }
  return { action: 'created', url: created.html_url }
}
