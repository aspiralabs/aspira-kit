// --local: the pr-debator loop with a Claude Code session as every seat. Each call makes no
// model call. It replays the loop from the start over the outputs already in the work
// directory: a turn whose output validates is fed back in, and the first stage with a
// turn missing (or invalid) is returned as tasks, each with its exact agent prompt written
// to a file. The session runs those as subagents and calls again. Once every stage is done
// the review is exported in the agent's layout and, for a GitHub PR, posted.

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDEX_FILE, KNOWLEDGE_ENV, KNOWLEDGE_PATH, MAX_DEPTH, MAX_PAGES, REQUIRED_ENV, REQUIRED_FILE, parseRequired } from '@aspiralabs/agent-common/lib/knowledge'
import { z } from 'zod'
import { countsFromFindings, reviewCommentBody, upsertReviewComment, type GithubPr } from './github-comment.ts'
import {
  cloneHead,
  defaultGithubToken,
  extractCommit,
  fetchPrDiff,
  fetchPrMeta,
  localDiff,
  localMeta,
  resolveLocalBranch,
  type Fetch,
  type RawDiff,
} from './local-source.ts'
import { REVIEW_DIR, ignoreRule, needsIgnoreRule, parsePrSource, patchStats, renderPrMeta, splitChanged, truncatePatch, type PrMeta } from './pr.ts'
import {
  DEFAULT_MAX_ROUNDS,
  DISPLAY_NAME,
  MAX_ROUNDS_LIMIT,
  OUTPUT_SCHEMAS,
  OUTPUT_VALIDATORS,
  SANDBOX_PATHS,
  SEATS,
  checkFindingsPrompt,
  normalizeCounts,
  openingPrompt,
  rehome,
  reviewDocPrompt,
  roundFilesInOrder,
  slugify,
  totalFindings,
  turnPrompt,
  verdictFrom,
  verifyPrompt,
  workspacePaths,
  writeFindingsPrompt,
  writeReviewPrompt,
  type Counts,
  type OutputKind,
  type PrContext,
  type Reviewer,
  type TurnOutput,
  type Verdict,
  type VerifyOutput,
} from './review.ts'

// ---------------------------------------------------------------------------------------------
// The loop, pure: what pr-debator does, over outputs that already exist.

/** Where a review is: six seats in parallel, Quinn's ruling, the two documents, the two checks. */
export type Stage = 'seats' | 'verifier' | 'documents' | 'checks'

/** One turn the session has to run: who, with which prompt, returning which result. */
export type PlanTask = { id: string; agent: Reviewer; kind: OutputKind; stage: Stage; round: number; prompt: string; error?: string }

/** One turn as it went, for trace/calls.json. */
export type PlanCall = { id: string; agent: Reviewer; stage: Stage; round: number; prompt: string; output?: unknown; error?: string }

/** The stage the session runs next. */
export type PendingPlan = { done: false; stage: Stage; round: number; tasks: PlanTask[] }

/** Every stage has run (or, with finish, is recorded as missing): what pr-debator returns. */
export type DonePlan = {
  done: true
  agreed: boolean
  rounds: number
  /** Quinn's sign-off counts, else Nova's; null when neither exists. */
  counts: Counts | null
  /** Computed from the counts; null when there are none, so a missing fix list is never an approve. */
  verdict: Verdict | null
  openPoints: string[]
  rejected: string[]
  duplicates: string[]
  /** Turns that never produced a valid output (only with finish). */
  missing: { id: string; reason: string }[]
  calls: PlanCall[]
}

/** The inputs to one replay of the loop. */
export type PlanInput = {
  pr: PrContext
  maxRounds: number
  /** Record missing turns instead of asking for them. */
  finish: boolean
  /** The raw output of a turn, or undefined when it has none yet. */
  outputs: (id: string) => unknown
  /** A reason a turn's output is unusable before validation (it was not JSON). */
  invalid?: (id: string) => string | undefined
}

const NO_TURN: TurnOutput = { agreed: false, openPoints: [], note: '' }
const NO_VERIFY: VerifyOutput = { agreed: false, openPoints: [], rejected: [], duplicates: [], note: '' }

