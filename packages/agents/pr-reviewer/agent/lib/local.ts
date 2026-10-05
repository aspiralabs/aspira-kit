// --local: the pr-debator loop with a Claude Code session as every seat. Each call makes no
// model call. It replays the loop from the start over the outputs already in the work
// directory: a turn whose output validates is fed back in, and the first stage with a
// turn missing (or invalid) is returned as tasks, each with its exact agent prompt written
// to a file. The session runs those as subagents and calls again. Once every stage is done
// the review is exported in the agent's layout and, for a GitHub PR, posted.

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
}

/** Seams for tests: GitHub, the token, the clone remote and where reviews/ lives. */
export type LocalDeps = {
  fetch?: Fetch
  githubToken?: () => Promise<string | undefined>
  cloneUrl?: (owner: string, name: string) => string
  packageDir?: string
  now?: () => Date
}

/** A task as printed for the session: the prompt and output are file paths. */
export type LocalTask = { id: string; agent: Reviewer; prompt: string; output: string; schema: string; error?: string; retry?: boolean }

/** The comment outcome, as comment-on-pr reports it. */
export type CommentResult = { posted: true; action: 'created' | 'updated'; url: string } | { posted: false; reason: string }

/** A stage for the session to run. */
export type LocalPending = { pending: true; status: 'pending'; stage: Stage; round: number; maxRounds: number; workDir: string; tasks: LocalTask[] }

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

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type State = {
  fingerprint: string
  label: string
  maxRounds: number
  startedAt: string
  /** Each turn's rejected outputs, oldest first. */
  rejections: Record<string, string[]>
}

const stateSchema: z.ZodType<State> = z.object({
  fingerprint: z.string(),
  label: z.string(),
  maxRounds: z.number(),
  startedAt: z.string(),
  rejections: z.record(z.string(), z.array(z.string())),
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

/** The seat's system prompt, as eve gives it: its instructions.md. */
async function systemPrompt(who: Reviewer): Promise<string> {
  return readFile(join(PACKAGE_DIR, 'agent', 'subagents', who, 'instructions.md'), 'utf8')
}

/** The file a subagent reads: the seat's system prompt, review.ts's prompt verbatim, the output contract. */
export function renderTaskPrompt(task: PlanTask, output: string, system: string, workDir: string, repoPath: string | null): string {
  return [
    `# Aspira PR review: ${task.id} (--local)`,
    '',
    `You are ${DISPLAY_NAME[task.agent]}, running as a subagent of a Claude Code session instead of inside pr-reviewer. The System and Task sections below are the exact prompt the agent sends this seat. Follow them.`,
    '',
    '- The sandbox in the Task is this machine, and every path it names is a real local path. Where it says read_file, use the Read tool; search with Grep, Glob or read-only shell commands (`rg`, `grep`, `find`, `ls`, `git log`, `git show`).',
    `- Write only the files the Task tells you to write (all under ${workDir}) and your output file. Do not modify ${repoPath === null ? 'anything else' : `the repository at ${repoPath}`}, and do not run the project.`,
    `- Finish by writing ONE JSON object to \`${output}\` that validates against the output schema at the end. No markdown fences and no prose in that file. Then reply with one line: \`done\`, or what stopped you.`,
    '',
    '## System',
    '',
    system.trim(),
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
  const diff = await localDiff(branch, [workDirFor(outputDir), outputDir])
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
  if (saved !== null && input.maxRounds !== undefined && input.maxRounds !== saved.maxRounds) {
    throw new Error(`--max-rounds ${input.maxRounds} differs from the ${saved.maxRounds} this review started with. Drop it, or delete ${work} to start over.`)
  }
  const state: State = saved ?? { fingerprint, label: meta.label, maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS, startedAt: new Date().toISOString(), rejections: {} }
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

  const pr: PrContext = { label: meta.label, repoPath: loaded.repoPath, knowledgePath: null, knowledgeRequiredFile: null, paths }
  const outputFile = (id: string) => join(work, 'outputs', `${id}.json`)
  const raw = new Map<string, unknown>()
  const unparsable = new Map<string, string>()
  for (const name of await readdir(join(work, 'outputs'))) {
    if (!name.endsWith('.json') || name.includes('.rejected-')) continue
    const id = name.slice(0, -'.json'.length)
    const text = await readFile(join(work, 'outputs', name), 'utf8')
    try {
      raw.set(id, JSON.parse(text))
    } catch (cause) {
      unparsable.set(id, `The output is not valid JSON: ${message(cause)}`)
    }
  }

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
      await writeFile(prompt, renderTaskPrompt(task, output, await systemPrompt(task.agent), work, pr.repoPath))
      tasks.push({ id: task.id, agent: task.agent, prompt, output, schema: SCHEMA_NAMES[task.kind], ...(task.error === undefined ? {} : { error: task.error }), ...(retry === undefined ? {} : { retry }) })
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2))
    return { pending: true, status: 'pending', stage: plan.stage, round: plan.round, maxRounds: state.maxRounds, workDir: work, tasks }
  }

  return exportReview({ input, deps: { fetch: request, token }, loaded, state, plan, work, pr })
}

async function exportReview(args: {
  input: LocalInput
  deps: { fetch: Fetch; token: () => Promise<string | undefined> }
  loaded: Loaded
  state: State
  plan: DonePlan
  work: string
  pr: PrContext
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
  const trace = { mode: 'local', label: state.label, startedAt: state.startedAt, maxRounds: state.maxRounds, rejections: state.rejections, calls: plan.calls }
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
