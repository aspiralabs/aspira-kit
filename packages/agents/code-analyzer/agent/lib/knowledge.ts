// The engineering guidelines for every code-analyzer path. The other agents load them with the
// shared load-knowledge tool, which writes into the eve sandbox; code-analyzer's fixer runs on the
// host for local and remote repositories alike, so this walks the same Notion tree with the same
// helpers and limits (packages/agents/common) into a host folder. A run gets them one of three
// ways: from Notion (NOTION_TOKEN + KNOWLEDGE_PAGE), from a --knowledge folder in load-knowledge's
// layout, or from a --guidelines REQUIRED.md snapshot. Without any of them it does not run.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  INDEX_FILE,
  KNOWLEDGE_ENV,
  MAX_DEPTH,
  MAX_PAGES,
  NOTION_API,
  NOTION_VERSION,
  REQUIRED_ENV,
  childPagesOf,
  fileFor,
  pageIdFrom,
  parseRequired,
  renderPage,
  renderRequired,
  resolveRequired,
  rewriteLinks,
  type LoadedPage,
} from '@aspiralabs/agent-common/lib/knowledge'
import type { Knowledge } from './fixer.ts'

/** The Notion pages the agent's knowledge configuration names, without the token. */
export type KnowledgeConfig = {
  /** KNOWLEDGE_PAGE: the index page the walk starts from, or null when none is configured. */
  page: string | null
  /** KNOWLEDGE_REQUIRED, else load-knowledge's default: the pages REQUIRED.md must hold, in order. */
  required: string[]
  maxDepth: number
  maxPages: number
  /** The env files that were read, in precedence order (later wins; the process env wins over all). */
  sources: string[]
}

/** The guidelines a run is held to, and where they came from. */
export type LoadedKnowledge = {
  source: 'notion' | 'knowledge' | 'guidelines'
  /** The folder in load-knowledge's layout (INDEX.md, one file per page), or null for a REQUIRED.md snapshot alone. */
  dir: string | null
  requiredFile: string
  /** sha256 over every file, so a run can refuse a mid-run change. */
  fingerprint: string
  /** Files relative to `dir` (or the snapshot's own name). */
  files: string[]
}

/** The stage that supplies the guidelines when a run has none: what to fetch, and where it goes. */
export type KnowledgePlan = KnowledgeConfig & { stage: 'knowledge'; dir: string; files: { required: string; index: string } }

/** The run will not start, or continue, without the engineering guidelines. */
export class KnowledgeRequired extends Error {
  /** What supplies them. */
  readonly plan: KnowledgePlan
  constructor(reason: string, plan: KnowledgePlan) {
    super(reason)
    this.name = 'KnowledgeRequired'
    this.plan = plan
  }
}

/** The agent's env as its package scripts load it (the shared `../.env.local`, `.env.local`, `.env.development.local`), with `env` on top. */
async function agentEnv(agentDir: string | null, env: NodeJS.ProcessEnv): Promise<{ values: Record<string, string>; sources: string[] }> {
  const values: Record<string, string> = {}
  const sources: string[] = []
  const files = agentDir === null ? [] : [join(agentDir, '..', '.env.local'), join(agentDir, '.env.local'), join(agentDir, '.env.development.local')]
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    sources.push(file)
    for (const [key, value] of Object.entries(parseEnv(text))) if (value !== undefined) values[key] = value
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) values[key] = value
  return { values, sources }
}

/** The agent's knowledge configuration. `agentDir` null reads `env` alone (eve has already loaded the env files). */
export async function knowledgeConfig(agentDir: string | null, env: NodeJS.ProcessEnv): Promise<KnowledgeConfig> {
  const { values, sources } = await agentEnv(agentDir, env)
  return { page: values[KNOWLEDGE_ENV.page]?.trim() || null, required: parseRequired(values[REQUIRED_ENV]), maxDepth: MAX_DEPTH, maxPages: MAX_PAGES, sources }
}

async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** The configured required pages REQUIRED.md lacks: a title needs its own `# <title>` heading, a URL or id its page id. */
export function missingRequired(required: string, wanted: string[]): string[] {
  return wanted.filter((entry) => {
    const id = pageIdFrom(entry)
    if (id !== undefined) return !required.includes(id) && !required.includes(id.replaceAll('-', ''))
    const title = entry.trim().toLowerCase()
    return !required.split('\n').some((line) => line.trim().toLowerCase() === `# ${title}`)
  })
}

const planFor = (config: KnowledgeConfig, dir: string): KnowledgePlan => ({ stage: 'knowledge', ...config, dir, files: { required: join(dir, 'REQUIRED.md'), index: join(dir, 'INDEX.md') } })

