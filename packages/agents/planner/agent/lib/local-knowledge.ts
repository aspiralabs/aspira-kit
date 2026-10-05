// The knowledge stage of --local. The pages come from the configuration the agent's own
// load-knowledge tool reads (KNOWLEDGE_PAGE, KNOWLEDGE_REQUIRED and the walk limits in
// agent-common), never from the skill. The session fetches them with the Notion MCP into
// <work>/knowledge/ in load-knowledge's layout; this module says which pages are still missing
// and fingerprints the folder so a mid-run change is refused.

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  KNOWLEDGE_ENV,
  MAX_DEPTH,
  MAX_PAGES,
  REQUIRED_ENV,
  childPagesOf,
  fileFor,
  pageIdFrom,
  parseRequired,
  renderPage,
  renderRequired,
  resolveRequired,
  type LoadedPage,
} from '@aspiralabs/agent-common/lib/knowledge'

/** load-knowledge's file names, without its sandbox prefix. */
export const INDEX_NAME = 'INDEX.md'
/** The required-reading file the planner receives as its guidelines. */
export const REQUIRED_NAME = 'REQUIRED.md'

/** What load-knowledge would load: the index page, the required pages, and its walk limits. */
export type KnowledgeConfig = { page: string | null; required: string[]; maxDepth: number; maxPages: number }

/** One page the session fetches, or has fetched, into the knowledge folder. */
export type KnowledgePage = { role: 'index' | 'required' | 'topic'; title: string; url: string | null; id: string | null; file: string; present: boolean }

/** The knowledge folder against the configuration: ready, or the pages still to fetch. */
export type KnowledgeState = { ready: boolean; pages: KnowledgePage[]; problems: string[] }

/** One file of the knowledge used by a run, for the export. */
export type KnowledgeFile = { name: string; sha256: string; title: string | null; url: string | null }

const TRUNCATED = /TRUNCATED by the Notion API/i
const NOTION_URL = /https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>")\]]+/g

/** The agent's knowledge configuration, read from its environment as load-knowledge reads it. */
export function knowledgeConfig(env: Record<string, string | undefined>): KnowledgeConfig {
  const page = env[KNOWLEDGE_ENV.page]?.trim()
  return { page: page ? page : null, required: parseRequired(env[REQUIRED_ENV]), maxDepth: MAX_DEPTH, maxPages: MAX_PAGES }
}

/** The provenance line renderPage writes at the top of a page file, parsed back. */
export function pageHeader(text: string): { title: string; url: string; id: string } | null {
  const match = text.match(/^<!-- (.+?) · (\S+) · fetched [^\n]*?-->/)
  const id = match?.[2] === undefined ? undefined : pageIdFrom(match[2])
  return match?.[1] === undefined || match[2] === undefined || id === undefined ? null : { title: match[1], url: match[2], id }
}

