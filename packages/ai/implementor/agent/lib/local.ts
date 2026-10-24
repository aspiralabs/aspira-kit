// --local: the implementor's procedure with this Claude Code session as the orchestrator and its
// subagents as the lane workers. Each call makes no model call. It replays the run over the files
// already in the run directory and returns the first stage that has work left, once the run has
// loaded its knowledge itself (load-knowledge's shared walk; blocked without a NOTION_TOKEN): the plan (spec input), the parallelization, each wave's
// worker lanes and the orchestrator's commit of that wave, and the final verification. Every
// prompt is assembled when the step runs from the agent's own files: its procedure (the skill eve
// loads, agent/skills/aspira-implementor/SKILL.md) and its instructions (agent/instructions.md).
// Nothing in this file restates their rules.

import { execFile } from 'node:child_process'
import { RESEARCH_RULE, sessionResearchTools } from '@aspiralabs/ai/common/lib/research-rule'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { changedApps } from '@aspiralabs/ai/common/lib/changed-apps'
import type { SessionModel } from '@aspiralabs/ai/common/lib/session-model'
import { taskModel, type Effort } from '@aspiralabs/ai/common/lib/model-config'
import { readRunStatus, type ReasonCode } from '@aspiralabs/ai/common/lib/run-status'
import { parseTicketMd, TICKET_FILE } from '@aspiralabs/ai/common/lib/ticket'
import { dependenciesAdded, renderDependencies, type DependencyReport } from './dependencies.ts'
import { walkKnowledge, writeKnowledgeFolder } from '@aspiralabs/ai/common/lib/knowledge-walk'
import { KnowledgePrerequisiteError } from '@aspiralabs/ai/common/lib/ticket-driver'
import {
  agentEnv,
  hasProvenance,
  inspectKnowledge,
  KnowledgeBlocked,
  knowledgeConfig,
  knowledgeFiles,
  knowledgeFingerprint,
  knowledgeToken,
  LOAD_KNOWLEDGE,
  requiredFetchedAt,
  verifyGuidelines,
  writeRequired,
  REQUIRED_NAME,
  type KnowledgeConfig,
  type RecordedPage,
} from './local-knowledge.ts'
import {
  SCHEMAS,
  baselineWaves,
  renderAssumptions,
  parallelizationProblems,
  planProblems,
  targetProblems,
  writeSet,
  type Lane,
  type Parallelization,
  type Plan,
  type SchemaName,
} from './local-plan.ts'
import { checkNotes, notesFilesIn, notesHeaderSha, repoSearcher, staleIdentifiers, type Finding } from './notes.ts'

const run = promisify(execFile)
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** The agent's procedure, relative to the package: the skill eve loads with load_skill. */
export const PROCEDURE_FILE = 'agent/skills/aspira-implementor/SKILL.md'
/** The agent's system prompt, relative to the package. */
export const INSTRUCTIONS_FILE = 'agent/instructions.md'
/** The run directory inside the work directory: knowledge, prompts, outputs and state between steps. */
export const RUN_DIR = 'implementation.local'

/** What one `local` call is asked to do. */
export type LocalInput = {
  /** A plan.review directory, its plan.reviewed.md, or a spec file. A leading @ is dropped. */
  source: string
  /** The local repository; default: the git repository holding the source. */
  repo?: string
  /** A REQUIRED.md snapshot load-knowledge wrote, used instead of live Notion pages (F50). */
  guidelines?: string
  /** Cap on concurrent worker lanes (default 4); fixed by the first call of a run. */
  maxParallel?: number
  /** No worker lanes: the session builds every task itself. */
  serial?: boolean
  /** The work directory; default: the procedure's (plan.review/, implementation/ beside a spec, .work/<ticket>/). */
  work?: string
  /** Export what exists now, with the missing stages listed. */
  finish?: boolean
}

/** Seams for tests: the agent package to read files from, the env its knowledge config and token come from, and the knowledge walk's own fetch/API base (never set outside tests). */
export type LocalDeps = { packageDir?: string; env?: Record<string, string | undefined>; now?: () => Date; fetch?: (url: string, init?: RequestInit) => Promise<Response>; api?: string }

/** Where a run is. */
export type Stage = 'plan' | 'parallelize' | 'wave' | 'wave-commit' | 'verification'

/** A task as printed for the session. Orchestrator tasks run in the session; worker tasks run as subagents. */
/** `model` (KIT-48): the session model the task runs on; lane workers on Sonnet, the orchestrator's own turns on Opus. */
export type LocalTask = { id: string; agent: 'orchestrator' | 'worker'; prompt: string; output: string; schema: SchemaName; effort?: Effort; model: SessionModel; error?: string; retry?: boolean }

/** A model stage for the session to run. */
export type LocalPending = { pending: true; status: 'pending'; stage: Stage; wave?: number; workDir: string; runDir: string; parallel: boolean; tasks: LocalTask[] }

/** The run is over: exported (`ready`/`incomplete`), refused or blocked at the gate, or blocked before it started because the knowledge could not be loaded. */
export type LocalDone = {
  pending: false
  status: 'ready' | 'incomplete' | 'refused' | 'blocked'
  reason?: string
  /** Which sub-case of status this is (a plan gone stale under a drifted repository, say). */
  reasonCode?: ReasonCode | null
  problems?: string[]
  workDir: string
  export: string | null
  missing: { id: string; reason: string }[]
  verification?: z.infer<typeof SCHEMAS.VERIFICATION>
  /** A ready export only: the branch the board-stage gate made the ticket branch. */
  branch?: string
  /** A ready export only: the app directories the build touched (changedApps), from the plan's repoCommit. */
  apps?: string[]
  /** A ready export only: HEAD when the build finished. */
  head?: string
}

/** Any step's result. */
export type LocalResult = LocalPending | LocalDone

/**
 * Where a finished run's board trace, agent version and end-of-run board actions go: the run's work
 * folder (plan.review/), never `export`, which is the path of the trace file inside it. Null for a run
 * that exported nothing.
 */
export const exportDirOf = (result: LocalDone): string | null => (result.export === null ? null : result.workDir)

