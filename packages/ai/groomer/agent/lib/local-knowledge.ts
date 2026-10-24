// The engineering guidelines for --local, decided by the agent's own knowledge configuration.
// Before P27 this named the pages (the knowledge stage) for the session to fetch over the Notion
// MCP into a folder of the same shape, and the driver refused to start until that folder was
// complete. Now loadKnowledge fetches that folder itself, once, through the one shared walk
// (knowledge-walk.ts): the first call of a groom run finds no folder yet and builds it from
// KNOWLEDGE_PAGE with walkKnowledge/writeKnowledgeFolder before any round prompt is written; every
// later or resumed call (a later stage of the same round, or round 2+ of the same ticket) just
// reads the folder that is already there -- no new Notion request. Without a NOTION_TOKEN or a
// KNOWLEDGE_PAGE to fetch with, and no folder already in place, the run is blocked (KnowledgeBlocked),
// not printed as a pending stage for the session to resolve. A --guidelines snapshot still stands in
// for the folder, as it does for the agent's CLI.

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { INDEX_FILE, KNOWLEDGE_ENV, MAX_DEPTH, MAX_PAGES, REQUIRED_ENV, REQUIRED_FILE, pageIdFrom, parseRequired } from '@aspiralabs/ai/common/lib/knowledge'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/ai/common/lib/knowledge-walk'
import { notionToken } from '@aspiralabs/ai/common/lib/notion-token'
import { KnowledgePrerequisiteError } from '@aspiralabs/ai/common/lib/ticket-driver'

/** The knowledge walk's own fetch and API base, for tests only; a real run hits Notion's API with the global fetch. */
export type WalkDeps = { fetch?: (url: string, init?: RequestInit) => Promise<Response>; api?: string }

/** Environment variables as the agent sees them. */
export type Env = Record<string, string | undefined>

/** The env files the agent loads, lowest priority first: the shared file `pnpm review` reads, then eve's. */
export const ENV_FILES = ['../.env.local', '.env.local', '.env.development.local'] as const

/** Which pages load-knowledge would load for this agent, and the token this run fetches them with. */
export type KnowledgeConfig = {
  /** KNOWLEDGE_PAGE: the index page the walk starts from, or null when the agent has none configured. */
  root: string | null
  /** KNOWLEDGE_REQUIRED (or its default): the pages REQUIRED.md concatenates, in order. */
  required: string[]
  /** How far below the index and how many pages load-knowledge reads. */
  maxDepth: number
  maxPages: number
  /** NOTION_TOKEN, the project's (F52): the environment, then the project root's .env.local; never the agent's env files. Never part of KnowledgePlan: that shape is printed. */
  token: string | undefined
  /** Where the token was looked for, named when the run is blocked without one. */
  tokenFrom: string
}

/** The knowledge stage: where the folder this run built or is missing sits, and which pages. Never carries the token. */
export type KnowledgePlan = Omit<KnowledgeConfig, 'token' | 'tokenFrom'> & {
  /** The folder to write, in load-knowledge's layout. */
  dir: string
  files: { required: string; index: string }
  /** Why the folder that is there was not accepted. Empty when there is no folder yet. */
  problems: string[]
}

/** The rules a run used: what the export records and the fingerprint covers. */
export type Knowledge = {
  source: 'folder' | 'snapshot'
  path: string
  /** The REQUIRED GUIDELINES text every phase gets. */
  requiredFile: string
  files: { name: string; sha256: string }[]
  digest: string
}

const REQUIRED_NAME = basename(REQUIRED_FILE)
const INDEX_NAME = basename(INDEX_FILE)
const TRUNCATED = /TRUNCATED by the Notion API/i

/** The driver will not start without the engineering guidelines. `plan` is the knowledge stage. */
export class KnowledgeRequired extends Error {
  /** The pages to fetch and where to put them. */
  readonly plan: KnowledgePlan

  /** @param plan the knowledge stage to print instead of starting. */
  constructor(plan: KnowledgePlan) {
    const why = plan.problems.length > 0 ? plan.problems.join('; ') : `${join(plan.dir, plan.files.required)} does not exist`
    super(`The engineering guidelines are required before a --local run starts: ${why}. Build ${plan.dir} from Notion as the knowledge stage lists, or pass --guidelines.`)
    this.name = 'KnowledgeRequired'
    this.plan = plan
  }
}

/** Thrown when the folder is missing and there is no NOTION_TOKEN (or no KNOWLEDGE_PAGE) to fetch it with: handleRunError reports this as blocked, exit 1 -- never the old pending session stage. */
export class KnowledgeBlocked extends KnowledgePrerequisiteError {
  readonly pending = false as const
  readonly status = 'blocked' as const
}

/**
 * The agent's knowledge configuration: the page list from its env files, then the given environment,
 * highest priority last; the token from the environment, then `projectRoot`'s .env.local (F52).
 */
