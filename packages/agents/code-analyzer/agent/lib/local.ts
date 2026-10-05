// --local: the static-analysis loop with a Claude Code session as the fix model. Each call is one
// step and makes no model call. The deterministic half runs here exactly as in runStaticAnalysis:
// detection, toolchain probe, auto-fix and analysis, the same batching and the same stop rules.
// Where the agent would call its fix model, the step returns one task per batch instead, each
// with the fixer's exact prompt written to a file. The session runs them as subagents, which edit
// the files in place and write the `done` result; the next step checks every changed file against
// the agent's edit guards, reverts what they would have rejected, and carries on with the loop.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { detect, type Analyzer, type Detection } from './analyzers.ts'
import { batch as batchOf, sameSet, type Batch, type Diagnostic } from './diagnostics.ts'
import { hostExecutor, type Executor } from './executor.ts'
import type { Knowledge } from './fixer.ts'
import { checkGuidelinesFile, checkKnowledgeDir, fixKnowledge, knowledgeConfig, type LoadedKnowledge } from './knowledge.ts'
import { changeRejection, type Rejection } from './guards.ts'
import { finalStatus, runAnalyzers, runAutofix, STOP, targetsOf, type LoopResult, type Round } from './loop.ts'
import { renderReport } from './report.ts'
import { ignoreOutput, prepareToolchain, recordGuidelines, repositoryInstructions, runSetup, setting } from './runner.ts'
import { parseSource } from './source.ts'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUTPUT_DIR = '.static-analysis'
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Re-exported for the CLI and tests: the guidelines module is shared with the default path. */
export { KnowledgeRequired, knowledgeConfig, type KnowledgeConfig, type KnowledgePlan } from './knowledge.ts'

// ---------------------------------------------------------------------------------------------
// The fixer, loaded from the agent's own files on every call.

type FixerModule = {
  systemPrompt: string
  fixPrompt: (input: { instructions: string; batch: Batch; excerpts: string[]; knowledge?: Knowledge | null }) => string
  fileExcerpt: (executor: Executor, file: string, diagnostics: Diagnostic[]) => Promise<string>
  doneSchema: z.ZodType<{ summary: string; unresolved: { file: string; line: number | null; reason: string }[] }>
}

// A type guard rather than a cast: the module is the agent's fixer.ts, checked for the exports used.
function isFixerModule(value: unknown): value is FixerModule {
  if (typeof value !== 'object' || value === null) return false
  return (
    'systemPrompt' in value && typeof value.systemPrompt === 'string' &&
    'fixPrompt' in value && typeof value.fixPrompt === 'function' &&
    'fileExcerpt' in value && typeof value.fileExcerpt === 'function' &&
    'doneSchema' in value && typeof value.doneSchema === 'object' && value.doneSchema !== null && 'safeParse' in value.doneSchema
  )
}

/** The agent's agent/lib/fixer.ts: its system prompt, prompt builder and done schema, as they are now. */
async function loadFixer(agentDir: string): Promise<FixerModule> {
  const module: unknown = await import(pathToFileURL(join(agentDir, 'agent', 'lib', 'fixer.ts')).href)
  if (!isFixerModule(module)) throw new Error(`${join(agentDir, 'agent', 'lib', 'fixer.ts')} does not export systemPrompt, fixPrompt, fileExcerpt and doneSchema.`)
  return module
}

// ---------------------------------------------------------------------------------------------
// State between steps.