type Kind = 'plan' | 'spec' | 'ticket'
type Source = { kind: Kind; path: string; repo: string; workDir: string; planFile: string; reviewFile: string | null; trailer: string | null; note: string | null }
type Knowledge = { source: 'notion' | 'guidelines'; fingerprint: string; fetchedAt: string | null; pages: RecordedPage[]; config: KnowledgeConfig | null }

const stateSchema = z.object({
  source: z.string(),
  sourceFingerprint: z.string(),
  maxParallel: z.number(),
  serial: z.boolean(),
  startedAt: z.string(),
  /** HEAD when the run started: the branch base when the default branch cannot be resolved. */
  startCommit: z.string().default(''),
  knowledge: z
    .object({
      source: z.enum(['notion', 'guidelines']),
      fingerprint: z.string(),
      fetchedAt: z.string().nullable(),
      pages: z.array(z.object({ role: z.enum(['index', 'required', 'topic', 'snapshot']), title: z.string(), url: z.string().nullable(), file: z.string(), sha256: z.string() })),
      config: z.object({ indexPage: z.string().nullable(), required: z.array(z.string()), from: z.array(z.string()) }).nullable(),
    })
    .nullable(),
  // Read through readRunStatus so a state saved before the five-status rename (one of run-status.ts's
  // old per-skill words) still resumes instead of failing the schema (F7).
  gate: z
    .object({
      status: z.string().transform((word) => readRunStatus(word)?.status ?? word),
      repoCommit: z.string().nullable(),
      head: z.string(),
      decisions: z.array(z.unknown()),
      // The Plan page's own URL when this gate's review.json was rebuilt from the Plan page's fenced
      // block rather than produced by this machine's own planner run (F36); absent for an ordinary run.
      recoveredFrom: z.string().nullable().optional(),
    })
    .nullable(),
  // Pre-upgrade states carry the old boolean flag; read as "not yet accepted" (its only effect is a
  // redundant target recheck, never incorrect behavior) so the schema does not reject the state.
  planAccepted: z
    .union([z.string(), z.boolean()])
    .nullable()
    .transform((value) => (typeof value === 'boolean' ? null : value)),
  rejections: z.record(z.string(), z.array(z.string())),
})
type State = z.infer<typeof stateSchema>

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
async function git(repo: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', repo, ...args])).stdout.trim()
}

/** Whether `commit` is an ancestor of (or equal to) `head` in `repo`: a recovered plan's gate needs its repoCommit to still be in this branch's history. */
async function isAncestor(repo: string, commit: string, head: string): Promise<boolean> {
  return run('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, head]).then(
    () => true,
    () => false,
  )
}

/** The worker brief template in the procedure: the fenced block after "Use this template:". */
export function workerBriefTemplate(procedure: string): string {
  const at = procedure.indexOf('Use this template:')
  const block = at < 0 ? null : procedure.slice(at).match(/```\n([\s\S]*?)\n```/)
  if (block?.[1] === undefined) throw new Error(`${PROCEDURE_FILE} has no worker brief template ("Use this template:" and a fenced block); --local cannot brief workers.`)
  return block[1]
}

/** The procedure heading for a section number or title, verbatim, or an error naming what is missing. */
export function procedureHeading(procedure: string, section: number | string): string {
  const pattern = typeof section === 'number' ? new RegExp(`^## ${section}\\. .+$`, 'm') : new RegExp(`^## ${section}[ \\t]*$`, 'm')
  const heading = procedure.match(pattern)?.[0]
  if (heading === undefined) throw new Error(`${PROCEDURE_FILE} has no section ${typeof section === 'number' ? `"## ${section}."` : `"## ${section}"`}; --local maps its stages onto those sections.`)
  return heading
}

async function resolveSource(input: LocalInput): Promise<Source> {
  if (input.repo !== undefined && !existsSync(input.repo) && /^(https?:\/\/|git@|[\w.-]+\/[\w.-]+$)/.test(input.repo)) {
    throw new Error(`--local builds a local checkout; ${input.repo} is a GitHub repository. Drop --local to launch the implementor agent on it.`)
  }
  const raw = input.source.replace(/^@/, '')
  const path = resolve(raw)
  if (!existsSync(path)) {
    throw new Error(`${raw} is not a file or directory. For a ticket, fetch it and restate it as the procedure's "## 1." says, write it to <repo>/.work/<ticket>/spec.md, and pass that path.`)
  }
  const isDir = (await readdir(path).catch(() => null)) !== null
  const repo = resolve(input.repo ?? (await git(isDir ? path : dirname(path), 'rev-parse', '--show-toplevel')))
  const planDir = isDir ? path : basename(path) === 'plan.reviewed.md' ? dirname(path) : existsSync(join(dirname(path), 'plan.review/trace/review.json')) ? join(dirname(path), 'plan.review') : null
  if (planDir !== null) {
    const note = isDir || basename(path) === 'plan.reviewed.md' ? null : `A reviewed plan sits beside ${relative(repo, path)}; building ${relative(repo, planDir)} instead.`
    return { kind: 'plan', path: planDir, repo, workDir: resolve(input.work ?? planDir), planFile: join(planDir, 'trace/plan.json'), reviewFile: join(planDir, 'trace/review.json'), trailer: null, note }
  }
  // A spec inside the ticket's working folder (.work/<ticket>/spec.md) is built as a ticket:
  // the commit cites the ticket, by its Notion URL when ticket.md beside it names one.
  const ticket = path.match(/\/\.work\/([^/]+)\/spec\.md$/)
  if (ticket?.[1] !== undefined) {
    const workDir = resolve(input.work ?? dirname(path))
    const ticketUrl = (await readFile(join(dirname(path), 'ticket.md'), 'utf8').catch(() => '')).match(/https:\/\/(?:app\.|www\.)?notion\.(?:com|so)\/\S+/)?.[0] ?? null
    return { kind: 'ticket', path, repo, workDir, planFile: join(workDir, 'plan.json'), reviewFile: null, trailer: ticketUrl === null ? `Ticket: ${ticket[1]}` : `Spec: ${ticketUrl}`, note: null }
  }
  const workDir = resolve(input.work ?? join(dirname(path), 'implementation'))
  return { kind: 'spec', path, repo, workDir, planFile: join(workDir, 'plan.json'), reviewFile: null, trailer: `Spec: ${relative(repo, path)}`, note: null }
}