export async function knowledgeConfig(agentDir: string, env: Env, projectRoot?: string): Promise<KnowledgeConfig> {
  const merged: Env = {}
  for (const file of ENV_FILES) {
    const text = await readFile(resolve(agentDir, file), 'utf8').catch(() => null)
    if (text !== null) Object.assign(merged, parseEnv(text))
  }
  for (const key of [KNOWLEDGE_ENV.page, REQUIRED_ENV]) if (env[key] !== undefined) merged[key] = env[key]
  const root = merged[KNOWLEDGE_ENV.page]?.trim()
  const fromEnv = env[KNOWLEDGE_ENV.token]?.trim()
  const token = projectRoot === undefined ? (fromEnv ? fromEnv : undefined) : (await notionToken({ env, projectRoot }))?.token.trim()
  const tokenFrom = projectRoot === undefined ? 'the environment' : `the environment or ${join(projectRoot, '.env.local')}`
  return { root: root ? root : null, required: parseRequired(merged[REQUIRED_ENV]), maxDepth: MAX_DEPTH, maxPages: MAX_PAGES, token: token ? token : undefined, tokenFrom }
}

async function fingerprint(path: string, names: string[]) {
  const files: Knowledge['files'] = []
  const texts = new Map<string, string>()
  for (const name of names) {
    const text = await readFile(join(path, name), 'utf8')
    texts.set(name, text)
    files.push({ name, sha256: createHash('sha256').update(text).digest('hex') })
  }
  return { files, texts, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

/** True when REQUIRED.md holds the page: a `# <title>` heading, or its Notion id for a URL or id entry. */
function holds(required: string, entry: string): boolean {
  const id = pageIdFrom(entry)
  if (id !== undefined) return required.includes(id) || required.includes(id.replaceAll('-', ''))
  const title = entry.trim().toLowerCase()
  return required.split('\n').some((line) => line.trim().toLowerCase() === `# ${title}`)
}

const planFor = (config: KnowledgeConfig, dir: string): KnowledgePlan => ({ root: config.root, required: config.required, maxDepth: config.maxDepth, maxPages: config.maxPages, dir, files: { required: REQUIRED_NAME, index: INDEX_NAME }, problems: [] })

/**
 * The guidelines for a groom run: the first call of the run (no folder there yet) fetches the
 * pages itself through the one shared walk (knowledge-walk.ts) straight into `dir`, needing a
 * NOTION_TOKEN and KNOWLEDGE_PAGE -- missing either throws KnowledgeBlocked, never the old pending
 * session stage. Every later or resumed call (a later stage of the round, or the next round) just
 * reads the folder that is already there: no new Notion request. Throws KnowledgeRequired when the
 * folder (freshly fetched or already there) is still incomplete.
 */
export async function loadKnowledge(dir: string, config: KnowledgeConfig, walkDeps: WalkDeps = {}): Promise<Knowledge> {
  const path = resolve(dir)
  const requiredPath = join(path, REQUIRED_NAME)
  const already = (await readFile(requiredPath, 'utf8').catch(() => null)) !== null
  if (!already) {
    if (config.token === undefined || config.root === null) {
      const where = [
        config.token === undefined && `${KNOWLEDGE_ENV.token} is not set in ${config.tokenFrom}`,
        config.root === null && `${KNOWLEDGE_ENV.page} is not set in the agent's env (${ENV_FILES.join(', ')})`,
      ].filter(Boolean).join('; ')
      throw new KnowledgeBlocked(`The engineering guidelines are required and none were given: ${where}. Set them, or pass --guidelines.`)
    }
    const walk = await walkKnowledge({ token: config.token, page: config.root, required: config.required, ...(walkDeps.fetch ? { fetch: walkDeps.fetch } : {}), ...(walkDeps.api ? { api: walkDeps.api } : {}) })
    await writeKnowledgeFolder(path, walk)
  }
  const names = (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  const plan: KnowledgePlan = planFor(config, path)
  if (names.length === 0) throw new KnowledgeRequired(plan)
  const { files, texts, digest } = await fingerprint(path, names)
  const required = texts.get(REQUIRED_NAME) ?? ''
  if (!required.trim()) plan.problems.push(`${REQUIRED_NAME} is missing or empty`)
  if (!(texts.get(INDEX_NAME) ?? '').trim()) plan.problems.push(`${INDEX_NAME} is missing or empty`)
  for (const entry of config.required) if (required.trim() && !holds(required, entry)) plan.problems.push(`${REQUIRED_NAME} does not hold the required page "${entry}"`)
  for (const [name, text] of texts) if (TRUNCATED.test(text)) plan.problems.push(`${name} is truncated`)
  if (plan.problems.length > 0) throw new KnowledgeRequired(plan)
  return { source: 'folder', path, requiredFile: join(path, REQUIRED_NAME), files, digest }
}

/** A --guidelines snapshot: the required text only, as the agent's CLI takes it. */
export async function snapshotKnowledge(file: string): Promise<Knowledge> {
  const path = resolve(file)
  const { files, digest } = await fingerprint(resolve(path, '..'), [basename(path)])
  return { source: 'snapshot', path, requiredFile: path, files, digest }
}

/** The required pages a guidelines text (REQUIRED.md or a --guidelines snapshot) does not hold, in order. */
export function missingRequired(text: string, required: string[]): string[] {
  return required.filter((entry) => !holds(text, entry))
}
