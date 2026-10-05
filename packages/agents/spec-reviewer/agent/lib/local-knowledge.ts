// The engineering guidelines for --local, decided by the agent's own knowledge configuration.
// load-knowledge walks Notion from KNOWLEDGE_PAGE and writes REQUIRED.md (the KNOWLEDGE_REQUIRED
// pages) beside INDEX.md and one file per page. --local makes no Notion calls itself: it names
// those pages (the knowledge stage), the session fetches them into a folder of the same shape,
// and the driver refuses to start until that folder is complete. A --guidelines snapshot stands
// in for the folder, as it does for the agent's CLI.

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { INDEX_FILE, KNOWLEDGE_ENV, MAX_DEPTH, MAX_PAGES, REQUIRED_ENV, REQUIRED_FILE, pageIdFrom, parseRequired } from '@aspiralabs/agent-common/lib/knowledge'

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

/** The knowledge stage: where the session puts the pages, and which pages. */
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

/** The session-built folder, checked against the agent's configuration. Throws KnowledgeRequired when incomplete. */
export async function loadKnowledge(dir: string, config: KnowledgeConfig): Promise<Knowledge> {
  const path = resolve(dir)
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

/** A --guidelines snapshot: the required text only, as the agent's CLI takes it. */
export async function snapshotKnowledge(file: string): Promise<Knowledge> {
  const path = resolve(file)
  const { files, digest } = await fingerprint(resolve(path, '..'), [basename(path)])
  return { source: 'snapshot', path, requiredFile: path, files, digest }
}
