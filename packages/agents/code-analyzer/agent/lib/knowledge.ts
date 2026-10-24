// The engineering guidelines for every code-analyzer path. The other agents load them with the
// shared load-knowledge tool, which writes into the eve sandbox; code-analyzer's fixer runs on the
// host for local and remote repositories alike, so this walks the same Notion tree through the
// one shared walk (packages/ai/common/src/lib/knowledge-walk.ts) into a host folder instead of
// the sandbox. A run gets them one of three ways: from Notion (NOTION_TOKEN + KNOWLEDGE_PAGE),
// from a --knowledge folder in load-knowledge's layout, or from a --guidelines REQUIRED.md
// snapshot. Without any of them it does not run.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { KNOWLEDGE_ENV, MAX_DEPTH, MAX_PAGES, REQUIRED_ENV, pageIdFrom, parseRequired } from '@aspiralabs/ai/common/lib/knowledge'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/ai/common/lib/knowledge-walk'
import { notionToken } from '@aspiralabs/ai/common/lib/notion-token'
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
 * The guidelines for a default run, in order: a --knowledge folder, a --guidelines REQUIRED.md,
 * else Notion from the agent's env, through the one shared walk (knowledge-walk.ts) instead of a
 * host copy of it. Refuses (KnowledgeRequired) when none of them is available.
 *
 * checkKnowledgeDir/checkGuidelinesFile still check the folder/file the way they always have
 * (REQUIRED.md and INDEX.md present, every configured required page present by heading) rather
 * than through knowledge-snapshot.ts's hash-verifying verifyKnowledgeDir/verifySnapshot: runLocal
 * (./local.ts) does not yet pass those checks a resolved Notion root id to verify against, and
 * sessions still write REQUIRED.md snapshots without the new provenance header (see
 * knowledge-stage.test.ts, T64 -- wiring that through is P27's job, not this one's).
 */
export async function resolveKnowledge(input: { knowledge?: string; guidelines?: string }, deps: { agentDir: string | null; env: NodeJS.ProcessEnv; fetch?: Fetch; progress?: (message: string) => void }): Promise<LoadedKnowledge> {
  const config = await knowledgeConfig(deps.agentDir, deps.env)
  const hint = 'set NOTION_TOKEN and KNOWLEDGE_PAGE in the agent\'s env, or pass --knowledge DIR (a load-knowledge folder) or --guidelines FILE (a REQUIRED.md snapshot).'
  if (input.knowledge !== undefined) return checkKnowledgeDir(resolve(input.knowledge), config, hint)
  if (input.guidelines !== undefined) return checkGuidelinesFile(resolve(input.guidelines), config)

  // notionToken never reads an agent package's own .env.local (packages/ai/common/src/lib/
  // notion-token.ts); the agent's shared ../.env.local plays the "project root" role here, and the
  // agent's own .env.local (if the deployment carries one) plays "app", so the agent's own value
  // still wins over the shared one, exactly as agentEnv's own precedence did.
  const resolvedToken =
    deps.agentDir === null
      ? await notionToken({ env: deps.env, projectRoot: NO_PROJECT_ROOT })
      : await notionToken({ env: deps.env, projectRoot: join(deps.agentDir, '..'), appDir: deps.agentDir })
  const token = resolvedToken?.token
  if (token === undefined || config.page === null) {
    const missing = [token === undefined && KNOWLEDGE_ENV.token, config.page === null && KNOWLEDGE_ENV.page].filter(Boolean).join(' and ')
    throw new KnowledgeRequired(`The engineering guidelines are required and none were given: ${missing} not set. To run, ${hint}`, planFor(config, join(tmpdir(), 'code-analyzer-knowledge')))
  }
  const dir = await mkdtemp(join(tmpdir(), 'code-analyzer-knowledge-'))
  deps.progress?.(`load-knowledge ${config.page}`)
  const walk = await walkKnowledge({ token, page: config.page, required: config.required, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  await writeKnowledgeFolder(dir, walk)
  return { ...(await checkKnowledgeDir(dir, config, hint)), source: 'notion' }
}

/** A path that cannot carry a real project's .env.local, for when there is no agent directory to anchor one. */
const NO_PROJECT_ROOT = join(tmpdir(), '.aspira-no-project-root-sentinel')