const diagnosticSchema = z.object({ tool: z.string(), file: z.string(), line: z.number().nullable(), column: z.number().nullable(), message: z.string(), rule: z.string().nullable(), severity: z.enum(['error', 'warning']) })
const roundSchema = z.object({
  round: z.number(),
  autofix: z.array(z.object({ id: z.string(), exitCode: z.number(), ms: z.number() })),
  analyzers: z.array(z.object({ id: z.string(), exitCode: z.number(), ms: z.number(), diagnostics: z.number(), problem: z.string().nullable() })),
  targets: z.number(),
  batches: z.number(),
  edits: z.number(),
  rejected: z.number(),
  unresolved: z.array(z.string()),
  ms: z.number(),
})
const taskSchema = z.object({ id: z.string(), batch: z.number(), files: z.array(z.string()), diagnostics: z.array(diagnosticSchema), prompt: z.string(), output: z.string() })
const callSchema = z.object({ round: z.number(), batch: z.number(), prompt: z.string(), output: z.unknown().optional(), error: z.string().optional() })
const stateSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  gitRoot: z.string(),
  outputDir: z.string(),
  ignoreOutput: z.boolean(),
  knowledge: z.object({ source: z.enum(['notion', 'knowledge', 'guidelines']), dir: z.string().nullable(), requiredFile: z.string(), fingerprint: z.string(), files: z.array(z.string()) }),
  maxRounds: z.number(),
  fixWarnings: z.boolean(),
  noFix: z.boolean(),
  startedAt: z.string(),
  prepareMs: z.number(),
  analyzers: z.array(z.string()),
  unavailable: z.array(z.string()),
  notes: z.array(z.string()),
  initial: z.array(diagnosticSchema),
  current: z.array(diagnosticSchema),
  previous: z.array(diagnosticSchema).nullable(),
  problems: z.array(z.string()),
  rounds: z.array(roundSchema),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
  editedFiles: z.array(z.string()),
  calls: z.array(callSchema),
  missing: z.array(z.object({ id: z.string(), reason: z.string() })),
  rejections: z.record(z.string(), z.array(z.string())),
  pending: z.object({ round: z.number(), tasks: z.array(taskSchema) }).nullable(),
  stop: z.object({ status: z.enum(['clean', 'partial', 'nothing-detected', 'failed']), reason: z.string() }).nullable(),
})
type State = z.infer<typeof stateSchema>

// ---------------------------------------------------------------------------------------------
// The step driver.

/** What one `local` call is asked to do. Pass the same values on every call of a run. */
export type LocalInput = {
  /** An absolute path: a repository or a directory inside one (one app of several). Remote sources are refused. */
  source: string
  /** Export directory. Default: `<source>/.static-analysis/`. */
  output?: string
  /** A folder in load-knowledge's shape (REQUIRED.md, INDEX.md, one file per page) instead of `<work>/knowledge`. Fixed by the first call. */
  knowledge?: string
  /** A REQUIRED.md snapshot instead of a knowledge folder. Fixed by the first call. */
  guidelines?: string
  /** Round cap. Default STATIC_ANALYSIS_MAX_ROUNDS, else 6, as the agent; fixed by the first call. */
  maxRounds?: number
  /** Also fix warning-severity diagnostics. Default STATIC_ANALYSIS_WARNINGS=fix, as the agent. */
  fixWarnings?: boolean
  /** Detect and analyze only: no setup, no auto-fix, no model stage, no source file changed. With --output outside the repository, nothing is written to it. */
  noFix?: boolean
  /** Stop now: record outputs that are missing, take a last analysis and export. */
  finish?: boolean
}

/** Seams for tests: the agent package the prompts and config are read from, and the env on top of its env files. */
export type LocalDeps = { agentDir?: string; env?: NodeJS.ProcessEnv; progress?: (message: string) => void }

/** One batch for the session: run the prompt file as a subagent, which writes its JSON to `output`. */
export type LocalTask = { id: string; prompt: string; output: string; files: string[]; diagnostics: number; error?: string; retry?: boolean }

/** A fix stage for the session to run, at most `parallel` subagents at a time. */
export type LocalPending = {
  pending: true
  stage: 'fix'
  round: number
  maxRounds: number
  parallel: number
  root: string
  workDir: string
  /** The agent's instructions: how the session reports the finished run. */
  orchestrator: string
  tasks: LocalTask[]
}

/** The exported run, in the agent's result shape plus what --local adds. */
export type LocalDone = {
  pending: false
  status: LoopResult['status']
  reason: string
  dir: string
  root: string
  analyzers: string[]
  rounds: number
  initial: number
  remaining: number
  editedFiles: string[]
  rejected: Rejection[]
  problems: string[]
  unavailable: string[]
  /** Fix tasks that never produced a valid output (only with finish). */
  missing: { id: string; reason: string }[]
  knowledge: LoadedKnowledge
  /** The agent's instructions, read at export: the session reports the run by them. */
  orchestrator: { path: string; text: string }
}

/** Either the next fix stage or the finished run. */
export type LocalResult = LocalPending | LocalDone

/** The work directory of a run: inside its output directory, so the output's .gitignore rule covers it. */
export const workDirFor = (outputDir: string): string => join(outputDir, '.local')