/** Replay pr-debator over the outputs that exist and say what runs next, or what it returned. */
export function planStep(input: PlanInput): PendingPlan | DonePlan {
  const { pr, maxRounds, finish } = input
  const calls: PlanCall[] = []
  const missing: { id: string; reason: string }[] = []

  const resolveTurn = <T>(task: Omit<PlanTask, 'error'>, validator: z.ZodType<T>): { value?: T; task?: PlanTask } => {
    const call = { id: task.id, agent: task.agent, stage: task.stage, round: task.round, prompt: task.prompt }
    let error = input.invalid?.(task.id)
    const raw = input.outputs(task.id)
    if (error === undefined && raw !== undefined) {
      const parsed = validator.safeParse(raw)
      if (parsed.success) {
        calls.push({ ...call, output: parsed.data })
        return { value: parsed.data }
      }
      error = z.prettifyError(parsed.error).slice(0, 2000)
    }
    if (finish) {
      const reason = error === undefined ? 'no output was produced in the session' : `invalid output: ${error}`
      calls.push({ ...call, error: reason })
      missing.push({ id: task.id, reason })
      return {}
    }
    return { task: { ...task, ...(error === undefined ? {} : { error }) } }
  }
  const pendingOf = (results: { task?: PlanTask }[]) => results.flatMap((r) => (r.task === undefined ? [] : [r.task]))

  let round = 0
  let seats: TurnOutput[] = SEATS.map(() => NO_TURN)
  let quinn: VerifyOutput = NO_VERIFY

  while (round < maxRounds) {
    round += 1
    const turns = SEATS.map((seat) =>
      resolveTurn(
        { id: `round-${round}-${seat}`, agent: seat, kind: 'turn', stage: 'seats', round, prompt: round === 1 ? openingPrompt(seat, pr) : turnPrompt(seat, round, pr) },
        OUTPUT_VALIDATORS.turn,
      ),
    )
    const seatTasks = pendingOf(turns)
    if (seatTasks.length > 0) return { done: false, stage: 'seats', round, tasks: seatTasks }
    seats = turns.map((turn) => turn.value ?? NO_TURN)

    const ruling = resolveTurn({ id: `round-${round}-quinn`, agent: 'quinn', kind: 'verify', stage: 'verifier', round, prompt: verifyPrompt(round, pr) }, OUTPUT_VALIDATORS.verify)
    if (ruling.task !== undefined) return { done: false, stage: 'verifier', round, tasks: [ruling.task] }
    quinn = ruling.value ?? NO_VERIFY

    // Only with finish: a round with a turn missing is the last one. A round where nothing ran never happened.
    if (turns.some((turn) => turn.value === undefined) || ruling.value === undefined) {
      if (turns.every((turn) => turn.value === undefined) && ruling.value === undefined) round -= 1
      break
    }
    if (seats.every((seat) => seat.agreed) && quinn.agreed) break
  }

  const agreed = seats.every((seat) => seat.agreed) && quinn.agreed
  const last = Math.max(round, 1)
  const findingsDoc = resolveTurn({ id: 'findings', agent: 'nova', kind: 'findings', stage: 'documents', round: last, prompt: writeFindingsPrompt(pr, agreed) }, OUTPUT_VALIDATORS.findings)
  const reviewDoc = resolveTurn({ id: 'review', agent: 'dex', kind: 'doc', stage: 'documents', round: last, prompt: writeReviewPrompt(pr, agreed) }, OUTPUT_VALIDATORS.doc)
  const docTasks = pendingOf([findingsDoc, reviewDoc])
  if (docTasks.length > 0) return { done: false, stage: 'documents', round: last, tasks: docTasks }

  // Quinn signs off the fix list, Nova checks the summary. Quinn's counts win.
  const reviewPath = (pr.paths ?? SANDBOX_PATHS).files.review
  const findingsCheck = resolveTurn({ id: 'check-findings', agent: 'quinn', kind: 'findings', stage: 'checks', round: last, prompt: checkFindingsPrompt(pr) }, OUTPUT_VALIDATORS.findings)
  const reviewCheck = resolveTurn({ id: 'check-review', agent: 'nova', kind: 'doc', stage: 'checks', round: last, prompt: reviewDocPrompt('nova', reviewPath, pr) }, OUTPUT_VALIDATORS.doc)
  const checkTasks = pendingOf([findingsCheck, reviewCheck])
  if (checkTasks.length > 0) return { done: false, stage: 'checks', round: last, tasks: checkTasks }

  const raw = findingsCheck.value?.counts ?? findingsDoc.value?.counts
  const counts = raw === undefined ? null : normalizeCounts(raw)
  return {
    done: true,
    agreed,
    rounds: round,
    counts,
    verdict: counts === null ? null : verdictFrom(counts),
    openPoints: agreed ? [] : [...new Set([...seats.flatMap((seat) => seat.openPoints), ...quinn.openPoints])],
    rejected: quinn.rejected,
    duplicates: quinn.duplicates,
    missing,
    calls,
  }
}

// ---------------------------------------------------------------------------------------------
// The step driver: files in, files out.

