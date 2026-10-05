// --local knowledge: which Notion pages the implementor's own knowledge configuration loads, and
// whether a session-fetched folder holds them. The configuration is load-knowledge's: the index
// page in KNOWLEDGE_PAGE and the required pages in KNOWLEDGE_REQUIRED (load-knowledge's default
// when unset), read from the same env the agent runs with. The topic pages are the ones the
// required pages route to in their tables, as the procedure tells the agent to follow them.

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  KNOWLEDGE_ENV,
  REQUIRED_ENV,
  childPagesOf,
  fileFor,
  pageIdFrom,
  parseRequired,
  renderRequired,
  resolveRequired,
  type LoadedPage,
} from '@aspiralabs/agent-common/lib/knowledge'

/** The pages the agent's configuration names: the index page (or null when unset) and the required entries. */
export type KnowledgeConfig = { indexPage: string | null; required: string[]; from: string[] }

/** One page the session must fetch into the knowledge folder, and whether it is there. */
export type KnowledgePage = {
  role: 'index' | 'required' | 'topic'
  /** Null for a routed page: Notion mentions carry no title. */
  title: string | null
  /** Null for a required page configured by title only: find it by title. */
  url: string | null
  /** The file to write it to; null means any `<title slug>.md`. */
  file: string | null
  present: boolean
}

/** A knowledge page as recorded in the export. */
export type RecordedPage = { role: KnowledgePage['role'] | 'snapshot'; title: string; url: string | null; file: string; sha256: string }

/** The knowledge folder against the configuration. */
export type KnowledgeState = { complete: boolean; pages: KnowledgePage[]; required: LoadedPage[]; recorded: RecordedPage[] }

/** The provenance line every page file starts with: load-knowledge's renderPage header. */
export const PAGE_HEADER = '<!-- <title> · <url> · fetched <ISO time> -->'
const HEADER = /^<!-- (.+?) · (\S+) · fetched (\S+?)(?: · [^>]*)? -->\s*\n?/

/** The required-reading file, named as load-knowledge names it. */
export const REQUIRED_NAME = 'REQUIRED.md'
/** The index page's file, named as load-knowledge names it. */
export const INDEX_NAME = 'INDEX.md'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** KEY=VALUE lines of a dotenv file; quotes stripped, comments and blanks skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match?.[1] === undefined) continue
    out[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/**
 * The env the agent runs with, as far as knowledge goes: eve loads the package's
 * `.env.development.local` over its `.env.local` (a symlink to the shared `../.env.local`), and
 * the shell wins over both. Where the package has no `.env.local` (a fresh worktree), the shared
 * file it would link to is read instead.
 */
export async function agentEnv(packageDir: string, shell: Record<string, string | undefined> = process.env): Promise<{ env: Record<string, string | undefined>; from: string[] }> {
  const files = [join(packageDir, '..', '.env.local'), join(packageDir, '.env.local'), join(packageDir, '.env.development.local')]
  const env: Record<string, string | undefined> = {}
  const from: string[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    Object.assign(env, parseEnvFile(text))
    from.push(file)
  }
  for (const key of [KNOWLEDGE_ENV.page, REQUIRED_ENV]) {
    if (shell[key] !== undefined) {
      env[key] = shell[key]
      from.push(`shell ${key}`)
    }
  }
  return { env, from }
}

/** load-knowledge's choice of pages, from an env. */
export function knowledgeConfig(env: Record<string, string | undefined>, from: string[] = []): KnowledgeConfig {
  const page = env[KNOWLEDGE_ENV.page]?.trim()
  return { indexPage: page === undefined || page === '' ? null : page, required: parseRequired(env[REQUIRED_ENV]), from }
}

type PageFile = { name: string; text: string; page: LoadedPage }

async function pageFiles(dir: string): Promise<{ pages: PageFile[]; texts: Map<string, string> }> {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.md')).sort()
  const pages: PageFile[] = []
  const texts = new Map<string, string>()
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8')
    texts.set(name, text)
    if (name === REQUIRED_NAME) continue
    const match = text.match(HEADER)
    const id = match?.[2] === undefined ? undefined : pageIdFrom(match[2])
    if (match?.[1] === undefined || match[2] === undefined || id === undefined) continue
    pages.push({ name, text, page: { id, title: match[1].trim(), url: match[2], markdown: text.slice(match[0].length) } })
  }
  return { pages, texts }
}