const commandTimeoutMs = () => Number(process.env.STATIC_ANALYSIS_COMMAND_TIMEOUT_MS) || 600_000
const parallel = () => Number(process.env.STATIC_ANALYSIS_CONCURRENCY) || 3

/** One step of a --local run: the next fix stage's tasks, or the exported run. */
export async function runLocal(input: LocalInput, deps: LocalDeps = {}): Promise<LocalResult> {
  const agentDir = deps.agentDir ?? PACKAGE_DIR
  if (input.maxRounds !== undefined && (!Number.isInteger(input.maxRounds) || input.maxRounds < 1)) throw new Error('--max-rounds must be a whole number of at least 1.')
  const source = await parseSource(input.source)
  if (source.kind !== 'local') throw new Error(`--local runs on a local path only. ${source.label} would be cloned and fixed in the eve sandbox, because fetched code never runs on the host; run it without --local.`)
  const outputDir = resolve(input.output ?? join(source.root, OUTPUT_DIR))
  const work = workDirFor(outputDir)
  const stateFile = join(work, 'state.json')
  const saved = await readFile(stateFile, 'utf8').then(
    (text) => stateSchema.parse(JSON.parse(text)),
    () => null,
  )
  if (saved !== null && saved.root !== source.root) throw new Error(`${work} belongs to a run of ${saved.root}, not ${source.root}. Delete it to start over.`)
  if (saved !== null && input.maxRounds !== undefined && input.maxRounds !== saved.maxRounds) throw new Error(`--max-rounds ${input.maxRounds} differs from the ${saved.maxRounds} this run started with. Drop it, or delete ${work} to start over.`)
  if (input.knowledge !== undefined && input.guidelines !== undefined) throw new Error('Pass --knowledge DIR or --guidelines FILE, not both.')
  if (saved !== null) {
    const given = input.knowledge ?? input.guidelines
    const started = saved.knowledge.source === 'guidelines' ? saved.knowledge.requiredFile : saved.knowledge.dir
    if (given !== undefined && resolve(given) !== started) throw new Error(`${input.knowledge !== undefined ? '--knowledge' : '--guidelines'} ${resolve(given)} differs from ${started ?? 'the guidelines'}, which this run started with. Drop it, or delete ${work} to start over.`)
  }

  // No step runs without the guidelines, and none runs under different ones than the first.
  const config = await knowledgeConfig(agentDir, deps.env ?? process.env)
  const hint = `fetch the pages in the knowledge stage into ${join(work, 'knowledge')}, or pass --knowledge DIR (a load-knowledge folder) or --guidelines FILE (a REQUIRED.md snapshot).`
  const knowledge = saved !== null
    ? saved.knowledge.source === 'guidelines' ? await checkGuidelinesFile(saved.knowledge.requiredFile, config) : await checkKnowledgeDir(saved.knowledge.dir ?? join(work, 'knowledge'), config, hint)
    : input.guidelines !== undefined ? await checkGuidelinesFile(resolve(input.guidelines), config) : await checkKnowledgeDir(resolve(input.knowledge ?? join(work, 'knowledge')), config, hint)
  if (saved !== null && knowledge.fingerprint !== saved.knowledge.fingerprint) throw new Error(`The engineering guidelines in ${knowledge.dir ?? knowledge.requiredFile} changed since this run started. Restore them, or delete ${work} to start over.`)

  const fixer = await loadFixer(agentDir)
  const executor = hostExecutor(source.root)
  const progress = deps.progress
  const options = { commandTimeoutMs: commandTimeoutMs(), ...(progress ? { progress } : {}) }
  const files = await executor.listFiles()
  const detection = await detect(files, (path) => executor.readFile(path))

  let state: State
  if (saved === null) {
    const started = Date.now()
    const noFix = input.noFix === true
    const ignore = input.output === undefined
    // The work directory is inside the default output; ignore it before any analyzer walks the tree.
    if (ignore) await ignoreOutput(source.root)
    const toolchain = await prepareToolchain(executor, detection.analyzers, progress)
    const notes = [...detection.notes, ...toolchain.notes]
    if (noFix) notes.push('--no-fix: dependency setup, auto-fix and the model stage were skipped; no source file was changed.')
    else if (toolchain.ready.length) notes.push(...(await runSetup(executor, detection, progress)))
    const ready = toolchain.ready
    state = {
      version: 1,
      root: source.root,
      gitRoot: source.gitRoot,
      outputDir,
      ignoreOutput: ignore,
      knowledge,
      maxRounds: setting(input.maxRounds, 'STATIC_ANALYSIS_MAX_ROUNDS', 6),
      fixWarnings: input.fixWarnings ?? process.env.STATIC_ANALYSIS_WARNINGS === 'fix',
      noFix,
      startedAt: new Date(started).toISOString(),
      prepareMs: 0,
      analyzers: ready.map((a) => a.id),
      unavailable: toolchain.unavailable,
      notes,
      initial: [],
      current: [],
      previous: null,
      problems: [],
      rounds: [],
      rejected: [],
      editedFiles: [],
      calls: [],
      missing: [],
      rejections: {},
      pending: null,
      stop: null,
    }
    if (!ready.some((a) => a.check)) state.stop = { status: 'nothing-detected', reason: STOP.none }
    else {
      const initial = await runAnalyzers(executor, ready, options)
      state.problems.push(...initial.runs.flatMap((run) => (run.problem ? [run.problem] : [])))
      if (initial.runs.length && initial.runs.every((run) => run.problem)) state.stop = { status: 'failed', reason: STOP.allFailed }
      state.initial = initial.diagnostics
      state.current = initial.diagnostics
      if (noFix && state.stop === null) state.stop = { status: finalStatus(targetsOf(state.current, state.fixWarnings), state.problems), reason: 'check only (--no-fix): no auto-fix or model fix ran' }
    }
    state.prepareMs = Date.now() - started
    await mkdir(join(work, 'outputs'), { recursive: true })
    await mkdir(join(work, 'prompts'), { recursive: true })
  } else state = saved

  const analyzers = detection.analyzers.filter((a) => state.analyzers.includes(a.id))
  const save = () => writeFile(stateFile, JSON.stringify(state, null, 2))

  if (state.pending !== null && state.stop === null) {
    const waiting = await collectFixStage(state, executor, work, fixer, input.finish === true)
    if (waiting.length > 0) {
      await save()
      return pendingResult(state, work, agentDir, waiting)
    }
    const round = state.rounds.at(-1)?.round ?? 0
    if (input.finish === true || round >= state.maxRounds) {
      // The last round's edits deserve a verdict too.
      const final = await runAnalyzers(executor, analyzers, options)
      state.problems.push(...final.runs.flatMap((run) => (run.problem ? [run.problem] : [])))
      state.current = final.diagnostics
      state.stop = { status: finalStatus(targetsOf(state.current, state.fixWarnings), unique(state.problems)), reason: input.finish === true ? 'finished early (--finish)' : STOP.roundCap(state.maxRounds) }
    }
  }

  while (state.stop === null) {
    const round = state.rounds.length + 1
    if (input.finish === true) {
      state.stop = { status: finalStatus(targetsOf(state.current, state.fixWarnings), unique(state.problems)), reason: 'finished early (--finish)' }
      break
    }
    const roundStarted = Date.now()
    const record: Round = { round, autofix: [], analyzers: [], targets: 0, batches: 0, edits: 0, rejected: 0, unresolved: [], ms: 0 }
    state.rounds.push(record)
    record.autofix = await runAutofix(executor, analyzers, options)
    const analyzed = await runAnalyzers(executor, analyzers, options)
    record.analyzers = analyzed.runs
    state.problems.push(...analyzed.runs.flatMap((run) => (run.problem ? [run.problem] : [])))
    state.current = analyzed.diagnostics
    const targets = targetsOf(state.current, state.fixWarnings)
    record.targets = targets.length
    record.ms = Date.now() - roundStarted
    const status = () => finalStatus(targets, unique(state.problems))
    if (!targets.length) { state.stop = { status: status(), reason: STOP.clean }; break }
    if (state.previous && sameSet(targets, state.previous)) { state.stop = { status: status(), reason: STOP.noProgress }; break }
    state.previous = targets
    const batches = batchOf(targets)
    record.batches = batches.length
    progress?.(`round ${round}: ${targets.length} diagnostics in ${batches.length} batches`)
    const tasks = await writeFixStage(state, executor, work, fixer, round, batches)
    await save()
    return pendingResult(state, work, agentDir, tasks)
  }

  return exportRun(state, work, agentDir, fixer, detection, analyzers)
}