/** What one `local` call is asked to do. */
export type LocalInput = {
  /** A GitHub PR (URL or owner/name#N) or a local repository path. */
  source: string
  /** Local only: the branch to review. Default: the checked-out branch. */
  branch?: string
  /** Local only: what to compare against. Default: main, then load-pr's fallbacks. */
  base?: string
  /** Round cap. Default DEFAULT_MAX_ROUNDS; fixed by the first call of a run. */
  maxRounds?: number
  /** Export directory. Default: <repo>/.pr-review/<branch>/ or reviews/<date>-<slug>/ in this package. */
  output?: string
  /** Do not post the review to the PR. */
  noComment?: boolean
  /** Export what exists now, with the missing turns recorded. */
  finish?: boolean
  /** The engineering guidelines folder. Default: <work>/knowledge, where load-knowledge's /workspace/knowledge maps. */
  knowledge?: string
}

/** Seams for tests: GitHub, the token, the clone remote, where reviews/ lives and where the agent's sources are. */
export type LocalDeps = {
  fetch?: Fetch
  githubToken?: () => Promise<string | undefined>
  cloneUrl?: (owner: string, name: string) => string
  packageDir?: string
  /** The pr-reviewer package whose agent/ files and env files are read. Default: this package. */
  agentDir?: string
  /** The process environment, for the knowledge configuration. Default: process.env. */
  env?: Record<string, string | undefined>
  now?: () => Date
}

/** A task as printed for the session: the prompt and output are file paths. */
export type LocalTask = { id: string; agent: Reviewer; prompt: string; output: string; schema: string; error?: string; retry?: boolean }

/** The comment outcome, as comment-on-pr reports it. */
export type CommentResult = { posted: true; action: 'created' | 'updated'; url: string } | { posted: false; reason: string }

/** A stage for the session to run. */
export type LocalPending = {
  pending: true
  status: 'pending'
  stage: Stage
  round: number
  maxRounds: number
  workDir: string
  /** The agent's orchestrator instructions, which the session follows as the orchestrator. */
  orchestrator: string
  tasks: LocalTask[]
}

/** The exported review. */
export type LocalDone = {
  pending: false
  status: 'complete' | 'incomplete'
  label: string
  branch: string
  verdict: Verdict | null
  counts: Counts | null
  findings: number | null
  agreed: boolean
  rounds: number
  maxRounds: number
  openPoints: string[]
  rejected: string[]
  duplicates: string[]
  missing: { id: string; reason: string }[]
  missingFiles: string[]
  dir: string
  written: string[]
  gitignore: { path: string; added: boolean; error?: string } | null
  /** Null for a local repository: there is no PR to post to. */
  comment: CommentResult | null
  /** agent/instructions.md as it is now: the session reports the review by it. */
  orchestrator: { path: string; text: string }
}

/** Either the next stage or the finished review. */
export type LocalResult = LocalPending | LocalDone

/** The work directory beside an export directory. */
export const workDirFor = (outputDir: string) => `${outputDir}.local`

const SCHEMA_NAMES: Record<OutputKind, string> = {
  turn: 'TURN_OUTPUT_SCHEMA',
  verify: 'VERIFY_OUTPUT_SCHEMA',
  doc: 'DOC_OUTPUT_SCHEMA',
  findings: 'FINDINGS_OUTPUT_SCHEMA',
}

/**
 * Local only: the turns that leave a document behind, which file, and the kind of output they
 * return. A session can refuse a helper's write of a report file, so these turns may hand the
 * document back as `document` in their output instead. The driver writes it once, in this order.
 */
const DOCUMENT_TURNS = [
  { id: 'findings', file: 'findings', kind: 'findings' },
  { id: 'review', file: 'review', kind: 'doc' },
  { id: 'check-findings', file: 'findings', kind: 'findings' },
  { id: 'check-review', file: 'review', kind: 'doc' },
] as const

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type State = {
  fingerprint: string
  /** The guidelines folder the run started with, and a hash of its files. */
  knowledge: { path: string; fingerprint: string }
  label: string
  maxRounds: number
  startedAt: string
  /** Each turn's rejected outputs, oldest first. */
  rejections: Record<string, string[]>
  /** The document turns whose handed-back document the driver has written. */
  documents: string[]
}

const stateSchema: z.ZodType<State> = z.object({
  fingerprint: z.string(),
  knowledge: z.object({ path: z.string(), fingerprint: z.string() }),
  label: z.string(),
  maxRounds: z.number(),
  startedAt: z.string(),
  rejections: z.record(z.string(), z.array(z.string())),
  documents: z.array(z.string()).default([]),
})

