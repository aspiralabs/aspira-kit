import { expect, it, vi } from 'vitest'
import { notionReader } from './notion.ts'

const root = '11111111-1111-1111-1111-111111111111'
const child = '22222222-2222-2222-2222-222222222222'

it('reads a page linked from the guidelines without listing first, refuses unlinked pages, shares fetches and only GETs pages', async () => {
  const outsider = '33333333-3333-3333-3333-333333333333'
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ markdown: `<mention-page url="https://app.notion.com/p/${child.replaceAll('-', '')}"/>` })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: 'Engineering rules' })))
  const reader = notionReader('test-token', root, request)
  const signal = new AbortController().signal
  // The child is linked from the index: one walk from the index finds it.
  expect((await reader.read(`https://www.notion.so/${child}`, signal)).markdown).toBe('Engineering rules')
  expect(request).toHaveBeenCalledTimes(2)
  await Promise.all([reader.read(root, signal), reader.read(child, signal)])
  expect(request).toHaveBeenCalledTimes(2)
  // Nothing links to the outsider: the walk ends without a request for it.
  await expect(reader.read(outsider, signal)).rejects.toThrow('outside')
  expect(request).toHaveBeenCalledTimes(2)
  for (const [, options] of request.mock.calls) expect(options?.method ?? 'GET').toBe('GET') // pages are GETs; only a database query POSTs
})

it('does not cache failed or truncated evidence', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ markdown: 'Partial', truncated: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: 'Complete' })))
  const reader = notionReader('test-token', root, request)
  const signal = new AbortController().signal
  await expect(reader.read(root, signal)).rejects.toThrow('truncated')
  expect((await reader.read(root, signal)).markdown).toBe('Complete')
})