const unique = (items: string[]) => [...new Set(items)]

function pendingResult(state: State, work: string, agentDir: string, tasks: LocalTask[]): LocalPending {
  return {
    pending: true,
    stage: 'fix',
    round: state.pending?.round ?? state.rounds.length,
    maxRounds: state.maxRounds,
    parallel: parallel(),
    root: state.root,
    workDir: work,
    orchestrator: join(agentDir, 'agent', 'instructions.md'),
    tasks,
  }
}

/** The file a subagent reads: the mapping onto Claude Code tools, then the fixer's system prompt and task verbatim. */
export function renderTaskPrompt(args: { id: string; root: string; output: string; system: string; task: string; schema: unknown }): string {
  return [
    `# Aspira code analyzer: ${args.id} (--local)`,
    '',
    'You are the code-analyzer\'s fix model, running as a subagent of a Claude Code session instead of inside code-analyzer. The System and Task sections below are the exact prompt the agent sends its fix model. Follow them.',
    '',
    `- The repository in the Task is ${args.root}; every path in it is relative to that directory. Its tools map onto yours: read_file is the Read tool, search is Grep (or read-only \`git grep\`), edit_file is the Edit tool with one exact, unique replacement per call, and done is writing the output file below.`,
    `- You have no shell beyond read-only searches: do not run the analyzers, the project, installs or git commands that change anything. Edit only files under ${args.root}. After you finish, the driver checks every changed file against the agent's edit guards and reverts what they reject.`,
    `- Finish by writing ONE JSON object to \`${args.output}\` that validates against the output schema at the end: the done result. No markdown fences and no prose in that file. Then reply with one line: \`done\`, or what stopped you.`,
    '',
    '## System',
    '',
    args.system,
    '',
    '## Task',
    '',
    args.task,
    '',
    '## Output schema',
    '',
    '```json',
    JSON.stringify(args.schema, null, 2),
    '```',
    '',
  ].join('\n')
}