type Loaded = {
  meta: PrMeta
  diff: RawDiff
  outputDir: string
  repoPath: string | null
  /** Writes the tree the seats read into the work directory, on the first call. */
  materialize: () => Promise<void>
  github: GithubPr | null
  repoDir: string | null
}

/** The agent's own instruction files, read from disk on every call so the skill never carries a copy. */
export const agentSources = (agentDir: string) => ({
  orchestrator: join(agentDir, 'agent', 'instructions.md'),
  seat: (who: Reviewer) => join(agentDir, 'agent', 'subagents', who, 'instructions.md'),
})

/**
 * The file a subagent reads. Everything the seat is told comes from the agent: System is its
 * instructions.md and Task is review.ts's prompt, both verbatim, and the schema is review.ts's.
 * The only text added here is how a session runs a turn instead of eve: real paths, and
 * where to write the structured result.
 */
export function renderTaskPrompt(task: PlanTask, output: string, system: { path: string; text: string }, document?: string): string {
  const handBack =
    document === undefined
      ? []
      : [
          `- Do not write \`${document}\` yourself: a session can refuse a helper's write of a report file. Put the complete text the Task would leave in that file into the JSON result as one extra string field, \`document\`, and keep \`path\` as that file's path. Leave \`document\` out when you change nothing. The driver writes the file.`,
        ]
  return [
    `# pr-reviewer --local: ${task.id}`,
    '',
    `System below is ${system.path} and Task is the prompt agent/lib/review.ts builds for this turn: exactly what the agent sends ${DISPLAY_NAME[task.agent]}.`,
    '',
    '- This turn runs as a subagent of a Claude Code session, not in the agent\'s sandbox, so every path in the Task is a real path on this machine. read_file is the Read tool, and the shell commands the Task names run through Bash.',
    `- The structured result the Task asks for goes into \`${output}\` as ONE JSON object valid against the output schema at the end (review.ts's own). No fences and no prose in that file. Then reply with one line.`,
    ...handBack,
    '',
    '## System',
    '',
    system.text.trim(),
    '',
    '## Task',
    '',
    task.prompt,
    '',
    '## Output schema',
    '',
    '```json',
    JSON.stringify(OUTPUT_SCHEMAS[task.kind], null, 2),
    '```',
    '',
  ].join('\n')
}

async function load(input: LocalInput, deps: Required<Pick<LocalDeps, 'fetch' | 'cloneUrl' | 'packageDir' | 'now'>>, token: () => Promise<string | undefined>): Promise<Loaded> {
  const source = parsePrSource(input.source)
  if (source.kind === 'github') {
    if (input.branch !== undefined || input.base !== undefined) throw new Error(`${source.label} is a GitHub PR; it already says what it is against. Drop --branch and --base.`)
    const pr: GithubPr = { owner: source.owner, name: source.name, number: source.number }
    const auth = await token()
    const meta = await fetchPrMeta(pr, auth, deps.fetch)
    const outputDir = input.output === undefined ? await githubOutputDir(deps.packageDir, slugify(meta.headRef), deps.now()) : resolve(input.output)
    const diff = await fetchPrDiff(pr, auth, deps.fetch)
    const tree = join(workDirFor(outputDir), 'repo')
    return { meta, diff, outputDir, repoPath: tree, github: pr, repoDir: null, materialize: () => cloneHead(pr, meta.headSha, tree, deps.cloneUrl(pr.owner, pr.name), auth) }
  }
  const branch = await resolveLocalBranch(source.path, input.branch, input.base)
  const outputDir = input.output === undefined ? resolve(branch.repoDir, REVIEW_DIR, slugify(branch.headRef)) : resolve(input.output)
  const diff = await localDiff(branch, [workDirFor(outputDir), outputDir, ...(input.knowledge === undefined ? [] : [resolve(input.knowledge)])])
  if (diff.patch.trim() === '') throw new Error(`Nothing to review: ${branch.headRef} is identical to ${branch.baseRef} in ${branch.dir}.`)
  const tree = join(workDirFor(outputDir), 'repo')
  return {
    meta: await localMeta(branch),
    diff,
    outputDir,
    // The checked-out branch is reviewed in place; any other branch from its own commit.
    repoPath: branch.live ? branch.repoDir : tree,
    github: null,
    repoDir: branch.repoDir,
    materialize: branch.live ? async () => {} : () => extractCommit(branch, tree),
  }
}

/** reviews/<date>-<slug>/ in the package; a run started on an earlier day keeps its directory. */
async function githubOutputDir(packageDir: string, slug: string, now: Date): Promise<string> {
  const reviews = join(packageDir, 'reviews')
  const started = (await readdir(reviews).catch(() => [])).filter((name) => /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === `${slug}.local`).sort()
  const existing = started.at(-1)
  if (existing !== undefined) return join(reviews, existing.slice(0, -'.local'.length))
  return join(reviews, `${now.toISOString().slice(0, 10)}-${slug}`)
}

