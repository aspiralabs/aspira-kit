import { describe, expect, it } from 'vitest'
import {
  MAX_COMMENT_CHARS,
  REVIEW_COMMENT_MARKER,
  countsFromFindings,
  reviewCommentBody,
  upsertReviewComment,
} from './github-comment'
import { optionalPath } from './pr'

const pr = { owner: 'aspiralabs', name: 'project-hangar', number: 1 }
const FINDINGS = '# Findings: aspiralabs/project-hangar#1\n\nTotals: 0 critical · 0 high · 2 medium · 9 low · 0 info\n\n## Medium\n'

type Call = { method: string; url: string; body?: unknown; auth: string | null }
// A stand-in GitHub API: the token's user, the PR's comments, and every request made.
function fakeGithub(comments: { id: number; login: string; body: string }[], status = 200) {
  const calls: Call[] = []
  const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const auth = new Headers(init?.headers).get('authorization')
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth })
    if (status !== 200) return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status })
    if (String(url).endsWith('/user')) return Response.json({ login: 'david' })
    if (method === 'GET') return Response.json(comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.login }, html_url: `https://github.com/c/${c.id}` })))
    return Response.json({ id: 99, html_url: 'https://github.com/aspiralabs/project-hangar/pull/1#issuecomment-99' })
  }
  return { calls, request }
}

const finding = (id: string) => `### [${id}] title\n- **Location:** \`a.ts:1\`\n`

describe('countsFromFindings', () => {
  it('counts the findings under each severity heading', () => {
    const findings = `# Findings: o/r#2\n\nTotals: 0 critical · 1 high · 2 medium · 0 low · 1 info\n\n## High\n\n${finding('A1')}\n## Medium\n\n${finding('B1')}${finding('B2')}\n## Info\n\n${finding('C1')}`
    expect(countsFromFindings(findings)).toEqual({ critical: 0, high: 1, medium: 2, low: 0, info: 1 })
  })
  it('does not depend on how the totals line is worded', () => {
    const findings = `# Findings: o/r#2\n\nCritical 0 · High 1 · Medium 1 · Low 0 · Info 0\n\n## High\n\n${finding('A1')}\n## Medium\n\n${finding('B1')}`
    expect(countsFromFindings(findings)).toEqual({ critical: 0, high: 1, medium: 1, low: 0, info: 0 })
  })
  it('trusts the headings over a totals line that disagrees', () => {
    const findings = `# Findings: o/r#2\n\nTotals: 0 critical · 0 high · 0 medium · 0 low · 0 info\n\n## Critical\n\n${finding('A1')}`
    expect(countsFromFindings(findings)).toEqual({ critical: 1, high: 0, medium: 0, low: 0, info: 0 })
  })
  it('reads a clean review with no severity sections as all zeros', () => {
    expect(countsFromFindings(FINDINGS.replace('## Medium\n', ''))).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 })
  })
  it('ignores headings under sections that are not a severity', () => {
    const findings = `# Findings: o/r#2\n\n## High\n\n${finding('A1')}\n## Notes\n\n${finding('X1')}`
    expect(countsFromFindings(findings)).toEqual({ critical: 0, high: 1, medium: 0, low: 0, info: 0 })
  })
  it('returns null when the text is not a findings file', () => {
    expect(countsFromFindings('No findings title here.\n')).toBeNull()
  })
})

describe('reviewCommentBody', () => {
  const counts = { critical: 0, high: 0, medium: 2, low: 9, info: 0 }
  it('starts with the marker, then the computed verdict and counts, then the review', () => {
    const body = reviewCommentBody('# Review\n\nAll good.', counts)
    expect(body.startsWith(REVIEW_COMMENT_MARKER)).toBe(true)
    expect(body).toContain('**Verdict: comment**')
    expect(body).toContain('0 critical · 0 high · 2 medium · 9 low · 0 info')
    expect(body).toContain('# Review\n\nAll good.')
  })
  it('computes block from a high finding, whatever the review text says', () => {
    expect(reviewCommentBody('Looks fine.', { ...counts, high: 1 })).toContain('**Verdict: block**')
  })
  it('cuts an oversized review to GitHub\'s limit and says so', () => {
    const body = reviewCommentBody('x'.repeat(MAX_COMMENT_CHARS * 2), counts)
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS)
    expect(body).toContain('cut to fit')
  })
})

describe('upsertReviewComment', () => {
  it('creates one comment when the token\'s user has none on the PR', async () => {
    const github = fakeGithub([{ id: 5, login: 'someone-else', body: `${REVIEW_COMMENT_MARKER}\nold` }])
    const result = await upsertReviewComment(pr, 'BODY', 'tok', github.request)
    expect(result).toEqual({ action: 'created', url: 'https://github.com/aspiralabs/project-hangar/pull/1#issuecomment-99' })
    const write = github.calls.at(-1)
    expect(write).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/aspiralabs/project-hangar/issues/1/comments', body: { body: 'BODY' } })
    expect(github.calls.every((call) => call.auth === 'Bearer tok')).toBe(true)
  })
  it('updates its own earlier review comment instead of adding another', async () => {
    const github = fakeGithub([
      { id: 7, login: 'david', body: 'An unrelated comment' },
      { id: 8, login: 'david', body: `${REVIEW_COMMENT_MARKER}\nlast review` },
    ])
    const result = await upsertReviewComment(pr, 'BODY', 'tok', github.request)
    expect(result.action).toBe('updated')
    expect(github.calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/aspiralabs/project-hangar/issues/comments/8', body: { body: 'BODY' } })
  })
  it('throws with the status when GitHub refuses, so the caller can report it', async () => {
    const github = fakeGithub([], 403)
    await expect(upsertReviewComment(pr, 'BODY', 'tok', github.request)).rejects.toThrow('403')
  })
})

describe('optionalPath', () => {
  it.each([undefined, null, '', 'null', 'undefined', '  '])('treats %j as no path', (value) => {
    expect(optionalPath(value)).toBeUndefined()
  })
  it('keeps a real path', () => {
    expect(optionalPath('/repo')).toBe('/repo')
  })
})