const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
const snapshotSchema = z.object({ hashes: z.record(z.string(), z.string()), contents: z.record(z.string(), z.string()) })
/** Every file's hash before a fix stage, and the content of those small enough to restore. */
type Snapshot = z.infer<typeof snapshotSchema>

/** A file's hash, and its text when it is small enough to keep; a large file is hashed by size and mtime. */
async function fileState(executor: Executor, root: string, file: string): Promise<{ hash: string; text: string | null } | null> {
  const info = await stat(join(root, file)).catch(() => null)
  if (info === null || !info.isFile()) return null
  if (info.size > SNAPSHOT_MAX_BYTES) return { hash: `size:${info.size}:mtime:${info.mtimeMs}`, text: null }
  const text = await executor.readFile(file)
  return text === null ? null : { hash: sha256(text), text }
}

/** The repository's files, minus this run's own output and work directories. */
async function trackedFiles(executor: Executor, state: State): Promise<string[]> {
  const skip = [state.outputDir, workDirFor(state.outputDir)].map((dir) => relative(state.root, dir)).filter((rel) => rel !== '' && !rel.startsWith('..'))
  return (await executor.listFiles()).filter((file) => !skip.some((dir) => file === dir || file.startsWith(`${dir}/`) || file.startsWith(`${dir}${sep}`)))
}

/** Writes each batch's prompt and snapshots the tree, so the next step can tell which files the session changed. */
async function writeFixStage(state: State, executor: Executor, work: string, fixer: FixerModule, round: number, batches: Batch[]): Promise<LocalTask[]> {
  const instructions = await repositoryInstructions(executor, state.gitRoot)
  const knowledge: Knowledge = await fixKnowledge(state.knowledge)
  const schema = z.toJSONSchema(fixer.doneSchema)
  const tasks: State['pending'] = { round, tasks: [] }
  const out: LocalTask[] = []
  for (const [index, batch] of batches.entries()) {
    const id = `round-${round}-batch-${index + 1}`
    const excerpts = await Promise.all(batch.files.map((file) => fixer.fileExcerpt(executor, file, batch.diagnostics.filter((d) => d.file === file))))
    const task = fixer.fixPrompt({ instructions, batch, excerpts, knowledge })
    const prompt = join(work, 'prompts', `${id}.md`)
    const output = join(work, 'outputs', `${id}.json`)
    await writeFile(prompt, renderTaskPrompt({ id, root: state.root, output, system: fixer.systemPrompt, task, schema }))
    await rm(output, { force: true })
    tasks.tasks.push({ id, batch: index + 1, files: batch.files, diagnostics: batch.diagnostics, prompt, output })
    out.push({ id, prompt, output, files: batch.files, diagnostics: batch.diagnostics.length })
  }
  const snapshot: Snapshot = { hashes: {}, contents: {} }
  for (const file of await trackedFiles(executor, state)) {
    const seen = await fileState(executor, state.root, file)
    if (seen === null) continue
    snapshot.hashes[file] = seen.hash
    if (seen.text !== null) snapshot.contents[file] = seen.text
  }
  await writeFile(join(work, 'snapshot.json'), JSON.stringify(snapshot))
  state.pending = tasks
  return out
}

