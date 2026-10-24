// The one module that talks to a product's Feature Board in Notion: resolve a ticket, move it,
// set a property, push a child page, pull a child page. The board is a Notion data source whose
// URL the caller reads from the project's aspira.json. Uses NOTION_TOKEN, the same API base and
// version as knowledge.ts, and fetch, so a test stands up a mock Notion server and nothing else.

import { z } from 'zod'
import { GROOMER_MARKER_PREFIX } from './groom-record.ts'
import { KNOWLEDGE_ENV, MAX_DEPTH, MAX_PAGES, NOTION_API, NOTION_VERSION, childPagesOf, pageIdFrom } from './knowledge.ts'
import { chunkText, markdownToBlocks, notionToMarkdown, type Block } from './notion-markdown.ts'
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
  /** Child pages by title: Spec, Spec Reviewed, Plan, Implementation, and whatever else is there. The first of a repeated title. */
  pages: Record<string, TicketPage>
  /** Every title the ticket has more than one child page of, with all of those pages in page order. Absent when there is none. */
  duplicatePages?: { title: string; pages: TicketPage[] }[]
}

/** A to-do block of a page: its tick, its plain text and the user who last edited it, when Notion says. */
export type ToDo = { id: string; checked: boolean; text: string; lastEditedBy?: { id: string } }

export type Board = {
  resolveTicket(idOrUrl: string): Promise<Ticket>
  /** Sets Status to `to`, refusing when the current Status is not `from`. */
  moveTicket(page: Ticket | string, from: string, to: string): Promise<{ id: string; before: string; after: string }>
  setProperty(page: Ticket | string, name: string, value: string): Promise<void>
  /** Creates the child page with that title, or replaces the content of the one that exists (its URL stays). */
  pushPage(page: Ticket | string, title: string, markdown: string): Promise<{ id: string; url: string; created: boolean; lastEditedAt: string }>
  /** The child page with that title as plain markdown, or undefined when there is none. */
  pullPage(page: Ticket | string, title: string): Promise<(TicketPage & { markdown: string }) | undefined>
  /** Creates a child page with that title and the markdown as its blocks, whether or not one with that title exists. */
  createPage(page: Ticket | string, title: string, markdown: string): Promise<{ id: string; url: string }>
  /** Appends one paragraph of literal text to a page and returns the created block's id. */
  appendParagraph(pageId: string, text: string): Promise<{ id: string }>
  /** Deletes (archives) one block. Callers only pass ids of blocks they created. */
  deleteBlock(id: string): Promise<void>
  /**
   * Replaces the content of the child page with that title, append-first: the new blocks are appended below the
   * existing ones, and only after every append succeeded are the previous blocks deleted (never a child page,
   * child database or synced block). Returns the page object's last edit after the writes.
   */
  replacePage(page: Ticket | string, title: string, markdown: string): Promise<{ id: string; url: string; lastEditedAt: string }>
  /**
   * Writes the groomer's Idea summary into the ticket body: replaces a previous summary found by its marker
   * paragraph, or inserts after the Idea prose, or adds `## Idea` when the body has none. Never deletes a block
   * it did not write. Returns the ids it created and the ids it deleted.
   */
  writeIdeaSummary(page: Ticket | string, markdown: string): Promise<{ ids: string[]; deleted: string[] }>
  /** Every to-do block at the top level of a page, in page order. */
  listToDos(pageId: string): Promise<ToDo[]>
  /** The integration's own user. */
  me(): Promise<{ id: string }>
  /** Uploads a JSON file to Notion (create, then a multipart send) and returns the upload's id and status. Never the upload URL. */
  uploadFile(name: string, content: string): Promise<{ id: string; status: string }>
  /** Appends one file block naming a finished upload to the end of a page and returns the created block's id. */
  appendFileBlock(pageId: string, uploadId: string): Promise<{ id: string }>
  /** The names of the file blocks at the top level of a page, in page order, across every page of the block list. */
  fileBlockNames(pageId: string): Promise<string[]>
  /** The Feature Board rules page as markdown, found by the knowledge walk from KNOWLEDGE_PAGE; null when it cannot be found or read. */
  rulesPage(): Promise<string | null>
}

