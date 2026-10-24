import { expect, it, vi } from 'vitest'
import { notionReader } from './notion'

const root = '11111111111111111111111111111111'
const db = '33333333333333333333333333333333'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

it('reads a linked database as a table of every row, paging through the data source', async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    const url = String(input).replaceAll('-', '')
    if (url.endsWith(`/pages/${root}/markdown`)) return json({ markdown: `| Adding a dependency | [https://app.notion.com/p/${db}](https://app.notion.com/p/${db}) |` })
    if (url.includes(`/pages/`)) return json({ object: 'error' }, 400)
    if (url.endsWith(`/databases/${db}`)) return json({ title: [{ plain_text: 'Approved Technologies' }], data_sources: [{ id: 'ds1', name: 'Approved Technologies' }] })
    const body = JSON.parse(String((request.mock.calls.at(-1)![1] as RequestInit).body)) as { start_cursor?: string }
    const row = (name: string, status: string) => ({ properties: { Name: { type: 'title', title: [{ plain_text: name }] }, Status: { type: 'select', select: { name: status } }, Place: { type: 'place' } } })
    return body.start_cursor ? json({ results: [row('yaml | npm', 'Adopt')], has_more: false, next_cursor: null }) : json({ results: [row('Zod', 'Adopt')], has_more: true, next_cursor: 'c2' })
  })
  const reader = notionReader('token', root, request)
  const signal = new AbortController().signal
  await reader.read(root, signal)
  const table = (await reader.read(`https://app.notion.com/p/${db}`, signal)).markdown
  expect(table).toBe('Database: Approved Technologies. Every row, as read from Notion.\n\n| Name | Status |\n| --- | --- |\n| Zod | Adopt |\n| yaml \\| npm | Adopt |\n')
  const posts = request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([input]) => String(input))
  expect(posts).toEqual([expect.stringMatching(/\/data_sources\/ds1\/query$/), expect.stringMatching(/\/data_sources\/ds1\/query$/)])
})

it('still fails a page that is neither readable as a page nor a database', async () => {
  const request = vi.fn<typeof fetch>(async (input) => String(input).replaceAll('-', '').endsWith(`/pages/${root}/markdown`) ? json({}, 403) : json({}, 404))
  await expect(notionReader('token', root, request).read(root, new AbortController().signal)).rejects.toThrow('Notion read failed (403)')
})
