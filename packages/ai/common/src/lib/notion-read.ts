// Read-only Notion tools for the cloud agents' AI SDK phases (KIT-54): a page as markdown, a
// database as a markdown table of its rows, and a title search. They use the integration token
// the agent already has for load-knowledge (NOTION_TOKEN), so every phase that can raise a gap can
// open the page or the database the gap is about instead of leaving it to the approver. Reads
// only: no endpoint here creates, updates or archives anything.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { NOTION_API, NOTION_VERSION, pageIdFrom } from './knowledge.ts'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type NotionReadOptions = {
  token: string
  fetch?: Fetch
  /** Rows a database read returns at most (the table is for a phase's context, not an export). */
  maxRows?: number
  /** Characters of page markdown returned at most; a longer page is cut with a notice. */
  maxChars?: number
}

const DATABASE_NOT_PAGE = /is a database, not a page/i
const DEFAULT_MAX_ROWS = 300
const DEFAULT_MAX_CHARS = 60_000

type Property = { type?: string; [key: string]: unknown }
type Row = { id?: string; url?: string; properties?: Record<string, Property> }

const plain = (parts: unknown): string => (Array.isArray(parts) ? parts.map((part) => (part as { plain_text?: string }).plain_text ?? '').join('') : '')

/** One property's value as a cell: the text a human reads in Notion, flattened, never the raw JSON. */
export function cellOf(property: Property | undefined): string {
  if (property === undefined) return ''
  const value = property[property.type ?? ''] as unknown
  switch (property.type) {
    case 'title':
    case 'rich_text':
      return plain(value)
    case 'select':
    case 'status':
      return (value as { name?: string } | null)?.name ?? ''
    case 'multi_select':
      return Array.isArray(value) ? value.map((option) => (option as { name?: string }).name ?? '').join(', ') : ''
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof value === 'string' ? value : ''
    case 'number':
      return value === null || value === undefined ? '' : String(value)
    case 'checkbox':
      return value ? 'yes' : 'no'
    case 'date': {
      const date = value as { start?: string; end?: string } | null
      return date?.start === undefined ? '' : date.end ? `${date.start} to ${date.end}` : date.start
    }
    case 'people':
      return Array.isArray(value) ? value.map((person) => (person as { name?: string }).name ?? '').filter(Boolean).join(', ') : ''
    case 'relation':
      return Array.isArray(value) ? `${value.length} linked` : ''
    case 'formula': {
      const formula = value as { type?: string; string?: string; number?: number; boolean?: boolean; date?: { start?: string } } | null
      if (!formula) return ''
      return formula.string ?? (formula.number === undefined ? (formula.boolean === undefined ? (formula.date?.start ?? '') : formula.boolean ? 'yes' : 'no') : String(formula.number))
    }
    case 'unique_id': {
      const id = value as { prefix?: string | null; number?: number } | null
      return id?.number === undefined ? '' : `${id.prefix ? `${id.prefix}-` : ''}${id.number}`
    }
    case 'created_time':
    case 'last_edited_time':
      return typeof value === 'string' ? value : ''
    default:
      return ''
  }
}

/** The rows as one markdown table: the title column first, then every other property in the order the first row lists them, pipes escaped. */
export function renderRows(rows: Row[]): string {
  if (rows.length === 0) return 'No rows.'
  const columns: string[] = []
  for (const row of rows) {
    for (const [name, property] of Object.entries(row.properties ?? {})) {
      if (columns.includes(name)) continue
      if (property.type === 'title') columns.unshift(name)
      else columns.push(name)
    }
  }
  const escape = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [`| ${columns.map(escape).join(' | ')} | URL |`, `| ${columns.map(() => '---').join(' | ')} | --- |`]
  for (const row of rows) lines.push(`| ${columns.map((name) => escape(cellOf(row.properties?.[name]))).join(' | ')} | ${row.url ?? ''} |`)
  return lines.join('\n')
}