/** The `code` of a BoardError that means the board answered and has no such ticket, as opposed to a board that could not answer. */
export const NOT_FOUND = 'not_found'

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
// The Idea ends at the next heading of its own level or shallower, so `###` subsections under `## Idea` stay in it.
export function ideaOf(notionMarkdown: string): string {
  const lines = notionMarkdown.split('\n').filter((line) => !/^\s*<page url="[^"]*">[^<]*<\/page>\s*$/.test(line))
  type Section = { level: number; heading?: string; line: string; body: string[] }
  let current: Section = { level: 0, line: '', body: [] }
  const sections: Section[] = [current]
  for (const line of lines) {
    const heading = line.match(/^(#{1,3}) (.*)$/)
    if (heading === null) {
      current.body.push(line)
      continue
    }
    current = { level: heading[1]?.length ?? 0, heading: (heading[2] ?? '').trim(), line, body: [] }
    sections.push(current)
  }
  const at = sections.findIndex((section) => section.heading?.toLowerCase() === 'idea')
  const idea = sections[at]
  if (idea !== undefined) {
    const out = [...idea.body]
    for (const section of sections.slice(at + 1)) {
      if (section.level <= idea.level) break
      out.push(section.line, ...section.body)
    }
    return notionToMarkdown(out.join('\n'))
  }
  const kept = sections.filter((section) => section.heading === undefined || section.body.some((line) => line.trim() !== ''))
  return notionToMarkdown(kept.flatMap((section) => (section.heading === undefined ? section.body : [section.line, ...section.body])).join('\n'))
}

type Property = Parameters<typeof propertyText>[0] & { unique_id?: { prefix?: string | null; number?: number | null } }
type PageObject = { id: string; url: string; last_edited_time: string; parent?: { type?: string; data_source_id?: string; database_id?: string }; properties: Record<string, Property> }
type SchemaProperty = { name: string; type: string; unique_id?: { prefix?: string | null }; select?: { options: { name: string }[] }; status?: { options: { name: string }[] } }
type Schema = { properties: Record<string, SchemaProperty> }
type ListResponse<T> = { results: T[]; has_more: boolean; next_cursor: string | null }
type ChildPageBlock = Block & { child_page?: { title?: string }; last_edited_time?: string }

// The shapes the groomer's methods read, validated at the network boundary (TS-004).
const BlockShape = z.looseObject({ id: z.string(), type: z.string(), has_children: z.boolean().optional() })
type BlockShape = z.output<typeof BlockShape>
const Created = z.object({ results: z.array(BlockShape) })
const PageShape = z.object({ id: z.string(), url: z.string(), last_edited_time: z.string() })
const UserShape = z.object({ id: z.string() })
const RichTextShape = z.array(z.object({ plain_text: z.string().optional(), text: z.object({ content: z.string() }).optional() }))
const TextBody = z.object({ rich_text: RichTextShape })
const ToDoBody = z.object({ rich_text: RichTextShape, checked: z.boolean() })
const LastEditedBy = z.object({ last_edited_by: z.object({ id: z.string() }).optional() })
/** A Notion file upload as the create and send answers carry it. Its upload URL is never read. */
export const UploadShape = z.object({ id: z.string(), status: z.string() })
const FileBody = z.object({ name: z.string() })
const MarkdownShape = z.object({ markdown: z.string(), truncated: z.boolean().optional() })

/** The title of the guidelines page that holds the Feature Board rules. */
const RULES_TITLE = 'feature board'

/** Blocks a write never deletes: deleting one archives a page, a database or content shared elsewhere. */
const KEPT_TYPES = new Set(['child_page', 'child_database', 'synced_block'])
const IDEA_SUMMARY_REFUSED = 'cannot write the Idea summary without rewriting the Idea section'

const plainOf = (rich: z.output<typeof RichTextShape>): string => rich.map((part) => part.plain_text ?? part.text?.content ?? '').join('')

/** The plain text of a block's rich text, or '' for a block that has none. */
function blockText(block: BlockShape): string {
  const body = TextBody.safeParse(block[block.type])
  return body.success ? plainOf(body.data.rich_text) : ''
}

/** 1, 2 or 3 for a heading block, undefined for anything else. */
function headingLevel(block: BlockShape): number | undefined {
  const match = block.type.match(/^heading_([123])$/)
  return match === null ? undefined : Number(match[1])
}

const isHeading3 = (block: BlockShape | undefined, text: string): boolean => block !== undefined && block.type === 'heading_3' && blockText(block).trim() === text

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

/**
 * A page's raw Notion markdown and whether Notion truncated it, straight from `/pages/<id>/markdown`,
 * with no `notionToMarkdown` conversion: the implementor's plan-block recovery (plan-block.ts) hashes
 * and parses this exact text, which is what was actually on the page, not `pullPage`'s converted copy.
 * Kept off the `Board` interface itself (every other caller's mocks need not implement it) and only
 * on `board()`'s own return type.
 */
export type BoardWithPageMarkdown = Board & { pageMarkdown(pageId: string): Promise<{ markdown: string; truncated: boolean }> }

export function board(options: BoardOptions): BoardWithPageMarkdown {
  const request = options.request ?? fetch
  const api = options.api ?? NOTION_API
  const given = pageIdFrom(options.board)
  if (given === undefined) throw new BoardError(`Not a Notion data source URL or id: ${options.board}`)
  const token = options.token ?? process.env[BOARD_ENV]
  let schema: Promise<Schema> | undefined
  // The id aspira.json holds is whatever a person copied: the Feature Board's database page URL
  // (what Notion shows) or its data source id (what the API queries). Resolved once, on first use.
  let source: string = given

  // The one request path. A FormData body goes as is, so fetch sets the multipart boundary; any other body is JSON.
  async function call<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
    if (!token) throw new BoardError(`${BOARD_ENV} is not set; the board needs the Notion integration token`)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }
    const multipart = body instanceof FormData
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json'
    const payload = body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    for (let attempt = 0; ; attempt += 1) {
      const response = await request(`${api}${path}`, { method, headers, body: payload })
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

  // A database page id answers 404 on /data_sources; then ask the database for its data sources.
  const loadSchema = () =>
    (schema ??= call<Schema>(`/data_sources/${source}`).catch(async (error: unknown) => {
      if (!(error instanceof BoardError) || error.status !== 404) throw error
      const database = await call<{ data_sources?: { id: string; name?: string }[] }>(`/databases/${given}`)
      const first = database.data_sources?.[0]?.id
      if (first === undefined) throw new BoardError(`${options.board} is a database with no data source`)
      source = first
      return call<Schema>(`/data_sources/${source}`)
    }))
  const dataSource = async () => {
    await loadSchema()
    return source
  }

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

  /** The child pages by title, the first of a repeated title in `pages`, and every repeated title with all of its pages in `duplicates`. */
  const childPages = (blocks: ChildPageBlock[]): { pages: Record<string, TicketPage>; duplicates: { title: string; pages: TicketPage[] }[] } => {
    const pages: Record<string, TicketPage> = {}
    const byTitle: Record<string, TicketPage[]> = {}
    for (const block of blocks) {
      if (block.type !== 'child_page' || block.id === undefined) continue
      const title = block.child_page?.title ?? ''
      const page = { id: dashed(block.id), title, url: pageUrl(block.id), lastEditedAt: block.last_edited_time ?? '' }
      pages[title] ??= page
      ;(byTitle[title] ??= []).push(page)
    }
    const duplicates = Object.entries(byTitle)
      .filter(([, list]) => list.length > 1)
      .map(([title, list]) => ({ title, pages: list }))
    return { pages, duplicates }
  }

  async function ticketFrom(page: PageObject): Promise<Ticket> {
    const title = Object.values(page.properties).find((candidate) => candidate.type === 'title')
    const pageId = dashed(page.id)
    const { pages, duplicates } = childPages(await children(pageId))
    const markdown = await call<{ markdown?: string; truncated?: boolean }>(`/pages/${pageId}/markdown`)
    const titleText = title === undefined ? '' : propertyText(title)
    if (markdown.truncated) throw new BoardError(`Notion truncated the page "${titleText}" (${page.url}); not returning a partial copy`)
    return {
      ...uniqueId(page),
      pageId,
      title: titleText,
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
      ...(duplicates.length === 0 ? {} : { duplicatePages: duplicates }),
    }
  }

  async function findPage(ref: TicketRef): Promise<PageObject> {
    if (ref.kind === 'url') {
      const page = await call<PageObject>(`/pages/${ref.pageId}`)
      if (page.parent?.data_source_id === undefined || dashed(page.parent.data_source_id) !== source) throw new BoardError(`${page.url ?? ref.pageId} is not on this board`, undefined, NOT_FOUND)
      return page
    }
    const idProperty = Object.values((await loadSchema()).properties).find((candidate) => candidate.type === 'unique_id')
    if (idProperty === undefined) throw new BoardError('This board has no ID property to resolve a ticket by')
    const prefix = idProperty.unique_id?.prefix ?? undefined
    if (ref.prefix !== undefined && ref.prefix !== (prefix ?? '').toUpperCase()) {
      throw new BoardError(`${ref.prefix}-${ref.number} is not on this board (its IDs are ${prefix ?? '<no prefix>'}-…)`, undefined, NOT_FOUND)
    }
    const found = await call<ListResponse<PageObject>>(`/data_sources/${await dataSource()}/query`, 'POST', { filter: { property: idProperty.name, unique_id: { equals: ref.number } }, page_size: 2 })
    const page = found.results[0]
    if (page === undefined) throw new BoardError(`No ticket ${prefix ? `${prefix}-` : ''}${ref.number} on the board`, undefined, NOT_FOUND)
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

  /** A call whose answer is checked against a schema before anything reads it. */
  async function parsed<S extends z.ZodType>(schema: S, path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown): Promise<z.output<S>> {
    const result = schema.safeParse(await call<unknown>(path, method, body))
    if (!result.success) throw new BoardError(`Notion answered ${method} ${path} with an unexpected shape: ${result.error.message}`)
    return result.data
  }

  /** The top-level blocks of a page, every page of the list, each checked for an id and a type. */
  async function blocksOf(pageId: string): Promise<BlockShape[]> {
    return (await list<unknown>(`/blocks/${pageId}/children`)).map((block) => {
      const result = BlockShape.safeParse(block)
      if (!result.success) throw new BoardError(`Notion answered a block under ${pageId} with an unexpected shape: ${result.error.message}`)
      return result.data
    })
  }

  /** Creates a child page holding the blocks: the first batch with the page, the rest appended. */
  async function create(pageId: string, title: string, blocks: Block[]): Promise<{ id: string; url: string }> {
    const head = blocks.slice(0, APPEND_BATCH)
    const created = await call<{ id: string; url: string }>('/pages', 'POST', {
      parent: { page_id: pageId },
      properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
      children: head.map((block) => prune(block, APPEND_DEPTH)),
    })
    if (head.some((block) => deeperThan(block, APPEND_DEPTH))) await attachDeeper(await children(created.id), head)
    await append(created.id, blocks.slice(APPEND_BATCH))
    return { id: dashed(created.id), url: created.url }
  }

  /** Inserts blocks right after a block, in order, batch by batch. Returns the created top-level ids. */
  async function insertAfter(parentId: string, afterId: string, blocks: Block[]): Promise<string[]> {
    const ids: string[] = []
    let after = afterId
    for (let offset = 0; offset < blocks.length; offset += APPEND_BATCH) {
      const batch = blocks.slice(offset, offset + APPEND_BATCH)
      const created = await parsed(Created, `/blocks/${parentId}/children`, 'PATCH', {
        children: batch.map((block) => prune(block, APPEND_DEPTH)),
        position: { type: 'after_block', after_block: { id: after } },
      }).catch((error: unknown) => {
        if (error instanceof BoardError && error.status === 400) throw new BoardError(IDEA_SUMMARY_REFUSED, error.status, error.code)
        throw error
      })
      await attachDeeper(created.results, batch)
      ids.push(...created.results.map((block) => block.id))
      after = ids.at(-1) ?? after
    }
    return ids
  }

  /** Appends blocks at the end of a parent and returns the created top-level ids. */
  async function appendReturning(parentId: string, blocks: Block[]): Promise<string[]> {
    const ids: string[] = []
    for (let offset = 0; offset < blocks.length; offset += APPEND_BATCH) {
      const batch = blocks.slice(offset, offset + APPEND_BATCH)
      const created = await parsed(Created, `/blocks/${parentId}/children`, 'PATCH', { children: batch.map((block) => prune(block, APPEND_DEPTH)) })
      await attachDeeper(created.results, batch)
      ids.push(...created.results.map((block) => block.id))
    }
    return ids
  }

  /** The board ID of a ticket for a message: from the ticket, or read from its page. */
  async function ticketIdOf(page: Ticket | string): Promise<string> {
    if (typeof page !== 'string') return page.id
    return uniqueId(await call<PageObject>(`/pages/${pageIdOf(page)}`)).id
  }

  /**
   * The groomer's previous summary inside the Idea range, found by its marker paragraph directly above a
   * `Decisions` heading_3, walked through its shape: marker, Decisions heading and bulleted items, Terms
   * heading and bulleted items or `None introduced.`. Any other block inside that shape refuses.
   */
  function previousSummary(range: BlockShape[]): BlockShape[] | undefined {
    const start = range.findIndex((block, i) => block.type === 'paragraph' && blockText(block).startsWith(GROOMER_MARKER_PREFIX) && isHeading3(range[i + 1], 'Decisions'))
    if (start === -1) return undefined
    const foreign = (block: BlockShape) => new BoardError(`the Idea summary range holds a block the groomer did not write: ${block.id} (${block.type})`)
    // The bulleted items from index `from` on, up to the first block that is not one.
    const items = (from: number): BlockShape[] => {
      const stop = range.findIndex((block, i) => i >= from && block.type !== 'bulleted_list_item')
      return range.slice(from, stop === -1 ? range.length : stop)
    }
    const summary = [...range.slice(start, start + 2), ...items(start + 2)]
    const terms = range[start + summary.length]
    if (terms !== undefined) {
      if (!isHeading3(terms, 'Terms')) throw foreign(terms)
      const after = start + summary.length + 1
      const none = range[after]
      summary.push(terms, ...(none !== undefined && none.type === 'paragraph' && blockText(none).trim() === 'None introduced.' ? [none] : items(after)))
    }
    // A note a person nested under a groomer block would be archived with it.
    const nested = summary.find((block) => block.has_children === true)
    if (nested !== undefined) throw foreign(nested)
    return summary
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
      const existing = childPages(await children(pageId)).pages[title]
      let pushed: { id: string; url: string; created: boolean }
      if (existing !== undefined) {
        for (const block of await children(existing.id)) if (block.id !== undefined) await call(`/blocks/${block.id}`, 'DELETE')
        await append(existing.id, blocks)
        pushed = { id: existing.id, url: existing.url, created: false }
      } else pushed = { ...(await create(pageId, title, blocks)), created: true }
      // The page's own last-edited time after the write, for ticket.md's Pages table (the next pull compares against it).
      const object = await parsed(PageShape, `/pages/${pushed.id}`)
      return { ...pushed, url: object.url, lastEditedAt: object.last_edited_time }
    },

    async pullPage(page, title) {
      const found = childPages(await children(pageIdOf(page))).pages[title]
      if (found === undefined) return undefined
      const result = await call<{ markdown?: string; truncated?: boolean }>(`/pages/${found.id}/markdown`)
      if (result.truncated) throw new BoardError(`Notion truncated the page "${title}" (${found.url}); not returning a partial copy`)
      return { ...found, markdown: notionToMarkdown(result.markdown ?? '') }
    },

    async pageMarkdown(pageId) {
      const result = await call<{ markdown?: string; truncated?: boolean }>(`/pages/${pageId}/markdown`)
      return { markdown: result.markdown ?? '', truncated: result.truncated === true }
    },

    async createPage(page, title, markdown) {
      return create(pageIdOf(page), title, markdownToBlocks(markdown))
    },

    async appendParagraph(pageId, text) {
      const [id] = await appendReturning(pageId, [{ object: 'block', type: 'paragraph', paragraph: { rich_text: chunkText(text) } }])
      if (id === undefined) throw new BoardError(`Notion created no block under ${pageId}`)
      return { id }
    },

    async deleteBlock(id) {
      await call(`/blocks/${id}`, 'DELETE')
    },

    async replacePage(page, title, markdown) {
      const ticketPageId = pageIdOf(page)
      const found = childPages(await children(ticketPageId)).pages[title]
      if (found === undefined) throw new BoardError(`${await ticketIdOf(page)} has no child page titled "${title}"`, 404, 'object_not_found')
      const previous = await blocksOf(found.id)
      await append(found.id, markdownToBlocks(markdown))
      for (const block of previous) if (!KEPT_TYPES.has(block.type)) await call(`/blocks/${block.id}`, 'DELETE')
      const object = await parsed(PageShape, `/pages/${found.id}`)
      return { id: found.id, url: object.url, lastEditedAt: object.last_edited_time }
    },

    async writeIdeaSummary(page, markdown) {
      const pageId = pageIdOf(page)
      const body = await blocksOf(pageId)
      const summary = markdownToBlocks(markdown)
      const at = body.findIndex((block) => headingLevel(block) !== undefined && blockText(block).trim().toLowerCase() === 'idea')
      const heading = body[at]
      if (heading === undefined) {
        // No Idea heading: add `## Idea` after the last block that is not a child page, child database or synced block, or at the end.
        const blocks = [...markdownToBlocks('## Idea'), ...summary]
        const last = body.findLast((block) => !KEPT_TYPES.has(block.type))
        return { ids: last === undefined ? await appendReturning(pageId, blocks) : await insertAfter(pageId, last.id, blocks), deleted: [] }
      }
      const level = headingLevel(heading) ?? 0
      if (level === 3) throw new BoardError(`${await ticketIdOf(page)}'s Idea heading is level 3; change it to ## Idea by hand, then rerun`)
      const end = body.findIndex((block, i) => i > at && (headingLevel(block) ?? Number.POSITIVE_INFINITY) <= level)
      const range = body.slice(at + 1, end === -1 ? body.length : end)
      const previous = previousSummary(range)
      if (previous !== undefined) {
        const before = body[body.indexOf(previous[0] ?? heading) - 1] ?? heading
        const ids = await insertAfter(pageId, before.id, summary)
        for (const block of previous) await call(`/blocks/${block.id}`, 'DELETE')
        return { ids, deleted: previous.map((block) => block.id) }
      }
      // After the last block of the Idea range that is content; a toggle or column block counts as one opaque block.
      const skipped = (block: BlockShape) => KEPT_TYPES.has(block.type) || block.type === 'divider' || (block.type === 'paragraph' && blockText(block).trim() === '' && block.has_children !== true)
      const last = range.findLast((block) => !skipped(block)) ?? heading
      return { ids: await insertAfter(pageId, last.id, summary), deleted: [] }
    },

    async listToDos(pageId) {
      const out: ToDo[] = []
      for (const block of await blocksOf(pageId)) {
        if (block.type !== 'to_do') continue
        const toDo = ToDoBody.safeParse(block.to_do)
        const editor = LastEditedBy.safeParse(block)
        if (!toDo.success || !editor.success) throw new BoardError(`Notion answered the to-do ${block.id} with an unexpected shape`)
        out.push({ id: block.id, checked: toDo.data.checked, text: plainOf(toDo.data.rich_text), lastEditedBy: editor.data.last_edited_by === undefined ? undefined : { id: editor.data.last_edited_by.id } })
      }
      return out
    },

    async me() {
      const user = await parsed(UserShape, '/users/me')
      return { id: user.id }
    },

    async uploadFile(name, content) {
      const created = await parsed(UploadShape, '/file_uploads', 'POST', { filename: name, content_type: 'application/json' })
      const form = new FormData()
      form.append('file', new Blob([content], { type: 'application/json' }), name)
      const sent = await parsed(UploadShape, `/file_uploads/${created.id}/send`, 'POST', form)
      return { id: sent.id, status: sent.status }
    },

    async appendFileBlock(pageId, uploadId) {
      const created = await parsed(Created, `/blocks/${pageId}/children`, 'PATCH', { children: [{ type: 'file', file: { type: 'file_upload', file_upload: { id: uploadId } } }] })
      const id = created.results[0]?.id
      if (id === undefined) throw new BoardError(`Notion created no file block under ${pageId}`)
      return { id }
    },

    async fileBlockNames(pageId) {
      const names: string[] = []
      for (const block of await blocksOf(pageId)) {
        if (block.type !== 'file') continue
        const file = FileBody.safeParse(block.file)
        if (!file.success) throw new BoardError(`Notion answered the file block ${block.id} with an unexpected shape: ${file.error.message}`)
        names.push(file.data.name)
      }
      return names
    },

    async rulesPage() {
      // The knowledge walk: breadth first from KNOWLEDGE_PAGE, MAX_DEPTH levels and MAX_PAGES pages at most.
      const root = pageIdFrom(process.env[KNOWLEDGE_ENV.page] ?? '')
      if (root === undefined) return null
      try {
        const seen = new Set<string>([root])
        let level = [root]
        for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && seen.size <= MAX_PAGES; depth += 1) {
          const next: string[] = []
          for (const id of level) {
            // A page the walk cannot read is skipped, as the knowledge walk skips it; only the rules page itself must read.
            const page = await parsed(MarkdownShape, `/pages/${id}/markdown`).catch(() => undefined)
            if (page === undefined) continue
            for (const child of childPagesOf(page.markdown)) {
              if (child.title.trim().toLowerCase() === RULES_TITLE) {
                const rules = await parsed(MarkdownShape, `/pages/${child.id}/markdown`)
                return rules.truncated === true ? null : notionToMarkdown(rules.markdown)
              }
              if (seen.has(child.id) || seen.size >= MAX_PAGES) continue
              seen.add(child.id)
              next.push(child.id)
            }
          }
          level = next
        }
        return null
      } catch {
        // Unreadable rules attach nothing; the caller reports it (OBS-002).
        return null
      }
    },
  }
}