/**
 * Validates the stage's outputs. Returns the tasks still owed (with the schema error, one resend
 * each); when none are, applies the edit guards to every changed file and records the round.
 */
async function collectFixStage(state: State, executor: Executor, work: string, fixer: FixerModule, finish: boolean): Promise<LocalTask[]> {
  const stage = state.pending
  if (stage === null) return []
  const record = state.rounds.find((r) => r.round === stage.round)
  const waiting: LocalTask[] = []
  const outputs = new Map<string, z.infer<FixerModule['doneSchema']>>()
  for (const task of stage.tasks) {
    const text = await readFile(task.output, 'utf8').catch(() => null)
    let error: string | undefined
    if (text !== null) {
      try {
        const parsed = fixer.doneSchema.safeParse(JSON.parse(text))
        if (parsed.success) {
          outputs.set(task.id, parsed.data)
          continue
        }
        error = z.prettifyError(parsed.error).slice(0, 2000)
      } catch (cause) {
        error = `The output is not valid JSON: ${message(cause)}`
      }
    }
    const rejected = state.rejections[task.id] ?? []
    if (finish) {
      const last = error ?? rejected.at(-1)
      state.missing.push({ id: task.id, reason: last === undefined ? 'no output was produced in the session' : `invalid output: ${last}` })
      continue
    }
    let retry: boolean | undefined
    if (error !== undefined) {
      // Set the rejected output aside, so the next step sees whether it was resent.
      state.rejections[task.id] = [...rejected, error]
      await rename(task.output, join(work, 'outputs', `${task.id}.rejected-${rejected.length + 1}.json`))
      retry = rejected.length + 1 < 2
    }
    waiting.push({ id: task.id, prompt: task.prompt, output: task.output, files: task.files, diagnostics: task.diagnostics.length, ...(error === undefined ? {} : { error }), ...(retry === undefined ? {} : { retry }) })
  }
  if (waiting.length > 0) return waiting

  // The session edited the tree directly; hold every change to the guards edit_file applies.
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(join(work, 'snapshot.json'), 'utf8')))
  const now = new Set(await trackedFiles(executor, state))
  const edited: string[] = []
  const rejections: Rejection[] = []
  for (const file of unique([...Object.keys(snapshot.hashes), ...now]).sort()) {
    const existed = file in snapshot.hashes
    const current = now.has(file) ? await fileState(executor, state.root, file) : null
    if (existed && current !== null && current.hash === snapshot.hashes[file]) continue
    if (!existed && current === null) continue
    const before = existed ? (snapshot.contents[file] ?? null) : null
    if (existed && before === null) {
      // Too large to have been kept: judged by its path alone, and not restorable.
      const reason = changeRejection(state.root, file, '', '')
      if (reason === null) edited.push(file)
      else rejections.push({ path: file, reason: `${reason}; too large to restore, revert it by hand` })
      continue
    }
    const reason = changeRejection(state.root, file, before, current?.text ?? null)
    if (reason === null) { edited.push(file); continue }
    rejections.push({ path: file, reason })
    if (before === null) await rm(join(state.root, file), { force: true })
    else await executor.writeFile(file, before)
  }
  for (const task of stage.tasks) {
    const output = outputs.get(task.id)
    state.calls.push({ round: stage.round, batch: task.batch, prompt: await readFile(task.prompt, 'utf8'), ...(output === undefined ? { error: state.missing.find((m) => m.id === task.id)?.reason ?? 'no output' } : { output }) })
    if (record && output) record.unresolved.push(...output.unresolved.map((u) => `${u.file}:${u.line ?? '?'} ${u.reason}`))
  }
  if (record) {
    record.edits += edited.length
    record.rejected += rejections.length
  }
  state.rejected.push(...rejections)
  state.editedFiles = unique([...state.editedFiles, ...edited]).sort()
  state.pending = null
  await rm(join(work, 'snapshot.json'), { force: true })
  return []
}