/** What load-knowledge would load, from the agent's configuration: what the session fetches with the Notion MCP. */
export type KnowledgePlan = {
  /** The folder to build, the local equivalent of load-knowledge's /workspace/knowledge. */
  dir: string
  /** The agent's KNOWLEDGE_PAGE: the page INDEX.md is, and the walk starts from. Null when the agent has none configured. */
  root: string | null
  /** The pages REQUIRED.md holds, in order (KNOWLEDGE_REQUIRED, or load-knowledge's default). */
  required: string[]
  maxDepth: number
  maxPages: number
  /** Where the configuration was read. */
  configuredIn: string[]
  files: { index: string; required: string; pages: string }
}

/** A run that cannot start because the guidelines folder is missing or incomplete. */
export class KnowledgeRequired extends Error {
  /** The pages to fetch and the folder to write them to. */
  readonly plan: KnowledgePlan
  constructor(reason: string, plan: KnowledgePlan) {
    super(reason)
    this.name = 'KnowledgeRequired'
    this.plan = plan
  }
}

const ENV_FILES = ['.env.development.local', '.env.local', '../.env.local']

/**
 * load-knowledge's configuration, as eve gives it to the agent: the environment first, then the
 * agent's env files in eve's priority order. Only the knowledge keys are read; the token never is.
 */
export async function knowledgeConfig(agentDir: string, env: Record<string, string | undefined>): Promise<{ root: string | null; required: string[]; configuredIn: string[] }> {
  const files: { path: string; values: Map<string, string> }[] = []
  for (const name of ENV_FILES) {
    const path = resolve(agentDir, name)
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) continue
    const values = new Map<string, string>()
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (match?.[1] === undefined || (match[1] !== KNOWLEDGE_ENV.page && match[1] !== REQUIRED_ENV)) continue
      values.set(match[1], (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2'))
    }
    files.push({ path, values })
  }
  const configuredIn: string[] = []
  const lookup = (key: string): string | undefined => {
    if (env[key] !== undefined) {
      configuredIn.push(`${key} from the environment`)
      return env[key]
    }
    const file = files.find((f) => f.values.has(key))
    if (file !== undefined) configuredIn.push(`${key} from ${file.path}`)
    return file?.values.get(key)
  }
  const root = lookup(KNOWLEDGE_ENV.page)?.trim()
  return { root: root === undefined || root === '' ? null : root, required: parseRequired(lookup(REQUIRED_ENV)), configuredIn }
}

/** Every file under the folder, by path relative to it, sorted. */
async function readFolder(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const names = await readdir(dir, { recursive: true }).catch(() => [])
  for (const name of [...names].sort()) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => null)
    if (text !== null) files.set(name, text)
  }
  return files
}

/**
 * The guidelines are mandatory: the folder must hold a non-empty INDEX.md and a REQUIRED.md with
 * every configured required page under its own heading, or the run does not start.
 */
async function checkKnowledge(dir: string, agentDir: string, env: Record<string, string | undefined>): Promise<{ files: Map<string, string>; fingerprint: string }> {
  const files = await readFolder(dir)
  const indexName = basename(INDEX_FILE)
  const requiredName = basename(REQUIRED_FILE)
  const config = await knowledgeConfig(agentDir, env)
  const problems: string[] = []
  const required = files.get(requiredName)
  if ((files.get(indexName) ?? '').trim() === '') problems.push(`${indexName} is missing or empty`)
  if ((required ?? '').trim() === '') problems.push(`${requiredName} is missing or empty`)
  else {
    const headings = new Set((required ?? '').split('\n').flatMap((line) => (line.startsWith('# ') ? [line.slice(2).trim().toLowerCase()] : [])))
    const absent = config.required.filter((title) => !headings.has(title.trim().toLowerCase()))
    if (absent.length > 0) problems.push(`${requiredName} has no \`# <title>\` section for ${absent.join(', ')}`)
  }
  if (problems.length > 0) {
    throw new KnowledgeRequired(`The engineering guidelines are required and ${dir} is not ready: ${problems.join('; ')}. Build the folder from Notion as the knowledge plan says, then run local again.`, {
      dir,
      root: config.root,
      required: config.required,
      maxDepth: MAX_DEPTH,
      maxPages: MAX_PAGES,
      configuredIn: config.configuredIn,
      files: {
        index: `${join(dir, indexName)}: the root page`,
        required: `${join(dir, requiredName)}: the required pages in full, in order, each under # <page title>, separated by ---`,
        pages: `${dir}/<name>.md for every other page: the title lowercased, each run of other characters replaced by -, trimmed of -, at most 60 characters; a second page with the same name gets -2`,
      },
    })
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([dir, [...files]])).digest('hex')
  return { files, fingerprint }
}