/** A folder in load-knowledge's layout: non-empty REQUIRED.md and INDEX.md, every configured required page present. */
export async function checkKnowledgeDir(dir: string, config: KnowledgeConfig, hint: string): Promise<LoadedKnowledge> {
  const refuse = (reason: string) => new KnowledgeRequired(`${reason} The engineering guidelines are required: ${hint}`, planFor(config, dir))
  const required = await readFile(join(dir, 'REQUIRED.md'), 'utf8').catch(() => null)
  if (required === null || required.trim() === '') throw refuse(`No REQUIRED.md in ${dir}.`)
  const index = await readFile(join(dir, 'INDEX.md'), 'utf8').catch(() => null)
  if (index === null || index.trim() === '') throw refuse(`No INDEX.md in ${dir}.`)
  const missing = missingRequired(required, config.required)
  if (missing.length > 0) throw refuse(`REQUIRED.md in ${dir} lacks the required page${missing.length === 1 ? '' : 's'} ${missing.join(', ')} (each under its own "# <title>" heading).`)
  const files = await filesUnder(dir)
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update('\0').update(await readFile(join(dir, file))).update('\0')
  return { source: 'knowledge', dir, requiredFile: join(dir, 'REQUIRED.md'), fingerprint: hash.digest('hex'), files }
}

/** A REQUIRED.md snapshot on its own (--guidelines FILE, as spec-reviewer, spec-writer and planner take it). */
export async function checkGuidelinesFile(file: string, config: KnowledgeConfig): Promise<LoadedKnowledge> {
  const plan = planFor(config, dirname(file))
  const info = await stat(file).catch(() => null)
  if (info === null || !info.isFile()) throw new KnowledgeRequired(`--guidelines ${file} is not a file. It takes a REQUIRED.md snapshot; a whole knowledge folder goes in --knowledge.`, plan)
  const text = await readFile(file, 'utf8')
  if (text.trim() === '') throw new KnowledgeRequired(`--guidelines ${file} is empty.`, plan)
  const missing = missingRequired(text, config.required)
  if (missing.length > 0) throw new KnowledgeRequired(`--guidelines ${file} lacks the required page${missing.length === 1 ? '' : 's'} ${missing.join(', ')} (each under its own "# <title>" heading).`, plan)
  return { source: 'guidelines', dir: null, requiredFile: file, fingerprint: createHash('sha256').update(text).digest('hex'), files: [basename(file)] }
}

