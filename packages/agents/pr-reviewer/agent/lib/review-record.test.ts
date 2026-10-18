// T27: the run record a --local review exports. Today exportReview (agent/lib/local.ts) writes
// trace/calls.json and the review's own documents, but no trace/review.json, and LocalDone.status
// is 'complete' | 'incomplete' rather than the shared five-status vocabulary ('ready' instead of
// 'complete'; see packages/agents/pr-reviewer/agent/lib/local.ts:123, 678-684). These tests fail
// until that lands: no trace/review.json exists yet, so every assertion on it fails closed.
//
// End to end over real git and a stand-in GitHub, the same seam the package's own local.test.ts
// uses (gitRepo, fakeGithub, answer/complete): never a module the project owns is mocked, only
// the network boundary (GitHub's REST API) and the subagents' file writes a session would make.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runLocal, type LocalDeps, type LocalInput, type LocalResult, type LocalTask } from './local.ts'

const exec = promisify(execFile)

// The folder the session builds from Notion before the first step, in load-knowledge's shape.
const REQUIRED_MD = '# Agent Instructions\n\nREV-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-002 Verify.\n'
async function seedKnowledge(dir: string, required = REQUIRED_MD) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'REQUIRED.md'), required)
  await writeFile(join(dir, 'INDEX.md'), '# Engineering\n\n- [Testing](testing.md)\n')
  await writeFile(join(dir, 'testing.md'), '# Testing\n\nTST-001 Tests first.\n')
}

const turn = (agreed: boolean, openPoints: string[] = [], over: { raised?: string[]; disputed?: string[] } = {}) => ({ agreed, raised: over.raised ?? [], disputed: over.disputed ?? [], openPoints, note: 'n' })
const verify = (agreed: boolean, openPoints: string[] = []) => ({ agreed, openPoints, rejected: ['COLE1.1'], duplicates: [], note: 'n' })
const doc = (path: string) => ({ path, changed: true, note: 'n' })
const counts = (high: number, medium = 0) => ({ critical: 0, high, medium, low: 0, info: 0 })
const findingsOut = (path: string, high: number, medium = 0) => ({ ...doc(path), counts: counts(high, medium) })

const FINDINGS_MD = '# Findings: test\n\nTotals: 0 critical · 1 high · 0 medium · 0 low · 0 info\n\n## High\n\n### [AVA1.1] Unchecked input\n- **Location:** `a.ts:1`\n'
const REVIEW_MD = '# Review: test\n\n## What this change does\nChanges a.\n'

async function gitRepo(options: { knowledge?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-record-'))
  const repo = join(dir, 'repo')
  await mkdir(repo)
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim()
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'a.ts'), 'export const a = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  await git('checkout', '-qb', 'feat/x')
  await writeFile(join(repo, 'a.ts'), 'export const a = 2\n')
  await writeFile(join(repo, 'b.ts'), 'export const b = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'feat: change a')
  const knowledge = join(repo, '.work', 'x', 'pr-review.local', 'knowledge')
  if (options.knowledge !== false) await seedKnowledge(knowledge)
  return { dir, repo, git, knowledge }
}

/** What a subagent does: write the files its prompt names, then its JSON result. */
async function answer(task: LocalTask, workDir: string) {
  const round = Number(task.id.match(/^round-(\d+)-/)?.[1] ?? 0)
  const write = (path: string, text: string) => mkdir(join(path, '..'), { recursive: true }).then(() => writeFile(path, text))
  let output: unknown
  if (round > 0) {
    await write(join(workDir, 'review', `round-${round}`, `${task.agent}.md`), `## Round ${round} — ${task.agent}\n\nNone.\n`)
    output = task.agent === 'quinn' ? verify(true) : turn(true)
  } else if (task.id === 'findings') {
    output = { ...findingsOut(join(workDir, 'findings.md'), 1), ...(await write(join(workDir, 'findings.md'), FINDINGS_MD).then(() => ({}))) }
  } else if (task.id === 'review') {
    output = { ...doc(join(workDir, 'review.md')), ...(await write(join(workDir, 'review.md'), REVIEW_MD).then(() => ({}))) }
  } else if (task.id === 'check-findings') {
    output = { ...findingsOut(join(workDir, 'findings.md'), 1), changed: false }
  } else {
    output = { ...doc(join(workDir, 'review.md')), changed: false }
  }
  await writeFile(task.output, JSON.stringify(output))
}

/** Answers every pending stage until the review exports. */
async function complete(input: LocalInput, deps: LocalDeps = {}) {
  for (let step = 0; step < 40; step += 1) {
    const result = await runLocal(input, deps)
    if (!result.pending) return result
    for (const task of result.tasks) await answer(task, result.workDir)
  }
  throw new Error('the review never finished')
}

const pending = (result: LocalResult) => {
  if (!result.pending) throw new Error('expected a pending stage')
  return result
}
const finished = (result: LocalResult) => {
  if (result.pending) throw new Error('expected a finished review')
  return result
}

// A stand-in GitHub: the PR, its diff, the token's user and the PR's comments. Every request is recorded.
function fakeGithub(pr: { head: string; base: string; diff: string }) {
  const calls: { method: string; url: string; auth: string | null; body?: { body: string } }[] = []
  const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, url: String(url), auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const path = String(url).replace('https://api.github.com', '')
    if (path === '/repos/acme/app/pulls/7') {
      if (headers.get('accept') === 'application/vnd.github.diff') return new Response(pr.diff)
      return Response.json({ title: 'Change a', body: 'Body', html_url: 'https://github.com/acme/app/pull/7', user: { login: 'dev' }, base: { ref: 'main', sha: pr.base }, head: { ref: 'feat/x', sha: pr.head } })
    }
    if (path === '/user') return Response.json({ login: 'david' })
    if (method === 'GET' && path.startsWith('/repos/acme/app/issues/7/comments')) return Response.json([])
    if (method === 'POST' && path === '/repos/acme/app/issues/7/comments') return Response.json({ id: 1, html_url: 'https://github.com/acme/app/pull/7#issuecomment-1' })
    return new Response('not found', { status: 404 })
  }
  return { calls, request }
}