/** The read-only Notion tools for a phase: `notion_read` (a page's markdown or a database's rows) and `notion_search` (titles). Absent when there is no token. */
export function notionReadTools(options: NotionReadOptions): ToolSet {
  const request: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const headers = { Authorization: `Bearer ${options.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' }

  async function call<T>(path: string, init?: RequestInit, signal?: AbortSignal, retries = 3): Promise<{ ok: true; body: T } | { ok: false; status: number; text: string }> {
    let response: Response
    try {
      response = await request(`${NOTION_API}${path}`, { ...init, headers, ...(signal ? { signal } : {}) })
    } catch (error) {
      return { ok: false, status: 0, text: `could not reach Notion: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (response.status === 429) {
      // Rate limited: wait as told, at most three times, and never past the phase's abort.
      if (retries === 0 || signal?.aborted) return { ok: false, status: 429, text: 'rate limited by Notion; try again later' }
      await new Promise((done) => setTimeout(done, Math.min(Number(response.headers.get('retry-after') ?? '1') * 1000, 10_000)))
      return call<T>(path, init, signal, retries - 1)
    }
    if (!response.ok) return { ok: false, status: response.status, text: (await response.text()).slice(0, 300) }
    return { ok: true, body: (await response.json()) as T }
  }

  async function databaseRows(id: string, signal?: AbortSignal): Promise<string> {
    const database = await call<{ title?: unknown; data_sources?: { id: string; name?: string }[] }>(`/databases/${id}`, undefined, signal)
    if (!database.ok) return `Notion ${database.status} on the database ${id}: ${database.text}`
    const title = plain(database.body.title) || id
    const source = database.body.data_sources?.[0]?.id
    const rows: Row[] = []
    let cursor: string | undefined
    let truncated = false
    do {
      const page = source === undefined
        ? await call<{ results?: Row[]; next_cursor?: string | null; has_more?: boolean }>(`/databases/${id}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) }, signal)
        : await call<{ results?: Row[]; next_cursor?: string | null; has_more?: boolean }>(`/data_sources/${source}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) }, signal)
      if (!page.ok) return `Notion ${page.status} querying the database "${title}": ${page.text}`
      rows.push(...(page.body.results ?? []))
      cursor = page.body.has_more && page.body.next_cursor ? page.body.next_cursor : undefined
      if (rows.length >= maxRows) {
        truncated = cursor !== undefined || rows.length > maxRows
        rows.length = Math.min(rows.length, maxRows)
        cursor = undefined
      }
    } while (cursor !== undefined)
    return `# ${title} (database, ${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? `, first ${maxRows} shown` : ''})\n\n${renderRows(rows)}`
  }

  async function read(target: string, signal?: AbortSignal): Promise<string> {
    const id = pageIdFrom(target.trim())
    if (id === undefined) return `Not a Notion page or database URL or id: ${target}`
    const page = await call<{ markdown?: string; truncated?: boolean }>(`/pages/${id}/markdown`, undefined, signal)
    if (page.ok) {
      const markdown = page.body.markdown ?? ''
      const cut = markdown.length > maxChars
      return `${cut ? markdown.slice(0, maxChars) : markdown}${cut || page.body.truncated ? '\n\n[The page is longer than what is shown here.]' : ''}`
    }
    if (page.status === 400 && DATABASE_NOT_PAGE.test(page.text)) return databaseRows(id, signal)
    const hint = page.status === 404 || page.status === 403 ? ' (is the page shared with the integration?)' : ''
    return `Notion ${page.status} on ${id}${hint}: ${page.text}`
  }

  async function search(query: string, signal?: AbortSignal): Promise<string> {
    const found = await call<{ results?: { object?: string; id?: string; url?: string; title?: unknown; properties?: Record<string, Property> }[] }>('/search', { method: 'POST', body: JSON.stringify({ query, page_size: 10 }) }, signal)
    if (!found.ok) return `Notion ${found.status} searching "${query}": ${found.text}`
    const lines = (found.body.results ?? []).map((item) => {
      const title = item.object === 'database' || item.object === 'data_source' ? plain(item.title) : cellOf(Object.values(item.properties ?? {}).find((property) => property.type === 'title'))
      return `- ${title || '(untitled)'} (${item.object ?? 'page'}): ${item.url ?? item.id ?? ''}`
    })
    return lines.length ? lines.join('\n') : `Nothing in Notion matches "${query}" (shared with the integration).`
  }

  return {
    notion_read: tool({
      description: 'Read one Notion page (returns its markdown) or one Notion database (returns its rows as a markdown table, title column first) by URL or id. Read-only. Use it for any page or database the guidelines, the ticket, the idea or the spec point to (Approved Technologies, ADRs, decision pages) before reporting a gap about it.',
      inputSchema: z.object({ url: z.string().min(1).describe('The Notion page or database URL, or its id') }),
      execute: async ({ url }, options) => read(url, options?.abortSignal),
    }),
    notion_search: tool({
      description: 'Find Notion pages and databases by title (up to 10), with their URLs, to read with notion_read. Read-only.',
      inputSchema: z.object({ query: z.string().min(1).describe('Words from the title, for example "Approved Technologies"') }),
      execute: async ({ query }, options) => search(query, options?.abortSignal),
    }),
  }
}

/** The Notion read tools when the environment has a token, else none: a phase without them still has its other tools. */
export function notionReadToolsFromEnv(env: NodeJS.ProcessEnv = process.env): ToolSet {
  const token = env.NOTION_TOKEN?.trim()
  return token ? notionReadTools({ token }) : {}
}