/** REQUIRED.md's sections as renderRequired writes them: `# Title`, then `<!-- url -->`. */
export function requiredSections(text: string): LoadedPage[] {
  const pages: LoadedPage[] = []
  for (const match of text.matchAll(/^# (.+)\n+<!-- (\S+) -->\n([\s\S]*?)(?=^---\s*$|(?![\s\S]))/gm)) {
    const id = pageIdFrom(match[2]!)
    if (id !== undefined) pages.push({ id, title: match[1]!.trim(), url: match[2]!, markdown: match[3]!.trim() })
  }
  return pages
}

/** The topic pages the required pages route to: every Notion page they link, other than themselves and the index. */
export function routedPages(required: string, exclude: Set<string>): { id: string; title: string; url: string }[] {
  const out = new Map<string, { id: string; title: string; url: string }>()
  for (const child of childPagesOf(required)) if (!exclude.has(child.id)) out.set(child.id, child)
  for (const match of required.matchAll(NOTION_URL)) {
    const id = pageIdFrom(match[0])
    if (id !== undefined && !exclude.has(id) && !out.has(id)) out.set(id, { id, title: '', url: match[0] })
  }
  return [...out.values()]
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

/** Check the knowledge folder against the configuration. Topic pages are known only once REQUIRED.md is there. */
export async function inspectKnowledge(dir: string, config: KnowledgeConfig): Promise<KnowledgeState> {
  if (config.page === null) throw new Error(`${KNOWLEDGE_ENV.page} is not set in the planner's environment, so the engineering rules cannot be loaded. Set it (as load-knowledge needs) or pass --guidelines with a complete REQUIRED.md snapshot.`)
  const rootId = pageIdFrom(config.page)
  if (rootId === undefined) throw new Error(`${KNOWLEDGE_ENV.page} is not a Notion page URL or id: ${config.page}`)
  const problems: string[] = []
  const pages: KnowledgePage[] = []

  const index = await readOptional(join(dir, INDEX_NAME))
  const indexHeader = index === null ? null : pageHeader(index)
  if (index !== null && indexHeader?.id !== rootId) problems.push(`${INDEX_NAME} must start with the provenance line of ${config.page}`)
  if (index !== null && TRUNCATED.test(index)) problems.push(`${INDEX_NAME} is truncated; fetch the full page`)
  pages.push({ role: 'index', title: 'Engineering index (KNOWLEDGE_PAGE)', url: config.page, id: rootId, file: join(dir, INDEX_NAME), present: index !== null && indexHeader?.id === rootId })

  const required = await readOptional(join(dir, REQUIRED_NAME))
  const sections = required === null ? [] : requiredSections(required)
  const resolved = resolveRequired(config.required, sections)
  for (const entry of config.required) {
    const id = pageIdFrom(entry)
    const found = resolved.found.find((page) => (id !== undefined && page.id === id) || page.title.trim().toLowerCase() === entry.trim().toLowerCase())
    pages.push({ role: 'required', title: found?.title ?? entry, url: found?.url ?? (id === undefined ? null : entry), id: found?.id ?? id ?? null, file: join(dir, REQUIRED_NAME), present: found !== undefined })
  }
  if (required !== null && resolved.missing.length > 0) problems.push(`${REQUIRED_NAME} lacks required page${resolved.missing.length === 1 ? '' : 's'}: ${resolved.missing.join(', ')}`)
  if (required !== null && TRUNCATED.test(required)) problems.push(`${REQUIRED_NAME} is truncated; fetch the full pages`)

  if (required !== null && resolved.missing.length === 0) {
    const present = new Map<string, string>()
    for (const name of (await readdir(dir)).filter((file) => file.endsWith('.md') && file !== INDEX_NAME && file !== REQUIRED_NAME).sort()) {
      const text = await readFile(join(dir, name), 'utf8')
      const head = pageHeader(text)
      if (head === null) problems.push(`${name} has no provenance line; start it as renderPage does`)
      else if (TRUNCATED.test(text)) problems.push(`${name} is truncated; fetch the full page`)
      else present.set(head.id, join(dir, name))
    }
    const own = new Set([rootId, ...resolved.found.map((page) => page.id)])
    for (const topic of routedPages(required, own)) {
      const file = present.get(topic.id)
      pages.push({ role: 'topic', title: topic.title, url: topic.url, id: topic.id, file: file ?? join(dir, topic.title ? basename(fileFor(topic.title)) : `${topic.id}.md`), present: file !== undefined })
    }
  }
  return { ready: problems.length === 0 && pages.every((page) => page.present), pages, problems }
}

/** The file formats the session writes, rendered by agent-common's own renderers. */
export function knowledgeFormats(): Record<string, string> {
  const fetchedAt = '<ISO time>'
  return {
    [INDEX_NAME]: renderPage({ title: '<page title>', url: '<KNOWLEDGE_PAGE url>', fetchedAt, truncated: false }, '<page markdown>'),
    [REQUIRED_NAME]: renderRequired([{ id: '', title: '<required page title>', url: '<page url>', markdown: '<page markdown>' }], fetchedAt),
    '<topic>.md': renderPage({ title: '<page title>', url: '<page url>', fetchedAt, truncated: false }, '<page markdown>'),
  }
}

/** Every knowledge file with its hash and provenance, and one fingerprint over all of them. */
export async function fingerprintKnowledge(files: string[]): Promise<{ fingerprint: string; files: KnowledgeFile[]; contents: Map<string, string> }> {
  const hash = createHash('sha256')
  const out: KnowledgeFile[] = []
  const contents = new Map<string, string>()
  for (const path of [...files].sort()) {
    const text = await readFile(path, 'utf8')
    const name = basename(path)
    const head = pageHeader(text)
    hash.update(`${name}\0${text}\0`)
    contents.set(name, text)
    out.push({ name, sha256: createHash('sha256').update(text).digest('hex'), title: head?.title ?? null, url: head?.url ?? null })
  }
  return { fingerprint: hash.digest('hex'), files: out, contents }
}

/** The markdown files of a knowledge folder. */
export async function knowledgeFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.md')).map((name) => join(dir, name))
}
