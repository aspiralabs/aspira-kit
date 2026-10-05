import { childPagesOf, pageIdFrom, NOTION_API, NOTION_VERSION } from './knowledge.ts'

type Property = {
  type?: string
  title?: { plain_text?: string }[]
  rich_text?: { plain_text?: string }[]
  select?: { name?: string } | null
  status?: { name?: string } | null
  multi_select?: { name?: string }[]
  date?: { start?: string; end?: string | null } | null
  people?: { name?: string }[]
  checkbox?: boolean
  number?: number | null
  url?: string | null
}

/** One property value as table text. Types without a plain-text form render empty. */
export function propertyText(property: Property): string {
  const plain = (parts: { plain_text?: string }[] | undefined) => (parts ?? []).map((part) => part.plain_text ?? '').join('')
  switch (property.type) {
    case 'title': return plain(property.title)
    case 'rich_text': return plain(property.rich_text)
    case 'select': return property.select?.name ?? ''
    case 'status': return property.status?.name ?? ''
    case 'multi_select': return (property.multi_select ?? []).map((option) => option.name ?? '').join(', ')
    case 'date': return property.date ? [property.date.start, property.date.end].filter(Boolean).join(' to ') : ''
    case 'people': return (property.people ?? []).map((person) => person.name ?? '').filter(Boolean).join(', ')
    case 'checkbox': return property.checkbox ? 'yes' : 'no'
    case 'number': return property.number === null || property.number === undefined ? '' : String(property.number)
    case 'url': return property.url ?? ''
    default: return ''
  }
}

/** A database's rows as one markdown table per data source, title column first, empty columns dropped. */
export function renderDatabase(title: string, sources: { name: string; rows: Record<string, Property>[] }[]): string {
  const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const tables = sources.map(({ name, rows }) => {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
      .filter((column) => rows.some((row) => propertyText(row[column] ?? {}) !== ''))
      .sort((a, b) => Number(rows[0]?.[b]?.type === 'title') - Number(rows[0]?.[a]?.type === 'title'))
    const lines = [`| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${columns.map((column) => cell(propertyText(row[column] ?? {}))).join(' | ')} |`)]
    return `${sources.length > 1 ? `## ${name}\n\n` : ''}${lines.join('\n')}`
  })
  return `Database: ${title}. Every row, as read from Notion.\n\n${tables.join('\n\n')}\n`
}

/** Read-only, per-process cache scoped to the configured engineering index and discovered links.
 * A linked Notion database (such as Approved Technologies) is read as a table of its rows. */
export function notionReader(token: string, rootPage: string, request: typeof fetch = fetch) {
  const root = pageIdFrom(rootPage)
  if (!token || !root) throw new Error('NOTION_TOKEN and KNOWLEDGE_PAGE are required')
  const allowed = new Set([root])
  const cache = new Map<string, Promise<{ pageId: string; source: string; markdown: string; fetchedAt: string }>>()
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }

  // Querying a data source is a POST, but it only reads.
  async function call<T>(path: string, signal: AbortSignal, body?: unknown): Promise<{ ok: true; value: T } | { ok: false; status: number }> {
    const response = await request(`${NOTION_API}${path}`, body === undefined ? { headers, signal } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    return response.ok ? { ok: true, value: await response.json() as T } : { ok: false, status: response.status }
  }

  async function database(id: string, signal: AbortSignal): Promise<string | null> {
    const found = await call<{ title?: { plain_text?: string }[]; data_sources?: { id: string; name?: string }[] }>(`/databases/${id}`, signal)
    if (!found.ok) return null
    const sources: { name: string; rows: Record<string, Property>[] }[] = []
    for (const source of found.value.data_sources ?? []) {
      const rows: Record<string, Property>[] = []
      let cursor: string | undefined
      do {
        const page = await call<{ results: { properties: Record<string, Property> }[]; has_more: boolean; next_cursor: string | null }>(`/data_sources/${source.id}/query`, signal, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
        if (!page.ok) throw new Error(`Notion read failed (${page.status}); check integration access to the database`)
        rows.push(...page.value.results.map((result) => result.properties))
        cursor = page.value.has_more ? page.value.next_cursor ?? undefined : undefined
      } while (cursor)
      sources.push({ name: source.name ?? 'Rows', rows })
    }
    return renderDatabase((found.value.title ?? []).map((part) => part.plain_text ?? '').join('') || 'Untitled', sources)
  }

  async function read(page: string, signal: AbortSignal) {
    const id = pageIdFrom(page)
    if (!id) throw new Error('Not a Notion page URL or ID')
    if (!allowed.has(id)) throw new Error('Page is outside the discovered engineering guidelines. Call list_guidelines, then follow its page links.')
    let pending = cache.get(id)
    if (!pending) {
      pending = (async () => {
        const result = await call<{ markdown?: string; truncated?: boolean }>(`/pages/${id}/markdown`, signal)
        let markdown: string
        if (result.ok) {
          if (!result.value.markdown || result.value.truncated) throw new Error('Notion returned empty or truncated guidelines; no complete evidence claimed')
          markdown = result.value.markdown
        } else {
          // Not a page: a linked database answers on its own endpoint.
          const table = result.status === 400 || result.status === 404 ? await database(id, signal) : null
          if (table === null) throw new Error(`Notion read failed (${result.status}); check integration page access`)
          markdown = table
        }
        for (const child of childPagesOf(markdown)) allowed.add(child.id)
        for (const match of markdown.matchAll(/https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>")\]]+/g)) {
          const linked = pageIdFrom(match[0])
          if (linked) allowed.add(linked)
        }
        return { pageId: id, source: `https://www.notion.so/${id.replaceAll('-', '')}`, markdown, fetchedAt: new Date().toISOString() }
      })()
      cache.set(id, pending)
      pending.catch(() => { cache.delete(id) })
    }
    return pending
  }
  return { root, read }
}
