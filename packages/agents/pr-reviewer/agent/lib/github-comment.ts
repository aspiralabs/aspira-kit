// The review, posted back to the GitHub PR it was of: one conversation comment per PR,
// updated on a rerun. Pure helpers plus one fetch-injected function, so it is testable
// without a network. The tool around it decides whether to post at all.
import { SEVERITIES, verdictFrom, type Counts } from './review.ts'

/** Hidden first line: how a rerun finds its own earlier comment. */
export const REVIEW_COMMENT_MARKER = '<!-- aspiralabs-pr-reviewer -->'
/** GitHub rejects comment bodies over 65,536 characters; stay under it. */
export const MAX_COMMENT_CHARS = 65_000

export type GithubPr = { owner: string; name: string; number: number }

const API = 'https://api.github.com'
const TITLE = /^# Findings\b/m
const SECTION = /^## (\w+)\s*$/
const FINDING = /^### \[/

/**
 * The counts from findings.md, or null when the text is not a findings file.
 * Counts the `### [ID]` findings under each `## <Severity>` heading, so the
 * verdict never depends on how the model worded its totals line.
 */
export function countsFromFindings(findings: string): Counts | null {
  if (!TITLE.test(findings)) return null
  const counts: Counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  let section: string | null = null
  for (const line of findings.split('\n')) {
    const heading = line.match(SECTION)?.[1]?.toLowerCase()
    if (heading !== undefined) {
      section = heading
      continue
    }
    if (section === null || !FINDING.test(line)) continue
    const severity = SEVERITIES.find((name) => name === section)
    if (severity !== undefined) counts[severity] += 1
  }
  return counts
}

/** Marker, the verdict computed from the counts, the counts, then review.md, within GitHub's limit. */
export function reviewCommentBody(review: string, counts: Counts): string {
  const totals = SEVERITIES.map((severity) => `${counts[severity]} ${severity}`).join(' · ')
  const head = `${REVIEW_COMMENT_MARKER}\n**Verdict: ${verdictFrom(counts)}** — ${totals}\n\n`
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