/** One step of a --local review: the next stage's tasks, or the exported review. */
export async function runLocal(input: LocalInput, deps: LocalDeps = {}): Promise<LocalResult> {
  if (input.maxRounds !== undefined && (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > MAX_ROUNDS_LIMIT)) {
    throw new Error(`--max-rounds must be a whole number from 1 to ${MAX_ROUNDS_LIMIT}.`)
  }
  const request = deps.fetch ?? fetch
  let cached: Promise<string | undefined> | undefined
  const token = () => (cached ??= (deps.githubToken ?? defaultGithubToken)())
  const loaded = await load(
    input,
    {
      fetch: request,
      cloneUrl: deps.cloneUrl ?? ((owner, name) => `https://github.com/${owner}/${name}.git`),
      packageDir: deps.packageDir ?? PACKAGE_DIR,
      now: deps.now ?? (() => new Date()),
    },
    token,
  )
  const { meta, outputDir } = loaded
  const work = workDirFor(outputDir)
  const paths = workspacePaths(work)
  const agentDir = deps.agentDir ?? PACKAGE_DIR
  const sources = agentSources(agentDir)

  // What load-pr's finish() writes: the patch cut to size, the changed paths it still holds, pr.md.
  const { patch, truncated } = truncatePatch(loaded.diff.patch)
  const { reviewed, dropped } = splitChanged(loaded.diff.changed, patch, truncated)
  const prMd = renderPrMeta(meta, patchStats(patch, reviewed.length, truncated), reviewed, dropped)
  const fingerprint = createHash('sha256').update(JSON.stringify([meta.label, meta.headSha, meta.baseRef, patch, reviewed])).digest('hex')

  const stateFile = join(work, 'state.json')
  const saved = await readFile(stateFile, 'utf8').then(
    (text) => stateSchema.parse(JSON.parse(text)),
    () => null,
  )
  if (saved !== null && saved.fingerprint !== fingerprint) {
    throw new Error(`${meta.label} changed since this local review started. Delete ${work} to start over.`)
  }
  // The guidelines: where load-knowledge's folder maps, or --knowledge; fixed by the first call.
  const knowledgeDir = input.knowledge !== undefined ? resolve(input.knowledge) : (saved?.knowledge.path ?? rehome(KNOWLEDGE_PATH, work))
  if (saved !== null && knowledgeDir !== saved.knowledge.path) {
    throw new Error(`--knowledge ${knowledgeDir} differs from the ${saved.knowledge.path} this review started with. Drop it, or delete ${work} to start over.`)
  }
  const knowledge = await checkKnowledge(knowledgeDir, agentDir, deps.env ?? process.env)
  if (saved !== null && knowledge.fingerprint !== saved.knowledge.fingerprint) {
    throw new Error(`The engineering guidelines in ${knowledgeDir} changed since this local review started. Delete ${work} to start over.`)
  }
  if (saved !== null && input.maxRounds !== undefined && input.maxRounds !== saved.maxRounds) {
    throw new Error(`--max-rounds ${input.maxRounds} differs from the ${saved.maxRounds} this review started with. Drop it, or delete ${work} to start over.`)
  }
  const state: State = saved ?? { fingerprint, knowledge: { path: knowledgeDir, fingerprint: knowledge.fingerprint }, label: meta.label, maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS, startedAt: new Date().toISOString(), rejections: {}, documents: [] }
  if (saved === null) {
    await mkdir(join(work, 'prompts'), { recursive: true })
    await mkdir(join(work, 'outputs'), { recursive: true })
    await mkdir(paths.roundsDir, { recursive: true })
    await writeFile(paths.files.patch, patch)
    await writeFile(paths.files.changed, `${reviewed.join('\n')}\n`)
    await writeFile(paths.files.meta, prMd)
    await loaded.materialize()
    // Written last: a first call that failed half way starts over rather than resuming a broken setup.
    await writeFile(stateFile, JSON.stringify(state, null, 2))
  }

  const pr: PrContext = { label: meta.label, repoPath: loaded.repoPath, knowledgePath: knowledgeDir, knowledgeRequiredFile: join(knowledgeDir, basename(REQUIRED_FILE)), paths }
  const outputFile = (id: string) => join(work, 'outputs', `${id}.json`)
  const raw = new Map<string, unknown>()
  const handedBack = new Map<string, string>()
  const unparsable = new Map<string, string>()
  for (const name of await readdir(join(work, 'outputs'))) {
    if (!name.endsWith('.json') || name.includes('.rejected-')) continue
    const id = name.slice(0, -'.json'.length)
    const text = await readFile(join(work, 'outputs', name), 'utf8')
    try {
      const parsed: unknown = JSON.parse(text)
      // A handed-back document is the driver's to write; the rest is the agent's output.
      if (typeof parsed === 'object' && parsed !== null && 'document' in parsed && typeof parsed.document === 'string') {
        const { document, ...rest } = parsed
        handedBack.set(id, document)
        raw.set(id, rest)
      } else {
        raw.set(id, parsed)
      }
    } catch (cause) {
      unparsable.set(id, `The output is not valid JSON: ${message(cause)}`)
    }
  }

  let wrote = false
  for (const turn of DOCUMENT_TURNS) {
    const document = handedBack.get(turn.id)
    if (document === undefined || state.documents.includes(turn.id) || !OUTPUT_VALIDATORS[turn.kind].safeParse(raw.get(turn.id)).success) continue
    await writeFile(paths.files[turn.file], document)
    state.documents.push(turn.id)
    wrote = true
  }
  if (wrote) await writeFile(stateFile, JSON.stringify(state, null, 2))

  const plan = planStep({ pr, maxRounds: state.maxRounds, finish: input.finish === true, outputs: (id) => raw.get(id), invalid: (id) => unparsable.get(id) })

  if (!plan.done) {
    const tasks: LocalTask[] = []
    for (const task of plan.tasks) {
      const output = outputFile(task.id)
      let retry: boolean | undefined
      if (task.error !== undefined) {
        // Set the rejected output aside, so the next call sees whether it was resent.
        const rejected = [...(state.rejections[task.id] ?? []), task.error]
        state.rejections[task.id] = rejected
        await rename(output, join(work, 'outputs', `${task.id}.rejected-${rejected.length}.json`))
        retry = rejected.length < 2
      }
      const prompt = join(work, 'prompts', `${task.id}.md`)
      const system = sources.seat(task.agent)
      const document = DOCUMENT_TURNS.find((turn) => turn.id === task.id)
      await writeFile(prompt, renderTaskPrompt(task, output, { path: system, text: await readFile(system, 'utf8') }, document && paths.files[document.file]))
      tasks.push({ id: task.id, agent: task.agent, prompt, output, schema: SCHEMA_NAMES[task.kind], ...(task.error === undefined ? {} : { error: task.error }), ...(retry === undefined ? {} : { retry }) })
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2))
    return { pending: true, status: 'pending', stage: plan.stage, round: plan.round, maxRounds: state.maxRounds, workDir: work, orchestrator: sources.orchestrator, tasks }
  }

  const orchestrator = { path: sources.orchestrator, text: await readFile(sources.orchestrator, 'utf8') }
  return exportReview({ input, deps: { fetch: request, token }, loaded, state, plan, work, pr, knowledge: knowledge.files, orchestrator })
}

