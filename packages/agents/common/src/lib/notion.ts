import { childPagesOf, pageIdFrom, NOTION_API, NOTION_VERSION } from './knowledge.ts'

/** Read-only, per-process cache scoped to the configured engineering index and discovered links. */
export function notionReader(token: string, rootPage: string, request: typeof fetch = fetch) {
  const root = pageIdFrom(rootPage)
  if (!token || !root) throw new Error('NOTION_TOKEN and KNOWLEDGE_PAGE are required')
  const allowed = new Set([root])
  const cache = new Map<string, Promise<{ pageId: string; source: string; markdown: string; fetchedAt: string }>>()
  
  async function read(page: string, signal: AbortSignal) {
    const id = pageIdFrom(page)
    if (!id) throw new Error('Not a Notion page URL or ID')
    if (!allowed.has(id)) throw new Error('Page is outside the discovered engineering guidelines. Call list_guidelines, then follow its page links.')
    let pending = cache.get(id)
    if (!pending) {
      pending = (async () => {
        const response = await request(`${NOTION_API}/pages/${id}/markdown`, {
          headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
          signal,
        })
        if (!response.ok) throw new Error(`Notion read failed (${response.status}); check integration page access`)
        const body = await response.json() as { markdown?: string; truncated?: boolean }
        if (!body.markdown || body.truncated) throw new Error('Notion returned empty or truncated guidelines; no complete evidence claimed')
        for (const child of childPagesOf(body.markdown)) allowed.add(child.id)
        for (const match of body.markdown.matchAll(/https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>")]+/g)) {
          const linked = pageIdFrom(match[0])
          if (linked) allowed.add(linked)
        }
        return { pageId: id, source: `https://www.notion.so/${id.replaceAll('-', '')}`, markdown: body.markdown, fetchedAt: new Date().toISOString() }
      })()
      cache.set(id, pending)
      pending.catch(() => { cache.delete(id) })
    }
    return pending
  }
  return { root, read }
}
