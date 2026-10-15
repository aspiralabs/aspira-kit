// Same module as spec-writer/agent/lib/local-knowledge.ts; a candidate for packages/agents/common.
// The engineering guidelines for --local, decided by the agent's own knowledge configuration.
// load-knowledge walks Notion from KNOWLEDGE_PAGE and writes REQUIRED.md (the KNOWLEDGE_REQUIRED
// pages, under its provenance header) beside INDEX.md and one file per page. The first call of a
// --local run fetches that folder itself through the one shared walk (knowledge-walk.ts), with the
// NOTION_TOKEN the project's env gives it (F49, F52); every later or resumed call of the same run
// reads the folder already there, and the session never fetches guidelines. Without a token there
// is nothing to fetch with, and the run ends blocked. A --guidelines snapshot stands in for the
// folder only when it is a REQUIRED.md load-knowledge wrote, verified by its header (F50).

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { INDEX_FILE, KNOWLEDGE_ENV, MAX_DEPTH, MAX_PAGES, REQUIRED_ENV, REQUIRED_FILE, pageIdFrom, parseRequired } from '@aspiralabs/agent-common/lib/knowledge'
import { parseProvenance, verifySnapshot } from '@aspiralabs/agent-common/lib/knowledge-snapshot'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/agent-common/lib/knowledge-walk'
import { notionToken } from '@aspiralabs/agent-common/lib/notion-token'
import { KnowledgePrerequisiteError } from '@aspiralabs/agent-common/lib/ticket-driver'

/** Environment variables as the agent sees them. */
export type Env = Record<string, string | undefined>

/** The env files the agent loads, lowest priority first: the shared file `pnpm review` reads, then eve's. */
export const ENV_FILES = ['../.env.local', '.env.local', '.env.development.local'] as const

/** Which pages load-knowledge would load for this agent. Holds no secrets. */
export type KnowledgeConfig = {
  /** KNOWLEDGE_PAGE: the index page the walk starts from, or null when the agent has none configured. */
  root: string | null
  /** KNOWLEDGE_REQUIRED (or its default): the pages REQUIRED.md concatenates, in order. */
  required: string[]
  /** How far below the index and how many pages load-knowledge reads. */
  maxDepth: number
  maxPages: number
}