async function exportReview(args: {
  input: LocalInput
  deps: { fetch: Fetch; token: () => Promise<string | undefined> }
  loaded: Loaded
  state: State
  plan: DonePlan
  work: string
  pr: PrContext
  knowledge: Map<string, string>
  orchestrator: { path: string; text: string }
}): Promise<LocalDone> {
  const { input, loaded, state, plan, work, pr } = args
  const paths = pr.paths ?? SANDBOX_PATHS
  const dir = loaded.outputDir
  await mkdir(dir, { recursive: true })
  // As export-review: the review lives in the repo it reviewed and git never sees it.
  const gitignore = loaded.repoDir === null || input.output !== undefined ? null : await ensureIgnored(loaded.repoDir)

  const written: string[] = []
  const missingFiles: string[] = []
  const texts = new Map<string, string>()
  for (const path of [paths.files.meta, paths.files.patch, paths.files.changed, paths.files.findings, paths.files.review]) {
    const content = await readFile(path, 'utf8').catch(() => null)
    if (content === null) {
      missingFiles.push(basename(path))
      continue
    }
    texts.set(path, content)
    await writeFile(join(dir, basename(path)), content, 'utf8')
    written.push(join(dir, basename(path)))
  }

  const sections = [`# Review: ${state.label}`]
  for (const path of roundFilesInOrder(plan.rounds, paths.roundsDir)) {
    const content = await readFile(path, 'utf8').catch(() => null)
    if (content !== null && content.trim() !== '') sections.push(content.trim())
  }
  const conversation = join(dir, basename(paths.files.conversation))
  await writeFile(conversation, `${sections.join('\n\n')}\n`, 'utf8')
  written.push(conversation)

  const totalMs = Date.now() - Date.parse(state.startedAt)
  const cost = [
    `# Cost: ${state.label}`,
    '',
    'This review ran with `--local`, in a Claude Code session: every seat and Quinn ran as a subagent of that session, on its model and its usage. No model call went through the Vercel AI Gateway, so there is no itemized cost and no `usage.jsonl`.',
    '',
    `Model turns: ${plan.calls.filter((call) => call.error === undefined).length} of ${plan.calls.length}. Wall clock from the first local step (${state.startedAt}) to export: ${(totalMs / 1000).toFixed(1)}s, including the time the session spent between steps.`,
    '',
  ].join('\n')
  await writeFile(join(dir, 'cost.md'), cost, 'utf8')
  written.push(join(dir, 'cost.md'))

  await mkdir(join(dir, 'trace'), { recursive: true })
  // The rules the review ran under, as they were when it started.
  await cp(state.knowledge.path, join(dir, 'trace', 'guidelines'), { recursive: true })
  written.push(join(dir, 'trace', 'guidelines'))
  const knowledge = { path: state.knowledge.path, fingerprint: state.knowledge.fingerprint, files: [...args.knowledge.keys()] }
  const trace = { mode: 'local', label: state.label, startedAt: state.startedAt, maxRounds: state.maxRounds, knowledge, rejections: state.rejections, calls: plan.calls }
  await writeFile(join(dir, 'trace', 'calls.json'), JSON.stringify(trace, null, 2), 'utf8')
  written.push(join(dir, 'trace', 'calls.json'))

  const status = plan.missing.length === 0 ? 'complete' : 'incomplete'
  const comment =
    loaded.github === null
      ? null
      : await postComment(loaded.github, texts.get(paths.files.review) ?? null, texts.get(paths.files.findings) ?? null, {
          noComment: input.noComment === true,
          complete: status === 'complete',
          fetch: args.deps.fetch,
          token: args.deps.token,
        })

  // Every prompt and output is in trace/calls.json now.
  await rm(work, { recursive: true, force: true })
  return {
    pending: false,
    status,
    label: state.label,
    branch: loaded.meta.headRef,
    verdict: plan.verdict,
    counts: plan.counts,
    findings: plan.counts === null ? null : totalFindings(plan.counts),
    agreed: plan.agreed,
    rounds: plan.rounds,
    maxRounds: state.maxRounds,
    openPoints: plan.openPoints,
    rejected: plan.rejected,
    duplicates: plan.duplicates,
    missing: plan.missing,
    missingFiles,
    dir,
    written,
    gitignore,
    comment,
    orchestrator: args.orchestrator,
  }
}

