import { expect, it, vi } from 'vitest'
import { notionReader } from './notion.ts'

const root = '11111111-1111-1111-1111-111111111111'
const child = '22222222-2222-2222-2222-222222222222'

it('limits live reads to discovered pages, shares concurrent fetches and uses read-only requests', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ markdown: `<mention-page url="https://app.notion.com/p/${child.replaceAll('-', '')}"/>` })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: 'Engineering rules' })))
  const reader = notionReader('test-token', root, request)
  const signal = new AbortController().signal
  await expect(reader.read(child, signal)).rejects.toThrow('outside')
  expect(request).not.toHaveBeenCalled()
  await Promise.all([reader.read(root, signal), reader.read(root, signal)])
  expect(request).toHaveBeenCalledTimes(1)
  expect((await reader.read(`https://www.notion.so/${child}`, signal)).markdown).toBe('Engineering rules')
  expect(request).toHaveBeenCalledTimes(2)
  for (const [, options] of request.mock.calls) expect(options?.method ?? 'GET').toBe('GET')
})

it('does not cache failed or truncated evidence', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ markdown: 'Partial', truncated: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: 'Complete' })))
  const reader = notionReader('test-token', root, request)
  const signal = new AbortController().signal
  await expect(reader.read(root, signal)).rejects.toThrow('truncated')
  expect((await reader.read(root, signal)).markdown).toBe('Complete')
})