async function githubFixture() {
  const { dir, repo, git } = await gitRepo()
  const head = await git('rev-parse', 'feat/x')
  const base = await git('rev-parse', 'main')
  await git('update-ref', 'refs/pull/7/head', head)
  const diff = await git('diff', '--no-color', 'main...feat/x')
  const github = fakeGithub({ head, base, diff: `${diff}\n` })
  const deps: LocalDeps = { fetch: github.request, cloneUrl: () => `file://${repo}`, githubToken: async () => 'tok', packageDir: dir }
  await seedKnowledge(join(dir, 'reviews', `${new Date().toISOString().slice(0, 10)}-feat-x.local`, 'knowledge'))
  return { dir, repo, github, deps, head }
}

describe('runLocal export, the run record', () => {
  it('a review with 0 critical and 1 high finding exports trace/review.json ready, with a null reason, the verdict and counts, and posts the comment flagged ready', async () => {
    const { github, deps } = await githubFixture()
    const done = finished(await complete({ source: 'acme/app#7' }, deps))

    // The rename this ticket makes: 'complete' becomes 'ready', one of the five shared run statuses.
    expect(done.status).toBe('ready')
    expect(done.counts).toEqual(counts(1))

    const reviewJsonPath = join(done.dir, 'trace', 'review.json')
    const reviewJson = JSON.parse(await readFile(reviewJsonPath, 'utf8')) as { status: string; reason: string | null; verdict: string | null; counts: { critical: number; high: number; medium: number; low: number; info: number } }
    expect(reviewJson).toMatchObject({ status: 'ready', reason: null, verdict: done.verdict, counts: counts(1) })

    // The report (review.md) leads with the run status, not the writer's own heading.
    const reviewMd = await readFile(join(done.dir, 'review.md'), 'utf8')
    expect(reviewMd.split('\n')[0]).toBe('ready')

    // A ready review is the one postComment is allowed to post: the GitHub POST actually happened.
    expect(done.comment).toMatchObject({ posted: true })
    expect(github.calls.some((c) => c.method === 'POST' && c.url === 'https://api.github.com/repos/acme/app/issues/7/comments')).toBe(true)
  })

  it('a run finished early with --finish, its outputs still missing, exports trace/review.json incomplete with a one-sentence reason', async () => {
    const { repo } = await gitRepo()
    const first = pending(await runLocal({ source: repo }))
    for (const task of first.tasks) await answer(task, first.workDir)
    const done = finished(await runLocal({ source: repo, finish: true }))

    expect(done.status).toBe('incomplete')
    expect(done.verdict).toBeNull()

    const reviewJsonPath = join(done.dir, 'trace', 'review.json')
    const reviewJson = JSON.parse(await readFile(reviewJsonPath, 'utf8')) as { status: string; reason: string | null }
    expect(reviewJson.status).toBe('incomplete')
    expect(typeof reviewJson.reason).toBe('string')
    expect(reviewJson.reason).not.toHaveLength(0)
    expect(reviewJson.reason).not.toContain('\n')
  })
})