/** comment-on-pr, outside eve: the same marker and body, to the reviewed PR and nowhere else. */
async function postComment(
  pr: GithubPr,
  review: string | null,
  findings: string | null,
  options: { noComment: boolean; complete: boolean; fetch: Fetch; token: () => Promise<string | undefined> },
): Promise<CommentResult> {
  if (options.noComment) return { posted: false, reason: '--no-comment was given' }
  if (process.env.PR_REVIEW_COMMENT === 'off') return { posted: false, reason: 'PR_REVIEW_COMMENT is off' }
  if (!options.complete) return { posted: false, reason: 'the review is incomplete, so it was not posted' }
  const token = await options.token()
  if (token === undefined) return { posted: false, reason: 'no GitHub token: GITHUB_TOKEN is not set and `gh auth token` returned none' }
  if (review === null || findings === null) return { posted: false, reason: 'review.md or findings.md is missing' }
  const counts = countsFromFindings(findings)
  if (counts === null) return { posted: false, reason: 'findings.md is missing or is not a findings file, so the verdict cannot be computed' }
  try {
    const { action, url } = await upsertReviewComment(pr, reviewCommentBody(review, counts), token, options.fetch)
    return { posted: true, action, url }
  } catch (error) {
    return { posted: false, reason: message(error).replaceAll(token, '***') }
  }
}

/** export-review's .gitignore rule: appended once, never rewriting what is there, never fatal. */
async function ensureIgnored(repoDir: string): Promise<{ path: string; added: boolean; error?: string }> {
  const path = join(repoDir, '.gitignore')
  try {
    const existing = await readFile(path, 'utf8').catch(() => '')
    if (!needsIgnoreRule(existing)) return { path, added: false }
    await writeFile(path, existing + ignoreRule(existing), 'utf8')
    return { path, added: true }
  } catch (error) {
    return { path, added: false, error: message(error) }
  }
}