/** Where this run's folder sits and which pages it holds, for a refusal to name. */
export type KnowledgePlan = KnowledgeConfig & {
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

const LOAD_KNOWLEDGE = 'load-knowledge --out <dir> (packages/agents/common/scripts/load-knowledge.ts)'

/** The folder this run loaded is incomplete (a required page missing, a page truncated): blocked, exit 1, through handleRunError. */
export class KnowledgeRequired extends KnowledgePrerequisiteError {
  /** The pages the folder should hold and where it sits. */
  readonly plan: KnowledgePlan

  /** @param plan the folder and what is wrong with it. */
  constructor(plan: KnowledgePlan) {
    const why = plan.problems.length > 0 ? plan.problems.join('; ') : `${join(plan.dir, plan.files.required)} does not exist`
    super(`The engineering guidelines are required before a --local run starts: ${why}. Delete ${plan.dir} so the next call loads it again from Notion.`)
    this.name = 'KnowledgeRequired'
    this.plan = plan
  }
}

/** No folder yet and nothing to fetch it with (no NOTION_TOKEN, or no KNOWLEDGE_PAGE): runLocal returns this as a blocked result (F52), never a pending session stage. */
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
export async function knowledgeSource(repo: string, env: Env): Promise<Omit<KnowledgeSource, 'fetch' | 'api'>> {
  const root = resolve(repo)
  const aspira = await readFile(join(root, 'aspira.json'), 'utf8').then((text) => JSON.parse(text) as { app?: unknown }, () => null)
  const app = typeof aspira?.app === 'string' && aspira.app !== '.' && aspira.app !== '' ? resolve(root, aspira.app) : undefined
  const found = await notionToken({ env, projectRoot: root, ...(app === undefined ? {} : { appDir: app }) })
  return { ...(found === null ? {} : { token: found.token }), tokenFiles: [...(app === undefined ? [] : [join(app, '.env.local')]), join(root, '.env.local')] }
}

/** The agent's knowledge configuration: its env files, then the given environment, highest priority last. */
export async function knowledgeConfig(agentDir: string, env: Env): Promise<KnowledgeConfig> {
  const merged: Env = {}
  for (const file of ENV_FILES) {
    const text = await readFile(resolve(agentDir, file), 'utf8').catch(() => null)
    if (text !== null) Object.assign(merged, parseEnv(text))
  }
  for (const key of [KNOWLEDGE_ENV.page, REQUIRED_ENV]) if (env[key] !== undefined) merged[key] = env[key]
  const root = merged[KNOWLEDGE_ENV.page]?.trim()
  return { root: root ? root : null, required: parseRequired(merged[REQUIRED_ENV]), maxDepth: MAX_DEPTH, maxPages: MAX_PAGES }
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

/**
 * The run's own folder: the first call (no REQUIRED.md yet) fetches it through the shared walk with
 * `source`'s token; every later call reads what is there with no Notion request. Throws
 * KnowledgeBlocked when there is no folder and no token or KNOWLEDGE_PAGE to fetch with, and
 * KnowledgeRequired when the folder is incomplete.
 */
export async function loadKnowledge(dir: string, config: KnowledgeConfig, source: KnowledgeSource = { tokenFiles: [] }): Promise<Knowledge> {
  const path = resolve(dir)
  if ((await readFile(join(path, REQUIRED_NAME), 'utf8').catch(() => null)) === null) {
    if (source.token === undefined || config.root === null) {
      const missing = [source.token === undefined && `${KNOWLEDGE_ENV.token} is not set in the environment${source.tokenFiles.length > 0 ? ` or in ${source.tokenFiles.join(' or ')}` : ''}`, config.root === null && `${KNOWLEDGE_ENV.page} is not set in the agent's env (${ENV_FILES.join(', ')})`].filter(Boolean).join('; ')
      throw new KnowledgeBlocked(`The engineering guidelines are required and cannot be loaded from Notion: ${missing}. Set it, or run ${LOAD_KNOWLEDGE} and give the run its REQUIRED.md.`)
    }
    const walk = await walkKnowledge({ token: source.token, page: config.root, required: config.required, ...(source.fetch ? { fetch: source.fetch } : {}), ...(source.api ? { api: source.api } : {}) })
    await writeKnowledgeFolder(path, walk)
  }
  const names = (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  const plan: KnowledgePlan = { ...config, dir: path, files: { required: REQUIRED_NAME, index: INDEX_NAME }, problems: [] }
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

/**
 * A --guidelines snapshot: accepted only when it is a REQUIRED.md load-knowledge wrote, still where
 * it was written and unedited, and loaded from this run's KNOWLEDGE_PAGE when one is configured
 * (F50). A copy under a trace/ folder or a file without the header is refused, naming load-knowledge.
 */
export async function snapshotKnowledge(file: string, config: Pick<KnowledgeConfig, 'root'> = { root: null }): Promise<Knowledge> {
  const path = resolve(file)
  const header = parseProvenance(await readFile(path, 'utf8').catch(() => ''))
  const expectedRootId = (config.root === null ? undefined : pageIdFrom(config.root)) ?? header?.rootId ?? ''
  const verified = await verifySnapshot(path, { expectedRootId })
  if (!verified.ok) throw new KnowledgePrerequisiteError(`--guidelines ${path} is refused: ${verified.reason} ${verified.hint}`)
  const { files, digest } = await fingerprint(dirname(path), [basename(path)])
  return { source: 'snapshot', path, requiredFile: path, files, digest }
}