async function exportRun(state: State, work: string, agentDir: string, fixer: FixerModule, detection: Detection, analyzers: Analyzer[]): Promise<LocalDone> {
  const stop = state.stop ?? { status: 'partial' as const, reason: 'stopped' }
  const totalMs = Date.now() - Date.parse(state.startedAt)
  const result: LoopResult = {
    status: stop.status,
    reason: stop.reason,
    rounds: state.rounds,
    initial: state.initial,
    remaining: state.current,
    problems: unique(state.problems),
    editedFiles: state.editedFiles,
    rejected: state.rejected,
    ms: totalMs - state.prepareMs,
  }
  const shown: Detection = { ...detection, analyzers, notes: state.notes }
  const timing = { prepareMs: state.prepareMs, loopMs: totalMs - state.prepareMs, publishMs: 0, totalMs }
  const local = [
    '## Mode',
    '',
    `This run used \`--local\`: the analyzers ran from the code-analyzer package on this host, and the fix model was this Claude Code session's subagents, given the fixer's own prompts. No model call went through the AI Gateway, so no cost is itemized. The session's edits were checked against the agent's edit guards after each fix stage. Engineering guidelines: ${state.knowledge.dir ?? state.knowledge.requiredFile} (${state.knowledge.files.length} files, copied to \`guidelines/\`).`,
    '',
  ].join('\n')
  const report = `${renderReport({ label: state.root, where: 'host', result, detection: shown, unavailable: state.unavailable, turns: [], model: 'Claude Code session (--local)', timing, remote: null })}\n${local}`
  const dir = state.outputDir
  await mkdir(dir, { recursive: true })
  const knowledge = { path: state.knowledge.dir ?? state.knowledge.requiredFile, source: state.knowledge.source, files: state.knowledge.files, fingerprint: state.knowledge.fingerprint }
  const files: Record<string, string> = {
    'report.md': report,
    'diagnostics.json': JSON.stringify({ status: result.status, remaining: result.remaining, initial: result.initial }, null, 2),
    'rounds.json': JSON.stringify({ mode: 'local', status: result.status, reason: result.reason, rounds: result.rounds, problems: result.problems, rejected: result.rejected, editedFiles: result.editedFiles, missing: state.missing, detection: { ...shown, analyzers: analyzers.map(({ parse: _parse, ...a }) => a) }, unavailable: state.unavailable, timing, remote: null, knowledge }, null, 2),
    'usage.json': JSON.stringify({ scope: 'This run used --local: every fix ran as a subagent of a Claude Code session, on its model and usage. No model call went through the AI Gateway, so there are no turns to itemize.', model: 'Claude Code session (--local)', turns: [] }, null, 2),
    'calls.json': JSON.stringify({ mode: 'local', system: fixer.systemPrompt, model: 'Claude Code session (--local)', rejections: state.rejections, calls: state.calls }, null, 2),
  }
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content, 'utf8')))
  // The export records the rules the run was held to.
  await recordGuidelines(state.knowledge, dir)
  if (state.ignoreOutput) await ignoreOutput(state.root)
  // Every prompt and output is in calls.json now.
  await rm(work, { recursive: true, force: true })
  const orchestrator = join(agentDir, 'agent', 'instructions.md')
  return {
    pending: false,
    status: result.status,
    reason: result.reason,
    dir,
    root: state.root,
    analyzers: analyzers.map((a) => a.id),
    rounds: result.rounds.length,
    initial: result.initial.length,
    remaining: result.remaining.length,
    editedFiles: result.editedFiles,
    rejected: result.rejected,
    problems: result.problems.map((p) => p.split('\n')[0] ?? p),
    unavailable: state.unavailable,
    missing: state.missing,
    knowledge: state.knowledge,
    orchestrator: { path: orchestrator, text: await readFile(orchestrator, 'utf8') },
  }
}
