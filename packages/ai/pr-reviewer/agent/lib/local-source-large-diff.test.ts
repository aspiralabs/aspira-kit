// A PR whose diff GitHub refuses through the API (406, too large) is still reviewable: the diff is
// rebuilt from the PR's paged file list instead of ending the review.
import { describe, expect, it } from 'vitest'
import { fetchPrDiff, type Fetch } from './local-source.ts'

const pr = { owner: 'aspiralabs', name: 'aspira-kit', number: 163 }

/** GitHub as the reviewer sees it: the diff media type refused, the file list served 100 a page. */
function github(files: { filename: string; previous_filename?: string; status: string; patch?: string }[]): { request: Fetch; urls: string[] } {
  const urls: string[] = []
  const request: Fetch = async (url, init) => {
    const href = String(url)
    urls.push(href)
    if (new Headers(init?.headers).get('accept') === 'application/vnd.github.diff') return new Response('too large', { status: 406 })
    const page = Number(new URL(href).searchParams.get('page'))
    return Response.json(files.slice((page - 1) * 100, page * 100))
  }
  return { request, urls }
}

const many = Array.from({ length: 101 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified', patch: `@@ -1 +1 @@\n-a${i}\n+b${i}` }))

describe('a PR diff too large for the API', () => {
  it('is rebuilt from every page of the file list, one diff --git block per file', async () => {
    const { request, urls } = github(many)
    const diff = await fetchPrDiff(pr, 'tok', request)
    expect({
      changed: diff.changed.length,
      pages: urls.filter((url) => url.includes('/files?')).length,
      first: diff.patch.split('\n').slice(0, 6),
    }).toEqual({
      changed: 101,
      pages: 2,
      first: ['diff --git a/src/f0.ts b/src/f0.ts', '--- a/src/f0.ts', '+++ b/src/f0.ts', '@@ -1 +1 @@', '-a0', '+b0'],
    })
  })

  it('writes added, removed and renamed files with their own headers, and lists a file GitHub sent no patch for', async () => {
    const { request } = github([
      { filename: 'new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' },
      { filename: 'old.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-x' },
      { filename: 'packages/ai/a.ts', previous_filename: 'packages/kit/a.ts', status: 'renamed' },
      { filename: 'logo.png', status: 'modified' },
    ])
    const diff = await fetchPrDiff(pr, 'tok', request)
    expect({ changed: diff.changed, lines: diff.patch.split('\n') }).toEqual({
      changed: ['new.ts', 'old.ts', 'packages/ai/a.ts', 'logo.png'],
      lines: [
        'diff --git a/new.ts b/new.ts', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+x',
        'diff --git a/old.ts b/old.ts', '--- a/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
        'diff --git a/packages/kit/a.ts b/packages/ai/a.ts', '--- a/packages/kit/a.ts', '+++ b/packages/ai/a.ts', 'renamed from packages/kit/a.ts',
        'diff --git a/logo.png b/logo.png', '--- a/logo.png', '+++ b/logo.png', 'GitHub sent no patch for this file (binary or too large)',
        '',
      ],
    })
  })
})
