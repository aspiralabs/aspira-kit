// The knowledge of --local. The pages come from the configuration the agent's own load-knowledge
// tool reads (KNOWLEDGE_PAGE, KNOWLEDGE_REQUIRED and the walk limits in agent-common), never from
// the skill. The first call of a run fetches them itself through the one shared walk
// (knowledge-walk.ts) into <work>/knowledge/, with the NOTION_TOKEN the project's env gives it
// (F49, F52); later calls of the same run read that folder. This module checks the folder,
// verifies a --guidelines snapshot (F50) and fingerprints what a run used so a mid-run change is
// refused.

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  KNOWLEDGE_ENV,
  MAX_DEPTH,
  MAX_PAGES,
  REQUIRED_ENV,
  childPagesOf,
  fileFor,
  pageIdFrom,
  parseRequired,
  resolveRequired,
  type LoadedPage,
} from '@aspiralabs/ai/common/lib/knowledge'
import { parseProvenance, verifySnapshot } from '@aspiralabs/ai/common/lib/knowledge-snapshot'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/ai/common/lib/knowledge-walk'
import { readEffectiveAspira } from '@aspiralabs/ai/common/lib/aspira-config'
import { notionToken } from '@aspiralabs/ai/common/lib/notion-token'
import { KnowledgePrerequisiteError } from '@aspiralabs/ai/common/lib/ticket-driver'

/** load-knowledge's file names, without its sandbox prefix. */
export const INDEX_NAME = 'INDEX.md'
/** The required-reading file the planner receives as its guidelines. */
export const REQUIRED_NAME = 'REQUIRED.md'

/** What load-knowledge would load: the index page, the required pages, and its walk limits. */
export type KnowledgeConfig = { page: string | null; required: string[]; maxDepth: number; maxPages: number }

/** One page the session fetches, or has fetched, into the knowledge folder. */
export type KnowledgePage = { role: 'index' | 'required' | 'topic'; title: string; url: string | null; id: string | null; file: string; present: boolean }

/** The knowledge folder against the configuration: ready, or what is missing from it. */
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

const LOAD_KNOWLEDGE = 'load-knowledge --out <dir> (packages/ai/common/scripts/load-knowledge.ts)'

/** No folder yet and nothing to fetch it with (no NOTION_TOKEN, or no KNOWLEDGE_PAGE): the run ends blocked (F52), never a session stage. */
export class KnowledgeBlocked extends KnowledgePrerequisiteError {
  readonly pending = false as const
  readonly status = 'blocked' as const
  readonly stage = 'knowledge' as const
}

/** Where this run's folder is fetched from: the token (never printed) and the files it was looked for in. */
export type KnowledgeSource = { token?: string; tokenFiles: string[]; fetch?: (url: string, init?: RequestInit) => Promise<Response>; api?: string }

/**
 * The NOTION_TOKEN this run fetches with (F52): the process environment, the app's .env.local
 * (aspira.json `app`), then the project root's .env.local. The agent package's own env files are
 * never read for it.
 */
export async function knowledgeSource(repo: string, env: Record<string, string | undefined>): Promise<Omit<KnowledgeSource, 'fetch' | 'api'>> {
  const root = resolve(repo)
  const aspira = (() => {
    try {
      return readEffectiveAspira(root).config as { app?: unknown }
    } catch {
      return null
    }
  })()
  const app = typeof aspira?.app === 'string' && aspira.app !== '.' && aspira.app !== '' ? resolve(root, aspira.app) : undefined
  const found = await notionToken({ env, projectRoot: root, ...(app === undefined ? {} : { appDir: app }) })
  return { ...(found === null ? {} : { token: found.token }), tokenFiles: [...(app === undefined ? [] : [join(app, '.env.local')]), join(root, '.env.local')] }
}

/**
 * The run's own folder: the first call (no REQUIRED.md yet) fetches it through the shared walk;
 * every later call reads what is there with no Notion request. Throws KnowledgeBlocked when there is
 * no folder and no token or KNOWLEDGE_PAGE to fetch with, and a KnowledgePrerequisiteError naming
 * the problems when the folder is incomplete. A topic page the walk did not reach is listed, not
 * required: only the index and the required pages are (F47).
 */
export async function loadKnowledge(dir: string, config: KnowledgeConfig, source: KnowledgeSource = { tokenFiles: [] }): Promise<KnowledgeState> {
  if ((await readOptional(join(dir, REQUIRED_NAME))) === null) {
    if (source.token === undefined || config.page === null) {
      const missing = [source.token === undefined && `${KNOWLEDGE_ENV.token} is not set in the environment${source.tokenFiles.length > 0 ? ` or in ${source.tokenFiles.join(' or ')}` : ''}`, config.page === null && `${KNOWLEDGE_ENV.page} is not set in the planner's environment`].filter(Boolean).join('; ')
      throw new KnowledgeBlocked(`The engineering rules are required and cannot be loaded from Notion: ${missing}. Set it, or run ${LOAD_KNOWLEDGE} and give the run its REQUIRED.md.`)
    }
    const walk = await walkKnowledge({ token: source.token, page: config.page, required: config.required, ...(source.fetch ? { fetch: source.fetch } : {}), ...(source.api ? { api: source.api } : {}) })
    await writeKnowledgeFolder(dir, walk)
  }
  const state = await inspectKnowledge(dir, config)
  const missing = state.pages.filter((page) => !page.present && page.role !== 'topic')
  const problems = [...state.problems, ...missing.map((page) => `${page.title} (${page.role}) is not in ${page.file}`)]
  if (problems.length > 0) throw new KnowledgePrerequisiteError(`The engineering rules in ${dir} are incomplete: ${problems.join('; ')}. Delete ${dir} so the next call loads it again from Notion.`)
  return { ...state, ready: true }
}

/**
 * A --guidelines snapshot: accepted only when it is a REQUIRED.md load-knowledge wrote, still where
 * it was written and unedited, and loaded from KNOWLEDGE_PAGE when one is configured (F50). A copy
 * under a trace/ folder or a file without the header is refused, naming load-knowledge.
 */
export async function verifyGuidelines(file: string, config: Pick<KnowledgeConfig, 'page'>): Promise<void> {
  const path = resolve(file)
  const header = parseProvenance((await readOptional(path)) ?? '')
  const expectedRootId = (config.page === null ? undefined : pageIdFrom(config.page)) ?? header?.rootId ?? ''
  const verified = await verifySnapshot(path, { expectedRootId })
  if (!verified.ok) throw new KnowledgePrerequisiteError(`--guidelines ${path} is refused: ${verified.reason} ${verified.hint}`)
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