/** What the fix prompt gets: the folder, the required file and its text. */
export async function fixKnowledge(knowledge: LoadedKnowledge): Promise<Knowledge> {
  return { path: knowledge.dir, requiredFile: knowledge.requiredFile, required: await readFile(knowledge.requiredFile, 'utf8') }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * load-knowledge on the host: the same breadth-first walk from KNOWLEDGE_PAGE, the same depth and
 * page caps, file names, link rewriting and REQUIRED.md, written to `dir` instead of the sandbox.
 * Throws when a required page was not reached, as load-knowledge does.
 */
export async function loadKnowledgeFromNotion(args: { token: string; page: string; required: string[]; dir: string; fetch?: Fetch }): Promise<{ written: string[]; skipped: string[] }> {
  const request = args.fetch ?? fetch
  const headers = { Authorization: `Bearer ${args.token}`, 'Notion-Version': NOTION_VERSION }
  const get = async (path: string, attempt = 0): Promise<unknown> => {
    const res = await request(`${NOTION_API}${path}`, { headers })
    if (res.status === 429 && attempt < 2) {
      await new Promise((done) => setTimeout(done, Math.min(Number(res.headers.get('retry-after') ?? '1') * 1000, 10_000)))
      return get(path, attempt + 1)
    }
    if (!res.ok) throw new Error(`Notion ${res.status} on ${path}${res.status === 404 || res.status === 403 ? ' (is the page shared with the integration?)' : ''}: ${(await res.text()).slice(0, 300)}`)
    return res.json()
  }
  const markdownOf = async (id: string) => {
    const body = await get(`/pages/${id}/markdown`)
    const markdown = typeof body === 'object' && body !== null && 'markdown' in body && typeof body.markdown === 'string' ? body.markdown : ''
    const truncated = typeof body === 'object' && body !== null && 'truncated' in body && body.truncated === true
    return { markdown, truncated }
  }
  const titleOf = async (id: string) => {
    const body = await get(`/pages/${id}`)
    const properties = typeof body === 'object' && body !== null && 'properties' in body && typeof body.properties === 'object' && body.properties !== null ? Object.values(body.properties) : []
    for (const prop of properties) {
      if (typeof prop !== 'object' || prop === null || !('type' in prop) || prop.type !== 'title' || !('title' in prop) || !Array.isArray(prop.title)) continue
      const text = prop.title.map((part: unknown) => (typeof part === 'object' && part !== null && 'plain_text' in part && typeof part.plain_text === 'string' ? part.plain_text : '')).join('').trim()
      if (text) return text
    }
    return 'Engineering'
  }

  const rootId = pageIdFrom(args.page)
  if (rootId === undefined) throw new Error(`Not a Notion page URL or id: ${args.page}`)
  // Paths as load-knowledge names them in the sandbox; only the file name is kept on the host.
  const local = (sandboxPath: string) => basename(sandboxPath)
  const queue = [{ id: rootId, title: await titleOf(rootId), url: args.page, depth: 0 }]
  const seen = new Set([rootId])
  const files = new Map([[rootId, INDEX_FILE]])
  const titles = new Map([[rootId, queue[0]?.title ?? 'Engineering']])
  const used = new Set([INDEX_FILE])
  const bodies = new Map<string, { markdown: string; truncated: boolean; title: string; url: string }>()
  const skipped: string[] = []
  while (queue.length > 0 && bodies.size < MAX_PAGES) {
    const next = queue.shift()
    if (next === undefined) break
    let body: { markdown: string; truncated: boolean }
    try {
      body = await markdownOf(next.id)
    } catch (error) {
      skipped.push(`${next.title}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    bodies.set(next.id, { ...body, title: next.title, url: next.url })
    if (next.depth >= MAX_DEPTH) continue
    for (const child of childPagesOf(body.markdown)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      let title = child.title
      if (title === '') {
        try {
          title = await titleOf(child.id)
        } catch (error) {
          skipped.push(`${child.url}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      files.set(child.id, fileFor(title, used))
      titles.set(child.id, title)
      queue.push({ ...child, title, depth: next.depth + 1 })
    }
  }
  // Links point at the host file names, which sit side by side like the sandbox ones.
  const hostFiles = new Map([...files].map(([id, path]) => [id, local(path)]))
  const fetchedAt = new Date().toISOString()
  await mkdir(args.dir, { recursive: true })
  const loaded: LoadedPage[] = []
  const written: string[] = []
  for (const [id, body] of bodies) {
    const name = hostFiles.get(id)
    if (name === undefined) continue
    const markdown = rewriteLinks(body.markdown, hostFiles, titles)
    loaded.push({ id, title: body.title, url: body.url, markdown })
    await writeFile(join(args.dir, name), renderPage({ title: body.title, url: body.url, fetchedAt, truncated: body.truncated }, markdown))
    written.push(name)
  }
  const resolved = resolveRequired(args.required, loaded)
  if (resolved.missing.length > 0) {
    throw new Error(`Required knowledge page${resolved.missing.length === 1 ? '' : 's'} not loaded: ${resolved.missing.join(', ')}. Loaded: ${loaded.map((p) => p.title).join(', ')}. Fix the title in ${REQUIRED_ENV}, or link the page from the index within ${MAX_DEPTH} levels and ${MAX_PAGES} pages.`)
  }
  await writeFile(join(args.dir, 'REQUIRED.md'), renderRequired(resolved.found, fetchedAt))
  written.push('REQUIRED.md')
  return { written, skipped }
}

/**
 * The guidelines for a default run, in order: a --knowledge folder, a --guidelines REQUIRED.md,
 * else Notion from the agent's env. Refuses (KnowledgeRequired) when none of them is available.
 */
export async function resolveKnowledge(input: { knowledge?: string; guidelines?: string }, deps: { agentDir: string | null; env: NodeJS.ProcessEnv; fetch?: Fetch; progress?: (message: string) => void }): Promise<LoadedKnowledge> {
  const config = await knowledgeConfig(deps.agentDir, deps.env)
  const hint = 'set NOTION_TOKEN and KNOWLEDGE_PAGE in the agent\'s env, or pass --knowledge DIR (a load-knowledge folder) or --guidelines FILE (a REQUIRED.md snapshot).'
  if (input.knowledge !== undefined) return checkKnowledgeDir(resolve(input.knowledge), config, hint)
  if (input.guidelines !== undefined) return checkGuidelinesFile(resolve(input.guidelines), config)
  const { values } = await agentEnv(deps.agentDir, deps.env)
  const token = values[KNOWLEDGE_ENV.token]?.trim()
  if (!token || config.page === null) {
    const missing = [!token && KNOWLEDGE_ENV.token, config.page === null && KNOWLEDGE_ENV.page].filter(Boolean).join(' and ')
    throw new KnowledgeRequired(`The engineering guidelines are required and none were given: ${missing} not set. To run, ${hint}`, planFor(config, join(tmpdir(), 'code-analyzer-knowledge')))
  }
  const dir = await mkdtemp(join(tmpdir(), 'code-analyzer-knowledge-'))
  deps.progress?.(`load-knowledge ${config.page}`)
  await loadKnowledgeFromNotion({ token, page: config.page, required: config.required, dir, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  return { ...(await checkKnowledgeDir(dir, config, hint)), source: 'notion' }
}
