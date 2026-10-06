// The one module that talks to a product's Feature Board in Notion: resolve a ticket, move it,
// set a property, push a child page, pull a child page. The board is a Notion data source whose
// URL the caller reads from the project's aspira.json. Uses NOTION_TOKEN, the same API base and
// version as knowledge.ts, and fetch, so a test stands up a mock Notion server and nothing else.

import { NOTION_API, NOTION_VERSION, pageIdFrom } from './knowledge.ts'
import { markdownToBlocks, notionToMarkdown, type Block } from './notion-markdown.ts'
import { propertyText } from './notion.ts'

export const BOARD_ENV = 'NOTION_TOKEN'

/** Notion appends at most 100 blocks per request, nested at most two levels deep. */
const APPEND_BATCH = 100
const APPEND_DEPTH = 2
const RETRIES = 5

export type BoardOptions = {
  /** The Feature Board data source: a `collection://` URL, a Notion URL, or an id. */
  board: string
  /** The integration token. Defaults to NOTION_TOKEN in the environment. */
  token?: string
  /** The API base, for tests that answer from a local server. */
  api?: string
  request?: typeof fetch
}

export type TicketRef = { kind: 'id'; prefix?: string; number: number } | { kind: 'url'; pageId: string }

export type TicketPage = { id: string; title: string; url: string; lastEditedAt: string }

export type Ticket = {
  /** The board ID as shown, such as NOM-4. */
  id: string
  number: number
  pageId: string
  title: string
  url: string
  status: string
  type?: string
  priority?: string
  area: string[]
  dev?: string
  pr?: string
  version?: string
  lastEditedAt: string
  /** The Idea body as plain markdown. */
  idea: string
  /** Child pages by title: Spec, Spec Reviewed, Plan, Implementation, and whatever else is there. */
  pages: Record<string, TicketPage>
}

export type Board = {
  resolveTicket(idOrUrl: string): Promise<Ticket>
  /** Sets Status to `to`, refusing when the current Status is not `from`. */
  moveTicket(page: Ticket | string, from: string, to: string): Promise<{ id: string; before: string; after: string }>
  setProperty(page: Ticket | string, name: string, value: string): Promise<void>
  /** Creates the child page with that title, or replaces the content of the one that exists (its URL stays). */
  pushPage(page: Ticket | string, title: string, markdown: string): Promise<{ id: string; url: string; created: boolean }>
  /** The child page with that title as plain markdown, or undefined when there is none. */
  pullPage(page: Ticket | string, title: string): Promise<(TicketPage & { markdown: string }) | undefined>
}

export class BoardError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  // Plain fields, not parameter properties: the agents run their TypeScript through amaro in strip-only mode, which refuses those.
  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'BoardError'
    this.status = status
    this.code = code
  }
}

/** A ticket argument: a board ID like NOM-4 (any case), a bare number, or a Notion page URL or id. */
export function parseTicketRef(input: string): TicketRef {
  const trimmed = input.trim()
  const id = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/)
  if (id) return { kind: 'id', prefix: id[1]!.toUpperCase(), number: Number(id[2]) }
  if (/^\d+$/.test(trimmed)) return { kind: 'id', number: Number(trimmed) }
  const pageId = trimmed === '' ? undefined : pageIdFrom(trimmed)
  if (pageId !== undefined) return { kind: 'url', pageId }
  throw new BoardError(`Not a ticket: "${input}" (expected an ID like NOM-4 or a Notion page URL)`)
}

