// The one breadth-first walk of the engineering guidelines tree in Notion, shared by the
// load-knowledge command (scripts/load-knowledge.ts), the eve load-knowledge tool
// (tools/load-knowledge.ts), probe-knowledge.ts's preview and code-analyzer's host copy
// (packages/ai/code-analyzer/agent/lib/knowledge.ts). Depth and page caps, link rewriting and
// required-page resolution come from ./knowledge; this module adds the walk's error semantics
// (a failed or truncated page fails the whole walk, naming it), the provenance-carrying write to a
// destination folder, and the safety checks that write goes through before it ever deletes
// anything.

import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import {
  MAX_DEPTH,
  MAX_PAGES,
  NOTION_API,
  NOTION_VERSION,
  childPagesOf,
  fileFor,
  pageIdFrom,
  renderPage,
  renderRequired,
  resolveRequired,
  rewriteLinks,
  type LoadedPage,
} from './knowledge.ts'
import { parseProvenance, renderProvenance, type ProvenancePage } from './knowledge-snapshot.ts'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** One page the walk fetched: `file` is the basename it would be written under (INDEX.md for the root). `markdown` has local (basename) links rewritten; `notionMarkdown` keeps the raw Notion markdown, for hashing. */
export type WalkPage = { id: string; title: string; url: string; file: string; markdown: string; notionMarkdown: string; truncated: boolean }

export type WalkResult = {
  rootId: string
  rootUrl: string
  fetchedAt: string
  /** Every page fetched, in visit order (the root/index page first). */
  pages: WalkPage[]
  /** The resolved required pages, in requested order, deduplicated. */
  required: WalkPage[]
  /** Pages the walk knows about (named from a parent's markdown) but did not reach: the page cap was hit before they were dequeued. */
  notLoaded: { title: string; url: string }[]
  /** Links the tree makes to Notion databases (Approved Technologies, ADRs, …): not pages, so not fetched and not written, as the walk before this one did. */
  skippedDatabases?: { title: string; url: string }[]
}

/** Notion's 400 for /pages/<id> when the id is a database: the one link the walk skips instead of failing on. */
class NotionDatabaseError extends Error {}
const DATABASE_NOT_PAGE = /is a database, not a page/i

export type WalkArgs = {
  token: string
  /** The index page to start from: a Notion URL or id. */
  page: string
  /** Titles (or URLs/ids) every agent must ingest in full. Missing or unreached (within the caps) fails the walk. */
  required?: string[]
  fetch?: Fetch
  /** Notion's API base. Defaults to NOTION_API; tests point it at a mock server. */
  api?: string
}

/**
 * The one breadth-first walk: depth MAX_DEPTH, MAX_PAGES pages. A fetch error, a 404/403, or a
 * truncated page makes the whole walk throw, naming the page. A link to a database (Notion's 400
 * "is a database, not a page") is skipped and listed in `skippedDatabases`. A required page that is never
 * reached (the cap or otherwise) makes it throw too, naming the page.
 */
