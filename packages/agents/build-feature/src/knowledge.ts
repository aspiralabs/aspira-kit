// The engineering guidelines, built once per ticket and verified per step (KIT-48). Every step used
// to walk Notion into its own folder on every run and rerun; here build-feature walks it once into
// `.work/<id>-<slug>/knowledge/` (the full walk, never a partial snapshot: the KIT-8 rule stands) and,
// before each step, compares the folder's pages against Notion by hash. Unchanged, the step gets the
// folder (`--guidelines <dir>/REQUIRED.md`, or `--knowledge <dir>` for the steps that take a folder);
// any page changed, the whole folder is rebuilt. The index page is KNOWLEDGE_PAGE, else aspira.json
// `knowledge` (a step subagent never sees a shell rc changed after the session started; aspira.json
// is in the repository). Without a Notion token or an index page nothing is built and every step
// loads its own guidelines as before.

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { KNOWLEDGE_ENV, parseRequired, REQUIRED_ENV } from '@aspiralabs/agent-common/lib/knowledge'
import { compareSnapshot } from '@aspiralabs/agent-common/lib/knowledge-snapshot'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/agent-common/lib/knowledge-walk'
import { notionToken } from '@aspiralabs/agent-common/lib/notion-token'
import type { StepName } from '#src/route.ts'
import type { RunState } from '#src/run-state.ts'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** The folder a step gets, and the file the snapshot-taking steps read. */
export type SharedKnowledge = { dir: string; requiredFile: string }

/** What the run records about its folder (state.phases.knowledge). */
const recordSchema = z.object({ dir: z.string(), builtAt: z.string(), verifiedAt: z.string(), pages: z.number(), rebuilds: z.number().default(0) })
export type KnowledgeRecord = z.infer<typeof recordSchema>

export const knowledgeRecordOf = (state: Pick<RunState, 'phases'>): KnowledgeRecord | null => {
  const parsed = recordSchema.safeParse(state.phases.knowledge)
  return parsed.success ? parsed.data : null
}

export type EnsureInput = {
  env: Record<string, string | undefined>
  repo: string
  app?: string
  /** aspira.json `knowledge`: the index page when the environment names none. */
  page?: string
  folder: string
  now: string
  fetch?: Fetch
  api?: string
}

export type EnsureResult = { state: RunState; knowledge: SharedKnowledge | null; note: string | null }

/**
 * The shared folder for the next step: built on the first step, verified against Notion on every
 * later one and rebuilt whole when a page changed. Null, with the reason, when the run cannot
 * build one (no token, no index page, Notion unreachable); the step then loads its own.
 */
export async function ensureKnowledge(state: RunState, input: EnsureInput): Promise<EnsureResult> {
  const token = (await notionToken({ env: input.env, projectRoot: input.repo, ...(input.app === undefined || input.app === '.' ? {} : { appDir: resolve(input.repo, input.app) }) }))?.token
  const page = input.env[KNOWLEDGE_ENV.page]?.trim() || input.page?.trim()
  if (token === undefined || token === '' || page === undefined || page === '') return { state, knowledge: null, note: null }
  const required = parseRequired(input.env[REQUIRED_ENV])
  const dir = join(input.folder, 'knowledge')
  const requiredFile = join(dir, 'REQUIRED.md')
  const deps = { token, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.api ? { api: input.api } : {}) }
  const existing = await readFile(requiredFile, 'utf8').catch(() => null)
  const record = knowledgeRecordOf(state)
  if (existing !== null && record !== null && record.dir === dir) {
    const compared = await compareSnapshot(existing, deps)
    if (compared.comparable && compared.changed.length === 0) {
      return { state: withRecord(state, { ...record, verifiedAt: input.now }), knowledge: { dir, requiredFile }, note: null }
    }
    if (!compared.comparable) return { state, knowledge: null, note: `Engineering guidelines: ${compared.reason} The step loads its own.` }
  }
  try {
    const walk = await walkKnowledge({ token, page, required, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.api ? { api: input.api } : {}) })
    await writeKnowledgeFolder(dir, walk, { ticketFolder: input.folder })
    const rebuilds = existing !== null && record !== null ? record.rebuilds + 1 : 0
    return { state: withRecord(state, { dir, builtAt: input.now, verifiedAt: input.now, pages: walk.pages.length, rebuilds }), knowledge: { dir, requiredFile }, note: null }
  } catch (error) {
    return { state, knowledge: null, note: `Engineering guidelines could not be built once for the run (${error instanceof Error ? error.message : String(error)}); the step loads its own.` }
  }
}

const withRecord = (state: RunState, record: KnowledgeRecord): RunState => ({ ...state, phases: { ...state.phases, knowledge: record } })

/** Which flag a step takes the shared folder through: a REQUIRED.md snapshot, or the folder itself. */
export function knowledgeFlag(step: StepName, knowledge: SharedKnowledge): string {
  return step === 'code-analyzer' || step === 'pr-reviewer' ? `--knowledge ${knowledge.dir}` : `--guidelines ${knowledge.requiredFile}`
}