async function sourceFingerprint(source: Source): Promise<string> {
  const files = source.kind === 'plan' ? [source.planFile, source.reviewFile ?? ''] : [source.path]
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8').catch(() => '')))
  return sha256(JSON.stringify(texts))
}

async function defaultBranch(repo: string): Promise<string> {
  const origin = await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')
  if (origin !== '') return origin.replace(/^origin\//, '')
  const configured = await git(repo, 'config', 'init.defaultBranch').catch(() => '')
  return configured === '' ? 'main' : configured
}

/** The branch base: the merge base with the default branch, else HEAD when the run started. */
async function branchBase(repo: string, main: string, startCommit: string): Promise<string> {
  const base = await git(repo, 'merge-base', main, 'HEAD').catch(() => '')
  return base !== '' ? base : startCommit
}

/** The sections of the progress log the final verification must write, and the one that may not be empty. */
export const LOG_SECTIONS = ['## What it fixed', '## Dependencies added', '## Mid-build notes', '## Proposed Slop Repo entries'] as const
function sectionBody(log: string, heading: string): string | null {
  const at = log.indexOf(`\n${heading}`)
  if (at < 0 && !log.startsWith(heading)) return null
  const start = at < 0 ? heading.length : at + heading.length + 1
  const rest = log.slice(start)
  const next = rest.search(/\n##? /)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}

type NotesCheck = { file: string; findings: [string, Finding][] }
const describeFinding = ([token, finding]: [string, Finding]) => (finding.status === 'renamed' ? `\`${token}\` (renamed: \`${finding.to}\`)` : `\`${token}\` (no rename found; remove its sentence)`)

/** The stage input for the final verification: what the driver found for section 6, so the session copies instead of recalling. */
function verificationInput(args: { base: string; dependencies: DependencyReport; notes: NotesCheck[]; workDir: string; slopAreas: string[] }): string {
  const notes = args.notes.length === 0 ? [`No mid-build notes file under ${args.workDir}. Any the plan or you named elsewhere must still be rewritten or deleted and listed.`] : args.notes.map(({ file, findings }) => `- ${file}: ${findings.length === 0 ? 'every identifier is in the repository; rewrite it with the header, or delete it' : `not in the repository: ${findings.map(describeFinding).join(', ')}`}`)
  return [
    "The driver's findings for the Procedure's final verification, computed from the repository. Copy them; do not recompute them from memory.",
    '',
    `### Dependencies added (every manifest, ${args.base.slice(0, 12)}..HEAD)`,
    '',
    renderDependencies(args.dependencies).replace(/^## Dependencies added\n\n/, ''),
    '### Mid-build notes',
    '',
    ...notes,
    '',
    '### Slop Repo areas (the topic pages the Agent Instructions routing table names)',
    '',
    args.slopAreas.length === 0 ? 'None routed; use the Area names of the AI Agent Slop Repo.' : args.slopAreas.join(', '),
  ].join('\n')
}

/**
 * Loads the knowledge, once per run: the first call fetches the folder itself through the shared
 * walk (F49), or takes a verified --guidelines snapshot (F50); every later call of the run reads
 * the same folder and refuses one that changed mid-run. Throws KnowledgeBlocked when there is no
 * folder and no NOTION_TOKEN or KNOWLEDGE_PAGE to fetch with, and a KnowledgePrerequisiteError when
 * the folder lacks the index or a required page. A topic page the walk did not reach is listed in
 * the export, not required (F47).
 */
async function loadKnowledge(source: Source, runDir: string, state: State, input: LocalInput, deps: LocalDeps): Promise<Knowledge> {
  const dir = join(runDir, 'knowledge')
  if (state.knowledge !== null) {
    if ((await knowledgeFingerprint(dir)) !== state.knowledge.fingerprint) {
      throw new Error(`The knowledge folder ${dir} changed since this run started; the rules a run follows cannot change mid-run. Delete ${runDir} to start over.`)
    }
    return state.knowledge
  }
  const packageDir = deps.packageDir ?? PACKAGE_DIR
  const loaded = deps.env === undefined ? await agentEnv(packageDir) : { env: deps.env, from: ['injected env'] }
  const config = knowledgeConfig(loaded.env, loaded.from)
  if (input.guidelines !== undefined) {
    await verifyGuidelines(input.guidelines, config)
    await mkdir(dir, { recursive: true })
    const target = join(dir, REQUIRED_NAME)
    await copyFile(resolve(input.guidelines), target)
    const text = await readFile(target, 'utf8')
    const page: RecordedPage = { role: 'snapshot', title: basename(input.guidelines), url: null, file: REQUIRED_NAME, sha256: sha256(text) }
    return { source: 'guidelines', fingerprint: await knowledgeFingerprint(dir), fetchedAt: null, pages: [page], config: null }
  }
  // A folder already there (a resumed run, or one written before this run's own walk) is read as
  // it is; otherwise this run fetches it, with the token from the project's env, never the agent's.
  const already = (await readdir(dir).catch(() => [] as string[])).some((name) => name.endsWith('.md'))
  if (!already) {
    const found = await knowledgeToken(source.repo, deps.env ?? process.env)
    if (found.token === undefined || config.indexPage === null) {
      const missing = [found.token === undefined && `NOTION_TOKEN is not set in the environment or in ${found.files.join(' or ')}`, config.indexPage === null && 'KNOWLEDGE_PAGE is not set in the implementor\'s environment'].filter(Boolean).join('; ')
      throw new KnowledgeBlocked(`The Notion rules are required and cannot be loaded: ${missing}. Set it, or run ${LOAD_KNOWLEDGE} and give the run its REQUIRED.md.`)
    }
    const walk = await walkKnowledge({ token: found.token, page: config.indexPage, required: config.required, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.api ? { api: deps.api } : {}) })
    await writeKnowledgeFolder(dir, walk)
  }
  const found = await inspectKnowledge(dir, config)
  const missing = found.pages.filter((page) => !page.present && page.role !== 'topic')
  if (missing.length > 0) throw new KnowledgePrerequisiteError(`The Notion rules in ${dir} lack ${missing.map((page) => page.title ?? page.url ?? page.role).join(', ')}. Delete ${dir} so the next call loads it again from Notion.`)
  const fetchedAt = await requiredFetchedAt(dir, found.required, (deps.now ?? (() => new Date()))().toISOString())
  // The walk's own REQUIRED.md (with its provenance header) is kept as written; a folder without one gets it rendered as load-knowledge does.
  const existing = await readFile(join(dir, REQUIRED_NAME), 'utf8').catch(() => '')
  const requiredPath = hasProvenance(existing) ? join(dir, REQUIRED_NAME) : await writeRequired(dir, found.required, fetchedAt)
  const requiredPage: RecordedPage = { role: 'required', title: 'REQUIRED.md', url: null, file: REQUIRED_NAME, sha256: sha256(await readFile(requiredPath, 'utf8')) }
  return { source: 'notion', fingerprint: await knowledgeFingerprint(dir), fetchedAt, pages: [...found.recorded, requiredPage], config }
}

type AgentFiles = { procedure: string; instructions: string }

async function agentFiles(deps: LocalDeps): Promise<AgentFiles> {
  const packageDir = deps.packageDir ?? PACKAGE_DIR
  return {
    procedure: await readFile(join(packageDir, PROCEDURE_FILE), 'utf8'),
    instructions: await readFile(join(packageDir, INSTRUCTIONS_FILE), 'utf8'),
  }
}

const fence = (body: string, lang = '') => `\`\`\`${lang}\n${body}\n\`\`\``
const schemaText = (name: SchemaName) => fence(JSON.stringify(z.toJSONSchema(SCHEMAS[name], { io: 'input' }), null, 2), 'json')

async function knowledgeSection(dir: string): Promise<string> {
  const files = await knowledgeFiles(dir)
  const required = await readFile(join(dir, REQUIRED_NAME), 'utf8')
  return [
    `The Notion rules for this run are in ${dir} (the agent's /workspace/knowledge). Read ${REQUIRED_NAME} in full; use the index and topic files for what the work touches.`,
    '',
    ...files.map((file) => `- ${file.path}: ${file.title}`),
    '',
    `### ${REQUIRED_NAME}`,
    '',
    required.trim(),
  ].join('\n')
}

type OrchestratorStage = { id: string; stage: Stage; sections: (number | string)[]; does: string; input?: string; wave?: number }

function orchestratorPrompt(args: { task: OrchestratorStage; output: string; schema: SchemaName; files: AgentFiles; facts: unknown; knowledge: string; repo: string; knowledgeDir: string }): string {
  const { task, files } = args
  const headings = task.sections.map((section) => `"${procedureHeading(files.procedure, section)}"`).join(', ')
  return [
    `# Aspira implementor: ${task.id} (--local)`,
    '',
    'You are the implementor, running as this Claude Code session instead of the `implementor` eve agent. The Procedure and Agent instructions sections below are the agent\'s own files, read when this step ran. They are the authority. This header only maps the run onto this machine.',
    '',
    `- You are in the Procedure's "Claude Code session" column. The repository is ${args.repo} (the agent's /workspace/repo). The Notion rules are already loaded into ${args.knowledgeDir}; do not call load-knowledge, checkout-repo or publish-branch, and push nothing.`,
    `- ${RESEARCH_RULE} ${sessionResearchTools(args.repo)}`,
    `- This stage: ${headings} of the Procedure. ${task.does}`,
    `- Finish by writing ONE JSON object to \`${args.output}\` that validates against the output schema at the end, then run the \`local\` step again.`,
    '',
    '## Run facts',
    '',
    fence(JSON.stringify(args.facts, null, 2), 'json'),
    '',
    ...(task.input === undefined ? [] : ['## Stage input', '', task.input, '']),
    '## Knowledge',
    '',
    args.knowledge,
    '',
    `## Procedure (${PROCEDURE_FILE})`,
    '',
    files.procedure,
    '',
    `## Agent instructions (${INSTRUCTIONS_FILE})`,
    '',
    files.instructions,
    '',
    '## Output schema',
    '',
    schemaText(args.schema),
    '',
  ].join('\n')
}

function workerPrompt(args: { id: string; output: string; files: AgentFiles; values: string }): string {
  return [
    `# Aspira implementor: ${args.id} (--local worker)`,
    '',
    `You are one worker subagent of a Claude Code session that runs the implementor's procedure. The Brief below is the worker brief in the agent's own procedure (${PROCEDURE_FILE}, "${procedureHeading(args.files.procedure, 5)}"), read when this step ran. The Values section fills its placeholders. Follow the Brief.`,
    '',
    `Finish by writing ONE JSON object to \`${args.output}\` that validates against the output schema at the end: the Brief's report, as JSON. Then reply with one line.`,
    '',
    '## Brief',
    '',
    workerBriefTemplate(args.files.procedure),
    '',
    '## Values',
    '',
    args.values,
    '',
    '## Output schema',
    '',
    schemaText('WORKER_REPORT'),
    '',
  ].join('\n')
}

/** Project instruction files a worker reads: AGENTS.md and CLAUDE.md from the repo root down to each written directory, and constraints.md. */
function readInFull(repo: string, scope: string[], knowledge: { path: string }[]): string[] {
  const dirs = new Set<string>([''])
  for (const path of scope) {
    const parts = path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
  }
  const project = [...dirs].flatMap((dir) => ['AGENTS.md', 'CLAUDE.md'].map((name) => join(repo, dir, name))).filter((file) => existsSync(file))
  const constraints = join(repo, 'node_modules/@aspiralabs/config/agent/constraints.md')
  return [...project, ...(existsSync(constraints) ? [constraints] : []), ...knowledge.map((file) => file.path).filter((file) => basename(file) !== 'INDEX.md')]
}

/** One step of a --local build: the next model stage, or the finished run (blocked when the knowledge cannot be loaded). */
export async function runLocal(input: LocalInput, deps: LocalDeps = {}): Promise<LocalResult> {
  if (input.maxParallel !== undefined && (!Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 16)) throw new Error('--max-parallel must be a whole number from 1 to 16.')
  const source = await resolveSource(input)
  const runDir = join(source.workDir, RUN_DIR)
  const stateFile = join(runDir, 'state.json')
  const fingerprint = await sourceFingerprint(source)
  const saved = await readFile(stateFile, 'utf8').then(
    (text) => stateSchema.parse(JSON.parse(text)),
    () => null,
  )
  if (saved !== null && (saved.source !== source.path || saved.sourceFingerprint !== fingerprint)) {
    throw new Error(`${relative(source.repo, source.path)} changed since this local build started. Delete ${runDir} to start over.`)
  }
  for (const [flag, given, kept] of [['--max-parallel', input.maxParallel, saved?.maxParallel], ['--serial', input.serial === true ? true : undefined, saved?.serial === true ? true : undefined]] as const) {
    if (saved !== null && given !== undefined && given !== kept) throw new Error(`${flag} differs from the value this run started with. Drop it, or delete ${runDir} to start over.`)
  }
  const head = await git(source.repo, 'rev-parse', 'HEAD')
  const state: State = saved ?? { source: source.path, sourceFingerprint: fingerprint, maxParallel: input.maxParallel ?? 4, serial: input.serial === true, startedAt: new Date().toISOString(), startCommit: head, knowledge: null, gate: null, planAccepted: null, rejections: {} }
  await mkdir(join(runDir, 'outputs'), { recursive: true })
  const save = () => writeFile(stateFile, JSON.stringify(state, null, 2))

  let knowledge: Knowledge
  try {
    knowledge = await loadKnowledge(source, runDir, state, input, deps)
  } catch (error) {
    // No folder and nothing to fetch it with: a blocked run end (F52), not a pending stage for the session.
    if (error instanceof KnowledgeBlocked) return { pending: false, status: 'blocked', reason: error.message, reasonCode: null, workDir: source.workDir, export: null, missing: [] }
    throw error
  }
  state.knowledge = knowledge
  const knowledgeDir = join(runDir, 'knowledge')

  const done = (status: LocalDone['status'], extra: Partial<LocalDone> = {}): LocalDone => ({ pending: false, status, workDir: source.workDir, export: null, missing: [], ...extra })

  const missing: { id: string; reason: string }[] = []
  const calls: { id: string; stage: Stage; output: unknown }[] = []
  const outputFile = (id: string) => join(runDir, 'outputs', `${id}.json`)
  const promptFile = (id: string) => join(runDir, 'prompts', `${id}.md`)

  /** The trace every outcome writes, win or not, so a reader of the run's record (RUN_RECORDS) always finds status, reason and reasonCode there. */
  async function writeTrace(status: LocalDone['status'], extra: Partial<LocalDone>): Promise<string> {
    const traceDir = join(source.workDir, 'trace')
    await mkdir(traceDir, { recursive: true })
    const withPrompts = await Promise.all(calls.map(async (call) => ({ ...call, prompt: await readFile(promptFile(call.id), 'utf8').catch(() => null) })))
    const trace = {
      mode: 'local',
      source: { kind: source.kind, path: source.path },
      repository: source.repo,
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      status,
      reason: extra.reason ?? null,
      reasonCode: extra.reasonCode ?? null,
      ...(status === 'ready' ? { branch: extra.branch, apps: extra.apps, head: extra.head } : {}),
      knowledge: { ...state.knowledge, required: await readFile(join(knowledgeDir, REQUIRED_NAME), 'utf8') },
      gate: state.gate,
      rejections: state.rejections,
      missing,
      calls: withPrompts,
    }
    const path = join(traceDir, 'implementation-local.json')
    await writeFile(path, JSON.stringify(trace, null, 2))
    return path
  }

  /** A finished build: ready or incomplete. The trace is written, the run's own work directory is cleared, and, for a ready build, the assumptions are recorded as reversible decisions. */
  const exportRun = async (status: 'ready' | 'incomplete', extra: Partial<LocalDone> = {}): Promise<LocalDone> => {
    const path = await writeTrace(status, extra)
    // The assumptions as decisions the human can reverse: the taken option ticked, the others open.
    if (extra.verification !== undefined) await writeFile(join(source.workDir, 'trace/decisions.md'), renderAssumptions(extra.verification.assumptions, extra.verification.status))
    await rm(runDir, { recursive: true, force: true })
    return done(status, { export: path, missing, ...extra })
  }

  /** The gate refuses or blocks before any stage runs: the trace is written (so the run's record always exists), but the run directory (and its cached knowledge) is kept, so a rerun after the human fixes it need not re-fetch Notion. */
  const refuse = async (status: 'refused' | 'blocked', extra: Partial<LocalDone> = {}): Promise<LocalDone> => {
    await writeTrace(status, extra)
    return done(status, { missing, ...extra })
  }

  // The gate, for a reviewed plan: once, before anything is written.
  if (source.kind === 'plan' && state.gate === null) {
    const review = await readFile(source.reviewFile ?? '', 'utf8').then(
      (text) => z.looseObject({ status: z.string(), problems: z.array(z.unknown()).default([]), decisions: z.array(z.unknown()).default([]), repoCommit: z.string().optional(), recoveredFrom: z.string().optional() }).parse(JSON.parse(text)),
      () => null,
    )
    if (review === null || !['ready', 'needs-author'].includes(review.status)) {
      return refuse('refused', {
        reason: review === null ? `No readable trace/review.json in ${source.path}. Run the planner again (/aspira-planner) to produce a ready review.` : `The reviewed plan's status is ${review.status}. Run the planner again (/aspira-planner) to produce a ready review.`,
        reasonCode: null,
        problems: (review?.problems ?? []).map(String),
      })
    }
    // A review.json rebuilt from the Plan page's fenced block (F36) was not produced by this
    // machine's own planner run: it needs a stronger check than an ordinary reviewed plan before the
    // gate trusts it. The ticket's live Status (not whatever an attacker's recovered copy claims)
    // must still be "Ready: Plan", and the recorded repoCommit must still be in this branch's history.
    if (review.recoveredFrom !== undefined) {
      const ticket = await readFile(join(dirname(source.workDir), TICKET_FILE), 'utf8').then(parseTicketMd, () => null)
      if (ticket === null || ticket.status !== 'Ready: Plan') {
        return refuse('refused', {
          reason: `This plan was recovered from Notion (${review.recoveredFrom}); recovery only runs while the ticket is "Ready: Plan". ${TICKET_FILE} shows "${ticket?.status ?? 'an unreadable Status'}".`,
          reasonCode: null,
          problems: [],
        })
      }
      if (review.repoCommit === undefined || !(await isAncestor(source.repo, review.repoCommit, head))) {
        return refuse('refused', {
          reason: `This plan was recovered from Notion (${review.recoveredFrom}); its repoCommit (${review.repoCommit ?? 'missing'}) is not an ancestor of HEAD (${head}), so it no longer matches this branch's history. Run the planner again (/aspira-planner).`,
          reasonCode: null,
          problems: [],
        })
      }
    }
    if (review.repoCommit !== undefined && review.repoCommit !== head) {
      const plan = planOf(await readFile(source.planFile, 'utf8'))
      const drift = plan === null ? [`${source.planFile} is not a readable plan.`] : targetProblems(plan, (path) => existsSync(join(source.repo, path)))
      if (drift.length > 0) {
        return refuse('refused', { reason: `The plan was made at ${review.repoCommit} and HEAD is ${head}; its targets no longer match. Run the planner again (/aspira-planner).`, reasonCode: 'plan-drift', problems: drift })
      }
    }
    state.gate = { status: review.status, repoCommit: review.repoCommit ?? null, head, decisions: review.decisions, recoveredFrom: review.recoveredFrom ?? null }
  }

  const files = await agentFiles(deps)
  const knowledgeText = await knowledgeSection(knowledgeDir)
  const knowledgeList = await knowledgeFiles(knowledgeDir)
  const finish = input.finish === true
  await mkdir(join(runDir, 'prompts'), { recursive: true })

  /** Reads and checks one output; a bad one is set aside for one resend. */
  async function resolveTask<T>(id: string, stage: Stage, output: string, check: (value: T) => string[] | Promise<string[]>, parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string }): Promise<{ value: T } | { error?: string; retry?: boolean } | { missing: true }> {
    const text = await readFile(output, 'utf8').catch(() => null)
    let error: string | undefined
    if (text !== null) {
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (cause) {
        error = `The output is not valid JSON: ${message(cause)}`
      }
      if (error === undefined) {
        const parsed = parse(raw)
        if (parsed.ok) {
          const problems = await check(parsed.value)
          if (problems.length === 0) {
            calls.push({ id, stage, output: parsed.value })
            return { value: parsed.value }
          }
          error = problems.join('\n')
        } else error = parsed.error
      }
    }
    if (finish) {
      missing.push({ id, reason: error === undefined ? 'no output was produced in the session' : `invalid output: ${error}` })
      return { missing: true }
    }
    if (error === undefined) return {}
    const rejected = [...(state.rejections[id] ?? []), error]
    state.rejections[id] = rejected
    await rename(output, join(runDir, 'outputs', `${id}.rejected-${rejected.length}.json`))
    return { error, retry: rejected.length < 2 }
  }
  const parser =
    <T>(schema: z.ZodType<T>) =>
    (raw: unknown): { ok: true; value: T } | { ok: false; error: string } => {
      const parsed = schema.safeParse(raw)
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: z.prettifyError(parsed.error).slice(0, 2000) }
    }

  const facts = (extra: Record<string, unknown> = {}) => ({
    source: { kind: source.kind, path: source.path, ...(source.note === null ? {} : { note: source.note }) },
    repository: source.repo,
    workDir: source.workDir,
    plan: source.planFile,
    commitTrailer: source.trailer ?? 'from the plan header, as the Procedure says',
    maxParallel: state.maxParallel,
    serial: state.serial,
    ...(state.gate === null ? {} : { gate: state.gate }),
    ...extra,
  })
  const first: (number | string)[] = files.procedure.includes('\n## Run to completion') ? ['Run to completion', 1, 2] : [1, 2]

  async function orchestrator(task: OrchestratorStage, schema: SchemaName, output: string, outcome: { error?: string; retry?: boolean }, extraFacts: Record<string, unknown> = {}): Promise<LocalPending> {
    const prompt = promptFile(task.id)
    await writeFile(prompt, orchestratorPrompt({ task, output, schema, files, facts: facts(extraFacts), knowledge: knowledgeText, repo: source.repo, knowledgeDir }))
    await save()
    return { pending: true, status: 'pending', stage: task.stage, ...(task.wave === undefined ? {} : { wave: task.wave }), workDir: source.workDir, runDir, parallel: false, tasks: [{ id: task.id, agent: 'orchestrator', prompt, output, schema, ...taskModel('implementor.orchestrator', 'opus' as SessionModel, source.repo), ...outcome }] }
  }

  // The plan: the reviewed one, or the one the session drafts from the spec.
  let plan: Plan
  if (source.kind === 'plan') {
    const parsed = planOf(await readFile(source.planFile, 'utf8'))
    if (parsed === null) throw new Error(`${source.planFile} is not a plan the procedure can build.`)
    plan = parsed
  } else {
    const result = await resolveTask('plan', 'plan', source.planFile, async (value: Plan) => {
      const problems = planProblems(value)
      const text = await readFile(source.planFile, 'utf8')
      if (problems.length === 0 && state.planAccepted !== sha256(text)) problems.push(...targetProblems(value, (path) => existsSync(join(source.repo, path))))
      if (problems.length === 0) state.planAccepted = sha256(text)
      return problems
    }, parser(SCHEMAS.PLAN))
    if ('missing' in result) return exportRun('incomplete')
    if (!('value' in result)) {
      await mkdir(source.workDir, { recursive: true })
      return orchestrator({ id: 'plan', stage: 'plan', sections: [...first, 3], does: `Draft plan.json and plan.md in ${source.workDir}. The output file is that plan.json.` }, 'PLAN', source.planFile, result)
    }
    plan = result.value
  }

  // The parallelization: the session's waves and lanes, checked for coherence.
  const baseline = baselineWaves(plan) ?? []
  const parOutput = outputFile('parallelize')
  const par = await resolveTask('parallelize', 'parallelize', parOutput, (value: Parallelization) => parallelizationProblems(plan, value, { serial: state.serial }), parser(SCHEMAS.PARALLELIZATION))
  if ('missing' in par) return exportRun('incomplete')
  if (!('value' in par)) {
    const sections = source.kind === 'plan' ? [...first, 4] : [4]
    const input = ['The dependency levels from `dependsOn` and overlapping write sets alone, with each task\'s write set. A starting point, not the answer:', '', fence(JSON.stringify(baseline.map((ids, i) => ({ wave: i + 1, tasks: plan.tasks.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, writes: writeSet(t, plan) })) })), null, 2), 'json')].join('\n')
    return orchestrator({ id: 'parallelize', stage: 'parallelize', sections, does: 'Decide the waves and lanes, and for every lane whether a worker builds it, its write scope and the rules its brief carries. Print the parallelization as the Procedure says, then record it in the output.', input }, 'PARALLELIZATION', parOutput, par)
  }

  // The checked-out branch: the board-stage gate (the driver's beforeClaim) already refused a
  // wrong branch before the ticket was claimed, so this is the ticket branch (or, for a run with
  // no ticket, whatever the human switched to). A build never lands on the default branch or a
  // detached HEAD: that is refused as a run status before any build stage, not thrown (F22).
  const branch = await git(source.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
  const main = await defaultBranch(source.repo)
  if (branch === main || branch === 'HEAD') {
    return refuse('refused', { reason: `${source.repo} is on ${branch === 'HEAD' ? 'a detached HEAD' : `the default branch ${main}`}. The procedure's "${procedureHeading(files.procedure, 1)}" builds on a dedicated branch: run \`git switch -c <branch>\`, then run local again.` })
  }

  const tasksById = new Map(plan.tasks.map((t) => [t.id, t]))
  const rawPlan = z.object({ tasks: z.array(z.looseObject({ id: z.string() })), tests: z.array(z.looseObject({ id: z.string() })).default([]) }).parse(JSON.parse(await readFile(source.planFile, 'utf8')))
  const rawTask = (id: string) => rawPlan.tasks.find((t) => t.id === id)
  const rawTest = (id: string) => rawPlan.tests.find((t) => t.id === id)

  for (const [index, wave] of par.value.waves.entries()) {
    const number = index + 1
    const reports: string[] = []
    const pendingTasks: LocalTask[] = []
    for (const lane of wave.lanes.filter((l: Lane) => l.worker)) {
      const id = `wave-${number}-${lane.id}`
      const output = outputFile(id)
      reports.push(output)
      const result = await resolveTask(id, 'wave', output, (value: z.infer<typeof SCHEMAS.WORKER_REPORT>) => {
        const named = value.tasks.map((t) => t.id).sort().join(',')
        return named === [...lane.tasks].sort().join(',') ? [] : [`The report must cover exactly this lane's tasks (${lane.tasks.join(', ')}); it covers ${named || 'none'}.`]
      }, parser(SCHEMAS.WORKER_REPORT))
      if ('missing' in result || 'value' in result) continue
      if (pendingTasks.length >= state.maxParallel) continue
      const testIds = [...new Set(lane.tasks.flatMap((t) => tasksById.get(t)?.testIds ?? []))]
      const values = [
        `- Repository: ${source.repo}`,
        `- Plan: ${source.planFile}; spec or ticket: ${source.kind === 'plan' ? 'the Source spec in the plan header' : source.path}`,
        '- Your tasks, in order:',
        '',
        fence(JSON.stringify(lane.tasks.map(rawTask), null, 2), 'json'),
        '',
        '- Their test cases:',
        '',
        fence(JSON.stringify(testIds.map(rawTest), null, 2), 'json'),
        '',
        `- Read these in full before writing code: ${readInFull(source.repo, lane.writeScope, knowledgeList).join(', ')}`,
        `- Rules that apply here: ${lane.rules.length === 0 ? '(none selected beyond the files above)' : ''}`,
        ...lane.rules.map((rule) => `  - ${rule}`),
        `- UI: ${lane.ui === '' ? 'none' : lane.ui}`,
        '- WRITE SCOPE (the only files you may create or modify):',
        ...lane.writeScope.map((path) => `  - ${path}`),
      ].join('\n')
      const prompt = promptFile(id)
      await writeFile(prompt, workerPrompt({ id, output, files, values }))
      pendingTasks.push({ id, agent: 'worker', prompt, output, schema: 'WORKER_REPORT', ...taskModel('implementor.worker', 'sonnet' as SessionModel, source.repo), ...('error' in result && result.error !== undefined ? { error: result.error, retry: result.retry } : {}) })
    }
    if (missing.length > 0) return exportRun('incomplete')
    if (pendingTasks.length > 0) {
      await save()
      return { pending: true, status: 'pending', stage: 'wave', wave: number, workDir: source.workDir, runDir, parallel: pendingTasks.length > 1, tasks: pendingTasks }
    }

    const waveTasks = wave.lanes.flatMap((l: Lane) => l.tasks)
    const id = `wave-${number}`
    const output = outputFile(id)
    const result = await resolveTask(id, 'wave-commit', output, async (value: z.infer<typeof SCHEMAS.WAVE_RESULT>) => {
      const problems: string[] = []
      const named = value.tasks.map((t) => t.id).sort().join(',')
      if (named !== [...waveTasks].sort().join(',')) problems.push(`The wave record must list exactly this wave's tasks (${waveTasks.join(', ')}); it lists ${named || 'none'}.`)
      if (value.status === 'committed' && value.commit === null) problems.push('A committed wave names its commit.')
      if (value.commit !== null && !(await git(source.repo, 'cat-file', '-e', `${value.commit}^{commit}`).then(() => true, () => false))) problems.push(`The commit ${value.commit} is not in ${source.repo}.`)
      return problems
    }, parser(SCHEMAS.WAVE_RESULT))
    if ('missing' in result) return exportRun('incomplete')
    if (!('value' in result)) {
      const own = wave.lanes.filter((l: Lane) => !l.worker)
      const does = [
        reports.length === 0 ? 'No worker ran in this wave.' : `The workers' reports are in ${reports.join(', ')}.`,
        own.length === 0 ? '' : `Lanes ${own.map((l: Lane) => `${l.id} (${l.tasks.join(', ')})`).join(', ')} have no worker: build them yourself now.`,
        'Then verify, commit and log the wave as the Procedure says, and record it in the output.',
      ].filter((line) => line !== '').join(' ')
      return orchestrator({ id, stage: 'wave-commit', sections: [5], does, wave: number }, 'WAVE_RESULT', output, result, { wave: number, lanes: wave.lanes })
    }
  }

  const features = [...new Set([...plan.tasks.flatMap((t) => t.featureIds), ...plan.tests.flatMap((t) => t.featureIds)])]
  const verifyOutput = outputFile('verification')
  // What the final verification must write down, found by the driver: the manifest diff since the
  // branch base, the notes files and their stale identifiers, and the areas an entry may name.
  const base = await branchBase(source.repo, main, state.startCommit === '' ? head : state.startCommit)
  const dependencies = await dependenciesAdded({ repo: source.repo, base, knowledgeDir })
  const searcher = repoSearcher(source.repo)
  const notesFiles = await notesFilesIn(source.workDir, { exclude: [RUN_DIR] })
  const notes: NotesCheck[] = []
  for (const file of notesFiles) notes.push({ file, findings: [...(await checkNotes(await readFile(file, 'utf8'), searcher))].filter(([, f]) => f.status !== 'found') })
  const slopAreas = state.knowledge.pages.filter((p) => p.role === 'topic').map((p) => p.title)
  const logFile = join(source.workDir, 'implementation.md')
  const notesPath = (file: string) => (file.startsWith('/') ? file : existsSync(resolve(source.workDir, file)) ? resolve(source.workDir, file) : resolve(source.repo, file))
  const verification = await resolveTask('verification', 'verification', verifyOutput, async (value: z.infer<typeof SCHEMAS.VERIFICATION>) => {
    const problems: string[] = []
    const log = await readFile(logFile, 'utf8').catch(() => null)
    if (log === null) problems.push(`The progress log ${logFile} does not exist.`)
    else {
      for (const heading of LOG_SECTIONS) {
        const body = sectionBody(log, heading)
        if (body === null) problems.push(`${logFile} has no \`${heading}\` section.`)
        else if (body === '' && heading === '## Proposed Slop Repo entries') problems.push(`${logFile}: \`${heading}\` is empty; it lists entries or says None with the reason.`)
        else if (body === '' && heading === '## What it fixed') problems.push(`${logFile}: \`${heading}\` is empty; it is the plain-English summary the PR description and the release page carry (section 6, step 7).`)
      }
    }
    const listed = new Set(value.features.map((f) => f.id))
    const absent = features.filter((f) => !listed.has(f))
    if (absent.length > 0) problems.push(`The feature table leaves out ${absent.join(', ')}.`)
    for (const dep of dependencies.added) {
      if (!value.dependenciesAdded.some((d) => d.name === dep.name && (d.app === dep.app || (dep.app === 'root' && d.app === '.')))) problems.push(`dependenciesAdded leaves out \`${dep.name}\` ${dep.version}, added in ${dep.manifest}.`)
    }
    const covered = new Set(value.notesRewritten.map((n) => notesPath(n.file)))
    for (const file of notesFiles) if (!covered.has(file)) problems.push(`${file} is a mid-build notes file; notesRewritten must say whether it was rewritten or deleted.`)
    for (const entry of value.notesRewritten) {
      const file = notesPath(entry.file)
      const text = await readFile(file, 'utf8').catch(() => null)
      if (entry.action === 'deleted') {
        if (text !== null) problems.push(`${file} is listed as deleted but still exists.`)
        continue
      }
      if (text === null) {
        problems.push(`${file} is listed as rewritten but does not exist.`)
        continue
      }
      const sha = notesHeaderSha(text)
      if (sha === null || !(await git(source.repo, 'cat-file', '-e', `${sha}^{commit}`).then(() => true, () => false))) problems.push(`${file} does not start with the rewritten-at-verification header carrying a commit SHA of this repository.`)
      const stale = await staleIdentifiers(text, searcher)
      if (stale.length > 0) problems.push(`${file} still names ${stale.map((t) => `\`${t}\``).join(', ')}, which ${stale.length === 1 ? 'is' : 'are'} not in the repository; correct or remove ${stale.length === 1 ? 'it' : 'them'}.`)
    }
    if (slopAreas.length > 0) {
      const known = new Set(slopAreas.map((a) => a.toLowerCase()))
      for (const entry of value.slopEntries) if (!known.has(entry.area.trim().toLowerCase())) problems.push(`Slop Repo entry "${entry.rule}" names the area ${entry.area}, which is none of: ${slopAreas.join(', ')}.`)
    }
    return problems
  }, parser(SCHEMAS.VERIFICATION))
  if ('missing' in verification) return exportRun('incomplete')
  if (!('value' in verification)) {
    const does = `Write the progress log at ${logFile} with its ${LOG_SECTIONS.map((h) => `\`${h}\``).join(', ')} sections, and record the feature table, the dependencies added, each notes file as rewritten or deleted, and the proposed Slop Repo entries (or the justification) in the output.`
    const input = verificationInput({ base, dependencies, notes, workDir: source.workDir, slopAreas })
    return orchestrator({ id: 'verification', stage: 'verification', sections: [6, 7], does, input }, 'VERIFICATION', verifyOutput, verification, { features, branchBase: base, notesFiles, slopAreas })
  }
  // The app directories this build touched, from the plan's own repoCommit (the gate's base), so
  // the progress note can offer Step 7 (static analysis) per app without recomputing the diff.
  const appsBase = state.gate?.repoCommit ?? (state.startCommit === '' ? head : state.startCommit)
  const apps = await changedApps(source.repo, appsBase)
  return exportRun('ready', { verification: verification.value, branch, apps, head })
}

function planOf(text: string): Plan | null {
  try {
    const parsed = SCHEMAS.PLAN.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