export async function walkKnowledge(args: WalkArgs): Promise<WalkResult> {
  const api = args.api ?? NOTION_API
  const request = args.fetch ?? fetch
  const headers = { Authorization: `Bearer ${args.token}`, 'Notion-Version': NOTION_VERSION }

  async function get<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await request(`${api}${path}`, { headers })
    } catch (error) {
      throw new Error(`Could not reach Notion at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (res.status === 429) {
      await new Promise((done) => setTimeout(done, Math.min(Number(res.headers.get('retry-after') ?? '1') * 1000, 10_000)))
      return get<T>(path)
    }
    if (!res.ok) {
      const text = await res.text()
      const detail = text.slice(0, 300)
      if (res.status === 400 && DATABASE_NOT_PAGE.test(text)) throw new NotionDatabaseError(`Notion ${res.status} on ${path}: ${detail}`)
      const hint = res.status === 404 || res.status === 403 ? ' (is the page shared with the integration?)' : ''
      throw new Error(`Notion ${res.status} on ${path}${hint}: ${detail}`)
    }
    return (await res.json()) as T
  }
  const markdownOf = async (id: string): Promise<{ markdown: string; truncated: boolean }> => {
    const body = await get<{ markdown?: string; truncated?: boolean }>(`/pages/${id}/markdown`)
    return { markdown: body.markdown ?? '', truncated: body.truncated === true }
  }
  const titleOf = async (id: string): Promise<string> => {
    const body = await get<{ properties?: Record<string, { type?: string; title?: { plain_text?: string }[] }> }>(`/pages/${id}`)
    const prop = Object.values(body.properties ?? {}).find((p) => p.type === 'title')
    const text = (prop?.title ?? []).map((t) => t.plain_text ?? '').join('').trim()
    return text || 'Engineering'
  }

  const start = args.page.trim()
  const rootId = pageIdFrom(start)
  if (rootId === undefined) throw new Error(`Not a Notion page URL or id: ${start}`)

  const fetchedAt = new Date().toISOString()
  let rootTitle: string
  try {
    rootTitle = await titleOf(rootId)
  } catch (error) {
    throw new Error(`Failed to load the index page (${start}): ${error instanceof Error ? error.message : String(error)}`)
  }

  const queue: { id: string; title: string; url: string; depth: number }[] = [{ id: rootId, title: rootTitle, url: start, depth: 0 }]
  const seen = new Set<string>([rootId])
  const usedFullPaths = new Set<string>(['/workspace/knowledge/INDEX.md'])
  const files = new Map<string, string>([[rootId, 'INDEX.md']])
  const titles = new Map<string, string>([[rootId, rootTitle]])
  const pages: WalkPage[] = []
  const skippedDatabases: { title: string; url: string }[] = []

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const next = queue.shift()
    if (next === undefined) break
    let body: { markdown: string; truncated: boolean }
    try {
      body = await markdownOf(next.id)
    } catch (error) {
      if (error instanceof NotionDatabaseError) {
        // A titled link to a database: drop the file name reserved for it, so links to it stay Notion URLs.
        files.delete(next.id)
        titles.delete(next.id)
        skippedDatabases.push({ title: next.title, url: next.url })
        continue
      }
      throw new Error(`Failed to load "${next.title}" (${next.url}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (body.truncated) throw new Error(`"${next.title}" (${next.url}) was truncated by the Notion API; the knowledge walk cannot proceed with a partial page.`)

    const file = files.get(next.id) ?? next.title
    pages.push({ id: next.id, title: next.title, url: next.url, file, markdown: body.markdown, notionMarkdown: body.markdown, truncated: false })

    if (next.depth >= MAX_DEPTH) continue
    for (const child of childPagesOf(body.markdown)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      let title = child.title
      if (title === '') {
        try {
          title = await titleOf(child.id)
        } catch (error) {
          if (error instanceof NotionDatabaseError) {
            skippedDatabases.push({ title: '', url: child.url })
            continue
          }
          throw new Error(`Failed to load "${child.url}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const childFile = basenameOf(fileFor(title, usedFullPaths))
      files.set(child.id, childFile)
      titles.set(child.id, title)
      queue.push({ ...child, title, depth: next.depth + 1 })
    }
  }

  // Links are rewritten to basenames now that every file name is known, regardless of fetch order.
  for (const page of pages) page.markdown = rewriteLinks(page.notionMarkdown, files, titles)

  const notLoaded = queue.map(({ title, url }) => ({ title, url }))
  const wanted = args.required ?? []
  const resolved = resolveRequired(wanted, pages)
  if (resolved.missing.length > 0) {
    throw new Error(
      `Required knowledge page${resolved.missing.length === 1 ? '' : 's'} not loaded: ${resolved.missing.join(', ')}. Loaded: ${pages.map((p) => p.title).join(', ')}. Fix the title, or link the page from the index within ${MAX_DEPTH} levels and ${MAX_PAGES} pages.`,
    )
  }

  return { rootId, rootUrl: start, fetchedAt, pages, required: resolved.found as WalkPage[], notLoaded, skippedDatabases }
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** The exact text renderRequired embeds in REQUIRED.md's body for a required page: kept identical here so a verifier can re-derive it from the file alone. */
function sectionTextFor(p: { title: string; url: string; markdown: string }): string {
  return `# ${p.title}\n\n<!-- ${p.url} -->\n\n${p.markdown.trim()}\n`
}

function isAncestorOrSame(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep)
}

export type GuardOpts = { cwd?: string; homedir?: string; ticketFolder?: string }

/**
 * Refuses (throwing, nothing touched) when the resolved `out` is `/`, is `opts.homedir`, is
 * `opts.cwd` or an ancestor of it, is a symlink, or is a non-empty directory with no
 * header-carrying REQUIRED.md — unless `out` is under `opts.ticketFolder`, where that last rule
 * does not apply.
 */
export async function guardOut(out: string, opts: GuardOpts = {}): Promise<void> {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const home = resolve(opts.homedir ?? osHomedir())
  const resolvedOut = resolve(out)
  const ticketFolder = opts.ticketFolder !== undefined ? resolve(opts.ticketFolder) : undefined

  if (resolvedOut === resolve(sep)) throw new Error(`Refusing to write knowledge to the filesystem root (${resolvedOut}).`)
  if (resolvedOut === home) throw new Error(`Refusing to write knowledge to the home directory (${resolvedOut}).`)
  if (isAncestorOrSame(resolvedOut, cwd)) throw new Error(`Refusing to write knowledge to the repository root or an ancestor of it (${resolvedOut}).`)

  const info = await lstat(resolvedOut).catch(() => null)
  if (info === null) return
  if (info.isSymbolicLink()) throw new Error(`Refusing to write knowledge to a symlink (${resolvedOut}).`)

  const underTicket = ticketFolder !== undefined && isAncestorOrSame(ticketFolder, resolvedOut)
  if (underTicket) return

  const entries = info.isDirectory() ? await readdir(resolvedOut) : ['(not a directory)']
  if (entries.length === 0) return

  const requiredText = await readFile(join(resolvedOut, 'REQUIRED.md'), 'utf8').catch(() => null)
  const hasHeader = requiredText !== null && parseProvenance(requiredText) !== null
  if (!hasHeader) throw new Error(`Refusing to write knowledge to the non-empty directory ${resolvedOut}: it carries no REQUIRED.md with a load-knowledge provenance header.`)
}

export type WriteOpts = GuardOpts

/**
 * Writes `pages` (one file each) and, when `required` is non-empty, REQUIRED.md with the
 * provenance header, into `out`: through a temporary sibling directory renamed into place, so a
 * reader never sees a half-written folder. Calls guardOut(out, opts) first.
 */
export async function writeKnowledgeFolder(out: string, walk: WalkResult, opts: WriteOpts = {}): Promise<void> {
  await guardOut(out, opts)
  const resolvedOut = resolve(out)

  await mkdir(dirname(resolvedOut), { recursive: true })
  const tmp = await mkdtemp(`${resolvedOut}.tmp-`)
  try {
    for (const page of walk.pages) {
      const content = renderPage({ title: page.title, url: page.url, fetchedAt: walk.fetchedAt, truncated: false }, page.markdown) + (page.file === 'INDEX.md' ? notLoadedSection(walk.notLoaded) + databasesSection(walk.skippedDatabases ?? []) : '')
      await writeFile(join(tmp, page.file), content)
    }

    if (walk.required.length > 0) {
      const provenancePages: ProvenancePage[] = walk.pages.map((p) => ({ id: p.id, url: p.url, title: p.title, file: p.file, rawMarkdown: p.notionMarkdown, section: sectionTextFor(p) }))
      const header = renderProvenance({ fetchedAt: walk.fetchedAt, rootUrl: walk.rootUrl, rootId: walk.rootId, path: join(resolvedOut, 'REQUIRED.md'), pages: provenancePages })
      const requiredAsLoaded: LoadedPage[] = walk.required.map((p) => ({ id: p.id, title: p.title, url: p.url, markdown: p.markdown }))
      await writeFile(join(tmp, 'REQUIRED.md'), renderRequired(requiredAsLoaded, walk.fetchedAt, header))
    }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true })
    throw error
  }

  if (existsSync(resolvedOut)) await rm(resolvedOut, { recursive: true, force: true })
  await rename(tmp, resolvedOut)
}

/** INDEX.md's list of the databases the tree links (KIT-54): the walk fetches pages, not rows, so the agent is told which databases exist and how to read them when a rule points at one. */
export function databasesSection(databases: { title: string; url: string }[]): string {
  if (databases.length === 0) return ''
  const n = databases.length
  return `\n## Databases\n\n${n} database${n === 1 ? '' : 's'} linked from these pages (Approved Technologies, ADRs, …). This folder holds pages, not rows: read a database's rows when a rule or a decision depends on them, with notion_read (a cloud agent) or notion-fetch / notion-query-data-sources (a Claude Code session), before reporting it as unknown:\n\n${databases.map((d) => `- ${d.title || 'Database'} (${d.url})`).join('\n')}\n`
}

function notLoadedSection(notLoaded: { title: string; url: string }[]): string {
  if (notLoaded.length === 0) return ''
  const n = notLoaded.length
  return `\n## Not loaded\n\n${n} page${n === 1 ? '' : 's'} were not loaded (the depth or page cap was reached):\n\n${notLoaded.map((p) => `- ${p.title} (${p.url})`).join('\n')}\n`
}

export type CommandDeps = {
  token?: string
  api?: string
  page?: string
  required?: string[]
  fetch?: Fetch
  cwd?: string
  homedir?: string
  ticketFolder?: string
}

export type CommandResult = { code: number; message: string }

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

/**
 * The load-knowledge CLI's testable core: parses `--out DIR` (required), `--page URL` and
 * `--required a,b` from argv (falling back to deps.page/deps.required when the flags are absent),
 * runs walkKnowledge then writeKnowledgeFolder, and never throws.
 */
export async function loadKnowledgeCommand(argv: string[], deps: CommandDeps = {}): Promise<CommandResult> {
  const out = argValue(argv, '--out')
  if (out === undefined) return { code: 1, message: '--out DIR is required.' }

  const page = argValue(argv, '--page') ?? deps.page
  if (page === undefined || page === '') return { code: 1, message: '--page URL is required (or pass deps.page).' }

  const token = deps.token
  if (token === undefined || token === '') return { code: 1, message: 'A Notion token is required (deps.token).' }

  const requiredFlag = argValue(argv, '--required')
  const required = requiredFlag !== undefined ? requiredFlag.split(',').map((s) => s.trim()).filter((s) => s !== '') : (deps.required ?? [])

  let walk: WalkResult
  try {
    walk = await walkKnowledge({ token, page, required, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.api ? { api: deps.api } : {}) })
  } catch (error) {
    return { code: 1, message: error instanceof Error ? error.message : String(error) }
  }

  try {
    await writeKnowledgeFolder(out, walk, { cwd: deps.cwd, homedir: deps.homedir, ticketFolder: deps.ticketFolder })
  } catch (error) {
    return { code: 1, message: error instanceof Error ? error.message : String(error) }
  }

  const notLoadedNote = walk.notLoaded.length > 0 ? `; ${walk.notLoaded.length} not loaded` : ''
  const databases = walk.skippedDatabases ?? []
  const databaseNote = databases.length > 0 ? `; ${databases.length} database link(s) skipped` : ''
  return { code: 0, message: `${walk.pages.length} file(s) written to ${resolve(out)}${notLoadedNote}${databaseNote}` }
}