/** The Idea body of a ticket page: the section under the Idea heading, or the whole body when there is none, without child page tags. */
export function ideaOf(notionMarkdown: string): string {
  const lines = notionMarkdown.split('\n').filter((line) => !/^\s*<page url="[^"]*">[^<]*<\/page>\s*$/.test(line))
  const sections: { heading?: string; body: string[] }[] = [{ body: [] }]
  for (const line of lines) {
    const heading = line.match(/^#{1,3} (.*)$/)
    if (heading) sections.push({ heading: heading[1]!.trim(), body: [] })
    else sections.at(-1)!.body.push(line)
  }
  const idea = sections.find((section) => section.heading?.toLowerCase() === 'idea')
  if (idea) return notionToMarkdown(idea.body.join('\n'))
  const kept = sections.filter((section) => section.heading === undefined || section.body.some((line) => line.trim() !== ''))
  return notionToMarkdown(kept.flatMap((section) => (section.heading === undefined ? section.body : [`## ${section.heading}`, ...section.body])).join('\n'))
}

type Property = Parameters<typeof propertyText>[0] & { unique_id?: { prefix?: string | null; number?: number | null } }
type PageObject = { id: string; url: string; last_edited_time: string; parent?: { type?: string; data_source_id?: string; database_id?: string }; properties: Record<string, Property> }
type SchemaProperty = { name: string; type: string; unique_id?: { prefix?: string | null }; select?: { options: { name: string }[] }; status?: { options: { name: string }[] } }
type Schema = { properties: Record<string, SchemaProperty> }
type ListResponse<T> = { results: T[]; has_more: boolean; next_cursor: string | null }
type ChildPageBlock = Block & { child_page?: { title?: string }; last_edited_time?: string }

const dashed = (id: string) => pageIdFrom(id) ?? id
const pageUrl = (id: string) => `https://www.notion.so/${id.replaceAll('-', '')}`

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function prune(block: Block, depth: number): Block {
  const { children, ...rest } = block
  if (depth === 0 || !children?.length) return rest
  return { ...rest, children: children.map((child) => prune(child, depth - 1)) }
}

function deeperThan(block: Block, depth: number): boolean {
  if (!block.children?.length) return false
  return depth === 0 || block.children.some((child) => deeperThan(child, depth - 1))
}

export function board(options: BoardOptions): Board {
  const request = options.request ?? fetch
  const api = options.api ?? NOTION_API
  const source = pageIdFrom(options.board)
  if (source === undefined) throw new BoardError(`Not a Notion data source URL or id: ${options.board}`)
  const token = options.token ?? process.env[BOARD_ENV]
  let schema: Promise<Schema> | undefined

  async function call<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
    if (!token) throw new BoardError(`${BOARD_ENV} is not set; the board needs the Notion integration token`)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    for (let attempt = 0; ; attempt += 1) {
      const response = await request(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      if (response.status === 429 && attempt < RETRIES) {
        await sleep(Number(response.headers.get('retry-after') ?? '1') * 1000)
        continue
      }
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
        throw new BoardError(`Notion ${response.status} (${error.code ?? 'error'}): ${error.message ?? response.statusText}`, response.status, error.code)
      }
      return (await response.json()) as T
    }
  }

  async function list<T>(path: string): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    do {
      const page = await call<ListResponse<T>>(`${path}?page_size=100${cursor === undefined ? '' : `&start_cursor=${cursor}`}`)
      out.push(...page.results)
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
    } while (cursor !== undefined)
    return out
  }

  const loadSchema = () => (schema ??= call<Schema>(`/data_sources/${source}`))

  async function property(name: string): Promise<SchemaProperty> {
    const found = Object.values((await loadSchema()).properties).find((candidate) => candidate.name === name)
    if (found === undefined) throw new BoardError(`"${name}" is not a property on this board`)
    return found
  }

  const options_ = (prop: SchemaProperty) => prop.select?.options ?? prop.status?.options

  function valueFor(prop: SchemaProperty, value: string): Record<string, unknown> {
    const choices = options_(prop)
    if (choices !== undefined && !choices.some((option) => option.name === value)) throw new BoardError(`"${value}" is not a ${prop.name} on this board`)
    switch (prop.type) {
      case 'select':
        return { select: { name: value } }
      case 'status':
        return { status: { name: value } }
      case 'multi_select':
        return { multi_select: value.split(',').map((name) => ({ name: name.trim() })) }
      case 'url':
        return { url: value }
      case 'number':
        return { number: Number(value) }
      case 'checkbox':
        return { checkbox: value === 'true' }
      case 'rich_text':
        return { rich_text: [{ type: 'text', text: { content: value } }] }
      case 'title':
        return { title: [{ type: 'text', text: { content: value } }] }
      default:
        throw new BoardError(`${prop.name} is a ${prop.type} property, which this module does not set`)
    }
  }

  const pageIdOf = (page: Ticket | string): string => {
    if (typeof page !== 'string') return page.pageId
    const id = pageIdFrom(page)
    if (id === undefined) throw new BoardError(`Not a Notion page URL or id: ${page}`)
    return id
  }

  const uniqueId = (page: PageObject): { id: string; number: number } => {
    const prop = Object.values(page.properties).find((candidate) => candidate.type === 'unique_id')
    const number = prop?.unique_id?.number ?? 0
    const prefix = prop?.unique_id?.prefix
    return { id: prefix ? `${prefix}-${number}` : String(number), number }
  }

  const text = (page: PageObject, name: string): string | undefined => {
    const value = page.properties[name] === undefined ? '' : propertyText(page.properties[name])
    return value === '' ? undefined : value
  }

  const children = (pageId: string) => list<ChildPageBlock>(`/blocks/${pageId}/children`)

  const childPages = (blocks: ChildPageBlock[]): Record<string, TicketPage> => {
    const pages: Record<string, TicketPage> = {}
    for (const block of blocks) {
      if (block.type !== 'child_page' || block.id === undefined) continue
      const title = block.child_page?.title ?? ''
      pages[title] ??= { id: dashed(block.id), title, url: pageUrl(block.id), lastEditedAt: block.last_edited_time ?? '' }
    }
    return pages
  }

  async function ticketFrom(page: PageObject): Promise<Ticket> {
    const title = Object.values(page.properties).find((candidate) => candidate.type === 'title')
    const pageId = dashed(page.id)
    const pages = childPages(await children(pageId))
    const markdown = await call<{ markdown?: string }>(`/pages/${pageId}/markdown`)
    return {
      ...uniqueId(page),
      pageId,
      title: title === undefined ? '' : propertyText(title),
      url: page.url,
      status: text(page, 'Status') ?? '',
      type: text(page, 'Type'),
      priority: text(page, 'Priority'),
      area: (page.properties.Area?.multi_select ?? []).map((option) => option.name ?? '').filter((name) => name !== ''),
      dev: text(page, 'Dev'),
      pr: text(page, 'PR'),
      version: text(page, 'Version'),
      lastEditedAt: page.last_edited_time,
      idea: ideaOf(markdown.markdown ?? ''),
      pages,
    }
  }

  async function findPage(ref: TicketRef): Promise<PageObject> {
    if (ref.kind === 'url') {
      const page = await call<PageObject>(`/pages/${ref.pageId}`)
      if (page.parent?.data_source_id === undefined || dashed(page.parent.data_source_id) !== source) throw new BoardError(`${page.url ?? ref.pageId} is not on this board`)
      return page
    }
    const idProperty = Object.values((await loadSchema()).properties).find((candidate) => candidate.type === 'unique_id')
    if (idProperty === undefined) throw new BoardError('This board has no ID property to resolve a ticket by')
    const prefix = idProperty.unique_id?.prefix ?? undefined
    if (ref.prefix !== undefined && ref.prefix !== (prefix ?? '').toUpperCase()) {
      throw new BoardError(`${ref.prefix}-${ref.number} is not on this board (its IDs are ${prefix ?? '<no prefix>'}-…)`)
    }
    const found = await call<ListResponse<PageObject>>(`/data_sources/${source}/query`, 'POST', { filter: { property: idProperty.name, unique_id: { equals: ref.number } }, page_size: 2 })
    const page = found.results[0]
    if (page === undefined) throw new BoardError(`No ticket ${prefix ? `${prefix}-` : ''}${ref.number} on the board`)
    return page
  }

  /** Appends blocks under a parent in batches, then attaches the levels Notion does not take in one request. */
  async function append(parentId: string, blocks: Block[]): Promise<void> {
    for (let offset = 0; offset < blocks.length; offset += APPEND_BATCH) {
      const batch = blocks.slice(offset, offset + APPEND_BATCH)
      const created = await call<ListResponse<Block>>(`/blocks/${parentId}/children`, 'PATCH', { children: batch.map((block) => prune(block, APPEND_DEPTH)) })
      await attachDeeper(created.results, batch)
    }
  }

  async function attachDeeper(created: Block[], originals: Block[]): Promise<void> {
    for (let i = 0; i < originals.length; i += 1) {
      const id = created[i]?.id
      if (id !== undefined && deeperThan(originals[i]!, APPEND_DEPTH)) await reattach(id, originals[i]!, APPEND_DEPTH)
    }
  }

  async function reattach(id: string, original: Block, depth: number): Promise<void> {
    const nested = original.children ?? []
    if (nested.length === 0) return
    if (depth === 0) return append(id, nested)
    if (!nested.some((child) => deeperThan(child, depth - 1))) return
    const kids = await children(id)
    for (let j = 0; j < nested.length; j += 1) {
      const kid = kids[j]?.id
      if (kid !== undefined) await reattach(kid, nested[j]!, depth - 1)
    }
  }

  return {
    async resolveTicket(idOrUrl) {
      return ticketFrom(await findPage(parseTicketRef(idOrUrl)))
    },

    async moveTicket(page, from, to) {
      const pageId = pageIdOf(page)
      const status = await property('Status')
      const value = valueFor(status, to)
      const current = await call<PageObject>(`/pages/${pageId}`)
      const before = text(current, 'Status') ?? ''
      const { id } = uniqueId(current)
      if (before !== from) throw new BoardError(`${id} is in "${before}", not "${from}"; not moving it to "${to}"`)
      await call(`/pages/${pageId}`, 'PATCH', { properties: { [status.name]: value } })
      return { id, before, after: to }
    },

    async setProperty(page, name, value) {
      const pageId = pageIdOf(page)
      const prop = await property(name)
      await call(`/pages/${pageId}`, 'PATCH', { properties: { [prop.name]: valueFor(prop, value) } })
    },

    async pushPage(page, title, markdown) {
      const pageId = pageIdOf(page)
      const blocks = markdownToBlocks(markdown)
      const existing = childPages(await children(pageId))[title]
      if (existing !== undefined) {
        for (const block of await children(existing.id)) if (block.id !== undefined) await call(`/blocks/${block.id}`, 'DELETE')
        await append(existing.id, blocks)
        return { id: existing.id, url: existing.url, created: false }
      }
      const head = blocks.slice(0, APPEND_BATCH)
      const created = await call<{ id: string; url: string }>('/pages', 'POST', {
        parent: { page_id: pageId },
        properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
        children: head.map((block) => prune(block, APPEND_DEPTH)),
      })
      if (head.some((block) => deeperThan(block, APPEND_DEPTH))) await attachDeeper(await children(created.id), head)
      await append(created.id, blocks.slice(APPEND_BATCH))
      return { id: dashed(created.id), url: created.url, created: true }
    },

    async pullPage(page, title) {
      const found = childPages(await children(pageIdOf(page)))[title]
      if (found === undefined) return undefined
      const result = await call<{ markdown?: string; truncated?: boolean }>(`/pages/${found.id}/markdown`)
      if (result.truncated) throw new BoardError(`Notion truncated the page "${title}" (${found.url}); not returning a partial copy`)
      return { ...found, markdown: notionToMarkdown(result.markdown ?? '') }
    },
  }
}