/** The pages a required page routes to: every page linked inside its tables. */
export function routedPages(markdown: string): { id: string; url: string }[] {
  const tables = markdown.match(/<table[\s\S]*?<\/table>/g) ?? []
  return tables.flatMap((table) => childPagesOf(table).map(({ id, url }) => ({ id, url })))
}

/** What the folder holds against the configuration. Complete means every listed page is present. */
export async function inspectKnowledge(dir: string, config: KnowledgeConfig): Promise<KnowledgeState> {
  const { pages: files } = await pageFiles(dir)
  const listed: KnowledgePage[] = []
  const byId = new Map(files.map((file) => [file.page.id, file]))
  const recorded: RecordedPage[] = []
  const record = (role: RecordedPage['role'], file: PageFile) => recorded.push({ role, title: file.page.title, url: file.page.url, file: file.name, sha256: sha256(file.text) })

  if (config.indexPage !== null) {
    const id = pageIdFrom(config.indexPage)
    const file = files.find((f) => f.name === INDEX_NAME && f.page.id === id)
    listed.push({ role: 'index', title: file?.page.title ?? null, url: config.indexPage, file: INDEX_NAME, present: file !== undefined })
    if (file !== undefined) record('index', file)
  }

  const candidates = files.filter((f) => f.name !== INDEX_NAME)
  const resolved = resolveRequired(config.required, candidates.map((f) => f.page))
  const used = new Set<string>([INDEX_NAME, REQUIRED_NAME])
  for (const entry of config.required) {
    const asUrl = pageIdFrom(entry) === undefined ? null : entry
    const found = resolveRequired([entry], resolved.found).found[0]
    const file = found === undefined ? undefined : byId.get(found.id)
    listed.push({ role: 'required', title: asUrl === null ? entry : (found?.title ?? null), url: asUrl ?? found?.url ?? null, file: file?.name ?? basename(fileFor(asUrl === null ? entry : 'page', used)), present: file !== undefined })
    if (file !== undefined) record('required', file)
  }

  if (resolved.missing.length === 0) {
    const known = new Set([...resolved.found.map((p) => p.id), ...(config.indexPage === null ? [] : [pageIdFrom(config.indexPage)])])
    for (const routed of resolved.found.flatMap((p) => routedPages(p.markdown))) {
      if (known.has(routed.id)) continue
      known.add(routed.id)
      const file = byId.get(routed.id)
      listed.push({ role: 'topic', title: file?.page.title ?? null, url: routed.url, file: file?.name ?? null, present: file !== undefined })
      if (file !== undefined) record('topic', file)
    }
  }
  return { complete: listed.every((p) => p.present), pages: listed, required: resolved.found, recorded }
}

/** Writes REQUIRED.md from the required pages, exactly as load-knowledge renders it. */
export async function writeRequired(dir: string, required: LoadedPage[], fetchedAt: string): Promise<string> {
  const path = join(dir, REQUIRED_NAME)
  await writeFile(path, renderRequired(required, fetchedAt))
  return path
}

/** A digest of every file in the folder, so a mid-run change is caught. */
export async function knowledgeFingerprint(dir: string): Promise<string> {
  const { texts } = await pageFiles(dir)
  return sha256(JSON.stringify([...texts.entries()]))
}

/** The page files in the folder with their titles, for prompts. REQUIRED.md first, then INDEX.md, then the rest. */
export async function knowledgeFiles(dir: string): Promise<{ path: string; title: string }[]> {
  const { pages, texts } = await pageFiles(dir)
  const out: { path: string; title: string }[] = []
  if (texts.has(REQUIRED_NAME)) out.push({ path: join(dir, REQUIRED_NAME), title: 'Required reading (read in full)' })
  const index = pages.find((p) => p.name === INDEX_NAME)
  if (index !== undefined) out.push({ path: join(dir, INDEX_NAME), title: `${index.page.title} (index)` })
  for (const page of pages) if (page.name !== INDEX_NAME) out.push({ path: join(dir, page.name), title: page.page.title })
  return out
}

/** The earliest fetch time in the required pages' headers, for REQUIRED.md's provenance line. */
export async function requiredFetchedAt(dir: string, required: LoadedPage[], fallback: string): Promise<string> {
  const { pages } = await pageFiles(dir)
  const ids = new Set(required.map((p) => p.id))
  const times = pages
    .filter((p) => ids.has(p.page.id))
    .map((p) => p.text.match(HEADER)?.[3])
    .filter((t): t is string => t !== undefined)
    .sort()
  return times[0] ?? fallback
}
