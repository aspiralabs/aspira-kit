// Step 6's project gate (F22), after an implementor 'complete' and before static analysis. The
// gate is the static check, unit and integration commands the project's AGENTS.md names (the app's
// AGENTS.md first, then the repository's); when it names none, the app root package.json scripts
// `check`, `test` and `test:integration` that exist (fallbackGate); when there are none either,
// the run records "no project gate found" and goes on. The session runs the commands and writes
// each exit code and output tail; a non-zero exit stops the run with that tail (redacted by the
// Build Summary renderer) before any commit or push.
//
// Credentials (AVA3.1): the gate commands run project code (package.json scripts, tests) in this
// session, which holds push, gh and Notion access. So every command is run as an `env -u` line that
// removes each credential from its environment (credentialNames), in both modes. In cloud mode the
// implementor was a separate agent this session never watched, so when the gate scripts in the app's
// package.json (check, test, test:integration, any script a gate command names, and their npm
// pre/post hooks) differ from origin/main, the gate first prints an `ask` stage naming them with
// the diff: the human answers "run" to go on (recorded against those exact script bodies), and any
// other answer stops the run. In the default mode the implementor ran in this session, so they just run.
//
// The gate runs once per build: its record is keyed to the implementor's export, so a restart, the
// analyzer and Step 8 do not run it again. When it finishes it also records which tracked paths
// were already changed, so Step 8 can tell the analyzer's changes from anything else.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'
import type { Phase, PhaseContext, PhaseResult } from '#build-feature/driver.ts'
import { tail } from '@aspiralabs/ai/common/lib/redact'
import { worktreeDatabaseEnv, worktreeIdentity } from '@aspiralabs/ai/common/lib/worktree-env'
import { CREDENTIALS, credentialNames, withoutCredentials } from '@aspiralabs/ai/common/lib/visual-verify'
import type { Pending, RunState } from '#build-feature/run-state.ts'
import { gitShowFile, gitStatus, packageManagerOf, parseStatus } from '#build-feature/system.ts'

export const NO_GATE = 'no project gate found'

/** The scripts the fallback runs, in this order, when they exist. */
export const FALLBACK_SCRIPTS = ['check', 'test', 'test:integration'] as const

/** A command as the gate lists it: what to run, where, and where it was named. */
/** The gate: each command and the directory it runs in (KIT-38: a multi-app repository runs each where it belongs); `cwd` is the first one, kept for older readers. */
export type Gate = { commands: string[]; cwds: string[]; cwd: string; source: string }

/** The gates aspira.json lists (KIT-38): `{ cwd, command }` each, cwd relative to the repository and '.' by default. */
export type ConfiguredGate = { cwd?: string; command: string }

/** The gate aspira.json configures, when it lists any; it wins over AGENTS.md and the package.json fallback. */
export function configuredGate(repo: string, gates: readonly ConfiguredGate[] | undefined): Gate | null {
  const entries = (gates ?? []).filter((gate) => gate.command.trim() !== '')
  if (entries.length === 0) return null
  const cwds = entries.map((gate) => join(repo, gate.cwd?.trim() || '.'))
  return { commands: entries.map((gate) => gate.command.trim()), cwds, cwd: cwds[0]!, source: 'aspira.json gates' }
}

const resultSchema = z.object({ command: z.string().min(1), exitCode: z.number().int(), output: z.string().default('') })
const answerSchema = z.object({ nonce: z.string(), results: z.array(resultSchema) })

export const gateRecordSchema = z.object({
  /** The build this record belongs to (buildKey). */
  key: z.string(),
  status: z.enum(['passed', 'failed', 'none']),
  source: z.string().nullable(),
  commands: z.array(z.string()),
  results: z.array(resultSchema),
  /** Tracked paths already changed when the gate finished, before the analyzer ran. */
  dirtyBefore: z.array(z.string()),
})
export type GateRecord = z.infer<typeof gateRecordSchema>

/** The script bodies the human answered "run" to (state.phases['gate-scripts']). */
const reviewSchema = z.object({ key: z.string(), names: z.array(z.string()), answer: z.string() })

/** The gate record in run state, or null when there is none (or it is not one). */
export function gateRecordOf(state: { phases?: Record<string, unknown> }): GateRecord | null {
  const parsed = gateRecordSchema.safeParse(state.phases?.gate)
  return parsed.success ? parsed.data : null
}

/** What the Build Summary says about the gate: which commands ran and how, or that there was none. */
export function gateSummaryLines(state: { phases?: Record<string, unknown> }): string[] {
  const record = gateRecordOf(state)
  const reviewed = reviewSchema.safeParse(state.phases?.['gate-scripts'])
  const review = reviewed.success ? [`Changed gate scripts run on the human's "run" answer (cloud mode): ${reviewed.data.names.join(', ')}.`] : []
  if (record === null) return review
  if (record.status === 'none') return [...review, `Project gate: ${NO_GATE}; the run went on to static analysis.`]
  const lines = [...review, `Project gate (${record.source ?? 'unknown source'}): ${record.status}.`]
  for (const command of record.commands) {
    const result = record.results.find((candidate) => candidate.command === command)
    lines.push(`- \`${command}\`: ${result === undefined ? 'not run' : `exit ${result.exitCode}`}`)
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// Finding the gate.
// ---------------------------------------------------------------------------------------------

/** Programs a gate command starts with. */
const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx', 'deno', 'make', 'just', 'cargo', 'go', 'uv', 'poetry', 'pytest', 'ruff', 'mypy', 'tsc', 'eslint', 'vitest', 'jest', 'bundle', 'rake', 'rspec', 'python', 'python3'])
/** Words that make a command a check or a test, not an install or a release. */
const GATE_WORDS = /\b(check|checks|test|tests|test:\S+|lint|typecheck|type-check|vet|clippy|tsc|mypy|ruff|pytest|vitest|jest|rspec)\b/
/** Shell syntax a gate command never needs: such a line is not listed. */
const SHELL = /[;&|<>$`\\]/

/**
 * A sentence that names the per-change gate outright ("Shipping to dev needs `pnpm check` and `pnpm test`",
 * "Gate: `pnpm test`"). When the file has one, only its commands run (KIT-77).
 */
const GATE_SENTENCE = /^\W*gate\b[^:`]*:|\b(?:shipping|merging|before (?:a |each |every )?(?:merge|pr|pull request|push|commit))\b[^`]*?\b(?:needs?|requires?)\b/i
/** Words that make a gate sentence about a release, not a change ("Shipping to prod needs ..."): its commands are release-only. */
const RELEASE_WORDS = /\b(?:prod|production|release)\b/i
/** A sentence whose commands run before a release, not per change: they are left out of the gate (KIT-77). */
const RELEASE_ONLY = /\b(?:before (?:a |the |each |every )?(?:prod(?:uction)? )?release|not per change|release[- ]only|prod(?:uction)? only)\b/i
/** A directory of another app in a monorepo (`apps/mobile`), when the sentence names one. */
const APP_DIR = /\b(?:apps|packages|services)\/[\w.-]+/g

const spansIn = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((span) => span[1]!)
const withoutAsides = (sentence: string): string => sentence.replace(/\([^)]*\)/g, '')
const sentencesIn = (prose: string): string[] => prose.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+/))

/** The candidates that run a check or a test, in order, once each. */
function gateCommandsOf(candidates: readonly string[]): string[] {
  const commands: string[] = []
  for (const raw of candidates) {
    const command = raw.trim().replace(/^\$\s+/, '')
    const program = command.split(/\s+/)[0] ?? ''
    if (!RUNNERS.has(program) || SHELL.test(command) || !GATE_WORDS.test(command.slice(program.length))) continue
    if (!commands.includes(command)) commands.push(command)
  }
  return commands
}

/**
 * The gate commands a markdown file names, in order: the commands of its gate sentence, less the asides
 * in parentheses ("(plus mobile `npm test` when mobile changed)"), when it has one; else inline code and
 * fenced lines that run a check or a test, less those a sentence says run before a release (or ship to
 * prod) or names for another app than `app`. NOM-43 ran `pnpm test:e2e` and the mobile `npm test` in
 * apps/web (KIT-77).
 */
export function gateCommandsIn(markdown: string, app = '.'): string[] {
  const fenced = /```[^\n]*\n([\s\S]*?)```/g
  const prose = markdown.replace(fenced, '')
  const sentences = sentencesIn(prose)
  const gateSentences = sentences.map(withoutAsides).filter((sentence) => GATE_SENTENCE.test(sentence))
  const explicit = gateCommandsOf(gateSentences.filter((sentence) => !RELEASE_WORDS.test(sentence)).flatMap(spansIn))
  if (explicit.length > 0) return explicit
  const ownApp = app.replace(/\/+$/, '')
  const otherApp = (sentence: string) => ownApp !== '.' && [...sentence.matchAll(APP_DIR)].some((dir) => dir[0] !== ownApp)
  const releaseOnly = (sentence: string) => RELEASE_ONLY.test(sentence) || (GATE_SENTENCE.test(sentence) && RELEASE_WORDS.test(sentence))
  const excluded = new Set(gateCommandsOf(sentences.filter((sentence) => releaseOnly(sentence) || otherApp(sentence)).flatMap(spansIn)))
  const candidates: string[] = []
  for (const block of markdown.matchAll(fenced)) candidates.push(...block[1]!.split('\n'))
  candidates.push(...spansIn(prose))
  return gateCommandsOf(candidates).filter((command) => !excluded.has(command))
}

const packageSchema = z.looseObject({ scripts: z.record(z.string(), z.unknown()).optional() })

/** A package.json's scripts that are strings, or null when the text is missing or not a package.json. */
function scriptsIn(raw: string | null): Record<string, string> | null {
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = packageSchema.safeParse(json)
  if (!parsed.success) return null
  return Object.fromEntries(Object.entries(parsed.data.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** The app root package.json scripts check, test and test:integration that exist, or null. */
export async function fallbackGate(repo: string, app: string): Promise<Gate | null> {
  const appDir = join(repo, app)
  const scripts = scriptsIn(await readFile(join(appDir, 'package.json'), 'utf8').catch(() => null))
  if (scripts === null) return null
  const present = FALLBACK_SCRIPTS.filter((name) => scripts[name] !== undefined)
  if (present.length === 0) return null
  const manager = packageManagerOf([appDir, repo])
  const commands = present.map((name) => `${manager} run ${name}`)
  return { commands, cwds: commands.map(() => appDir), cwd: appDir, source: `${app === '.' ? '' : `${app}/`}package.json scripts` }
}

/** The package.json script a `<manager> [run] <script>` command runs, or null for any other command. */
function scriptOf(command: string): string | null {
  const words = command.trim().split(/\s+/)
  if (!['pnpm', 'npm', 'yarn', 'bun'].includes(words[0] ?? '')) return null
  const name = words[1] === 'run' ? words[2] : words[1]
  return name === undefined || name.startsWith('-') ? null : name
}

/**
 * Where a command the repository's AGENTS.md names runs: in the app (aspira.json `app`) when it runs a
 * package.json script the app has and the repository root does not, else at the root. NOM-38 ran
 * `pnpm check` at the root of a repo whose scripts live in apps/web, and the gate failed on
 * "Command check not found".
 */
function cwdOf(command: string, repo: string, app: string, appScripts: Record<string, string> | null, rootScripts: Record<string, string> | null): string {
  const script = scriptOf(command)
  if (app === '.' || script === null || appScripts?.[script] === undefined || rootScripts?.[script] !== undefined) return repo
  return join(repo, app)
}

/** The gate aspira.json configures, else the one the project's AGENTS.md names (the app's first, then the repository's), else the fallback, else null. */
export async function findGate(repo: string, app: string, gates?: readonly ConfiguredGate[]): Promise<Gate | null> {
  const configured = configuredGate(repo, gates)
  if (configured !== null) return configured
  const files = [...new Set([join(repo, app, 'AGENTS.md'), join(repo, 'AGENTS.md')])]
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    const commands = gateCommandsIn(text, app)
    if (commands.length === 0) continue
    if (dirname(file) !== repo) return { commands, cwds: commands.map(() => dirname(file)), cwd: dirname(file), source: file.slice(repo.length + 1) }
    const appScripts = scriptsIn(await readFile(join(repo, app, 'package.json'), 'utf8').catch(() => null))
    const rootScripts = scriptsIn(await readFile(join(repo, 'package.json'), 'utf8').catch(() => null))
    const cwds = commands.map((command) => cwdOf(command, repo, app, appScripts, rootScripts))
    return { commands, cwds, cwd: cwds[0]!, source: file.slice(repo.length + 1) }
  }
  return fallbackGate(repo, app)
}

// ---------------------------------------------------------------------------------------------
// Credentials and changed scripts (AVA3.1).
// ---------------------------------------------------------------------------------------------

// The credential helpers live in agent-common, shared with the visual-verify phase and the standalone run (KIT-58), so every one strips exactly the same names.
export { CREDENTIALS, credentialNames, withoutCredentials }

/** A gate script whose body differs from the base branch: `base` null when the base has no such script. */
export type ChangedScript = { name: string; base: string | null; head: string }

const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])

/** The script a gate command runs by name (`pnpm lint`, `npm run check`), or null. */
function scriptNamed(command: string): string | null {
  const [program, first, second] = command.trim().split(/\s+/)
  if (program === undefined || !PACKAGE_RUNNERS.has(program) || first === undefined) return null
  return first === 'run' || first === 'run-script' ? (second ?? null) : first
}

/** The gate scripts (and their npm pre/post hooks) whose body in `headRaw` differs from `baseRaw`; a missing or unreadable base has none. */
export function changedGateScripts(baseRaw: string | null, headRaw: string | null, commands: readonly string[]): ChangedScript[] {
  const head = scriptsIn(headRaw) ?? {}
  const base = scriptsIn(baseRaw) ?? {}
  const named = commands.map(scriptNamed).filter((name): name is string => name !== null)
  const names = [...new Set([...FALLBACK_SCRIPTS, ...named])].flatMap((name) => [name, `pre${name}`, `post${name}`])
  const changed: ChangedScript[] = []
  for (const name of new Set(names)) {
    const now = head[name]
    if (now === undefined || now === base[name]) continue
    changed.push({ name, base: base[name] ?? null, head: now })
  }
  return changed
}

/** The base branch the cloud implementor's changes are compared with. */
const BASE_REF = 'origin/main'

/** The gate scripts the cloud implementor changed in the app's package.json, against origin/main. */
async function changedScriptsOf(context: PhaseContext, app: string, commands: readonly string[]): Promise<ChangedScript[]> {
  const file = join(context.repo, app, 'package.json')
  const head = await readFile(file, 'utf8').catch(() => null)
  if (head === null) return []
  const shownBase = await gitShowFile({ cwd: context.repo, env: context.env }, BASE_REF, relative(context.repo, file))
  return changedGateScripts(shownBase.code === 0 ? shownBase.stdout : null, head, commands)
}

const scriptsKey = (changed: readonly ChangedScript[]) => createHash('sha256').update(JSON.stringify(changed)).digest('hex').slice(0, 16)

/** The recorded "run" answer on the changed gate scripts, or null. */
const reviewOf = (state: RunState) => {
  const parsed = reviewSchema.safeParse(state.phases['gate-scripts'])
  return parsed.success ? parsed.data : null
}

/** The diff of the changed scripts as the human reads it. */
function scriptsDiff(changed: readonly ChangedScript[]): string {
  return changed.flatMap((entry) => [...(entry.base === null ? [] : [`- ${JSON.stringify(entry.name)}: ${JSON.stringify(entry.base)}`]), `+ ${JSON.stringify(entry.name)}: ${JSON.stringify(entry.head)}`]).join('\n')
}

function scriptsAsk(state: RunState, changed: readonly ChangedScript[], file: string): PhaseResult {
  const names = changed.map((entry) => entry.name)
  const question = [
    `In cloud mode the implementor ran as a separate agent, and it changed the package.json scripts the project gate runs (${file}, against ${BASE_REF}): ${names.join(', ')}.`,
    'The gate runs them in this session, which can push, open PRs and write to Notion, so the run will not run them before you have read them:',
    '',
    '```diff',
    scriptsDiff(changed),
    '```',
    '',
    'Answer "run" to run the gate with these scripts, or anything else to stop the run here.',
  ].join('\n')
  return {
    kind: 'stage',
    state,
    stage: 'ask',
    body: { step: 'gate', question, instructions: 'Ask the human this question in chat, quoted as text, exactly once. Write {"nonce", "answer"} with their answer, in their words, to the output file. Do not answer it yourself.' },
    data: { part: 'scripts', key: scriptsKey(changed), names },
  }
}

const askAnswerSchema = z.object({ nonce: z.string(), answer: z.string().min(1) })

/** The human's answer on the changed scripts: "run" records it and goes on to the gate, anything else stops the run. */
async function acceptScripts(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<PhaseResult> {
  const parsed = askAnswerSchema.safeParse(answer)
  if (!parsed.success) {
    const { step, question, instructions } = pending.stage as Record<string, unknown>
    return { kind: 'stage', state, stage: 'ask', body: { step, question, instructions }, ...(pending.data === undefined ? {} : { data: pending.data }) }
  }
  const key = z.string().parse(pending.data?.key)
  const names = z.array(z.string()).parse(pending.data?.names ?? [])
  if (parsed.data.answer.trim().toLowerCase() !== 'run') {
    const message = `the project gate's scripts ${names.join(', ')} changed in cloud mode and were not approved to run (answer: "${parsed.data.answer.replaceAll('\n', ' ')}"), so the run stops before the gate`
    return { kind: 'stop', state, message, failure: { action: 'gate', message } }
  }
  const reviewed: RunState = { ...state, phases: { ...state.phases, 'gate-scripts': { key, names, answer: parsed.data.answer } } }
  return gateStage(context, reviewed)
}

// ---------------------------------------------------------------------------------------------
// The phase.
// ---------------------------------------------------------------------------------------------

/** The build the gate belongs to: the implementor's export and its last recorded step. */
export async function buildKey(folder: string, state: RunState): Promise<string> {
  const exported = await readFile(join(folder, 'plan.review/trace/implementation-local.json'), 'utf8').catch(() => '')
  const last = state.steps.filter((step) => step.step === 'implementor').at(-1)
  const hash = createHash('sha256').update(exported).digest('hex').slice(0, 16)
  return `${hash}:${last === undefined ? '-' : `${last.runId}:${last.endedAt}`}`
}

const excluded = (path: string) => path.startsWith('.work/') || path.startsWith('.static-analysis/') || path.includes('/.static-analysis/')

/** Tracked paths changed right now, outside the run's own folders. */
async function dirtyTracked(context: PhaseContext): Promise<string[]> {
  const status = await gitStatus({ cwd: context.repo, env: context.env })
  if (status.code !== 0) return []
  return parseStatus(status.stdout)
    .filter((entry) => !entry.untracked && !excluded(entry.path))
    .map((entry) => entry.path)
}

const withRecord = (state: RunState, record: GateRecord): RunState => ({ ...state, phases: { ...state.phases, gate: record } })

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * KIT-67 Q1: in an isolated worktree each run line starts by exporting the worktree's database variables, read by the
 * shell from <app>/.env.development.local, so no command falls back to the shared database in .env.local. The values
 * are read when the line runs and never appear in the stage body. Empty outside an isolated worktree.
 */
async function databaseExports(repo: string, app: string): Promise<string> {
  if ((await worktreeIdentity(repo)) === null) return ''
  const names = Object.keys(await worktreeDatabaseEnv(repo)).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  if (names.length === 0) return ''
  const file = shellQuote(join(repo, app, '.env.development.local'))
  return `${names.map((name) => `export ${name}="$(sed -n 's/^${name}=//p' ${file} | tail -n 1)"`).join('; ')}; `
}

/** Gate stage after an implementor 'complete': nothing when this build's gate is recorded, else the commands to run. */
export async function gateStage(context: PhaseContext, state: RunState, buildOf?: string): Promise<PhaseResult> {
  const key = buildOf ?? (await buildKey(context.folder, state))
  const recorded = gateRecordOf(state)
  if (recorded !== null && recorded.key === key && recorded.status !== 'failed') return { kind: 'done', state }
  const app = context.aspira.app ?? '.'
  const gate = await findGate(context.repo, app, context.aspira.gates)
  if (gate === null) {
    const record: GateRecord = { key, status: 'none', source: null, commands: [], results: [], dirtyBefore: await dirtyTracked(context) }
    return { kind: 'done', state: withRecord(state, record) }
  }
  if (context.mode === 'cloud') {
    const changed = await changedScriptsOf(context, app, gate.commands)
    if (changed.length > 0 && reviewOf(state)?.key !== scriptsKey(changed)) return scriptsAsk(state, changed, relative(context.repo, join(context.repo, app, 'package.json')))
  }
  const unset = credentialNames(context.env)
  const database = await databaseExports(context.repo, app)
  return {
    kind: 'stage',
    state,
    stage: 'gate',
    body: {
      commands: gate.commands,
      run: gate.commands.map((command) => `${database}${withoutCredentials(command, unset)}`),
      unset,
      cwd: gate.cwd,
      cwds: gate.cwds,
      source: gate.source,
      instructions: `Run each line of "run", in order and exactly as written, in the directory at the same index in "cwds" (${[...new Set(gate.cwds)].join(', ')}): each is the command at the same index in "commands" (the project gate ${gate.source} names) with every credential in "unset" removed from its environment, so project code never runs with this session's credentials. Change nothing to make them pass. Write {"nonce", "results": [{"command", "exitCode", "output"}]} to the output file, one result per command you ran, "command" being its "commands" entry, with output the last 40 lines it printed. Stop at the first command that fails.`,
    },
    data: { key, commands: gate.commands, source: gate.source },
  }
}

/** The session's gate results: every command passed, or the run stops with the failing command's tail. */
async function acceptGate(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<PhaseResult> {
  const commands = z.array(z.string()).parse(pending.data?.commands ?? [])
  const source = typeof pending.data?.source === 'string' ? pending.data.source : null
  const key = typeof pending.data?.key === 'string' ? pending.data.key : await buildKey(context.folder, state)
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) {
    const message = `the project gate answer at ${pending.output} is not a list of results: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; ')}`
    return { kind: 'stop', state, message, failure: { action: 'gate', message } }
  }
  const results = parsed.data.results.filter((result) => commands.includes(result.command)).map((result) => ({ ...result, output: tail(result.output) }))
  const record = (status: GateRecord['status'], dirtyBefore: string[]): GateRecord => ({ key, status, source, commands, results, dirtyBefore })
  const failed = results.find((result) => result.exitCode !== 0)
  if (failed !== undefined) {
    const message = `the project gate failed: \`${failed.command}\` exited ${failed.exitCode}, so the run stops before static analysis and the PR`
    return { kind: 'stop', state: withRecord(state, record('failed', [])), message, failure: { action: 'gate', command: failed.command, exitCode: failed.exitCode, output: failed.output, message } }
  }
  const missing = commands.filter((command) => !results.some((result) => result.command === command))
  if (missing.length > 0) {
    const message = `the project gate answer has no result for ${missing.map((command) => `\`${command}\``).join(', ')}, so the gate did not pass`
    return { kind: 'stop', state: withRecord(state, record('failed', [])), message, failure: { action: 'gate', command: missing[0]!, message } }
  }
  return { kind: 'done', state: withRecord(state, record('passed', await dirtyTracked(context))) }
}

/** The driver's gate phase (PHASE_MODULES.gate). */
export const gatePhase: Phase = {
  next: (context, state) => gateStage(context, state),
  accept: (context, state, pending, answer) => (pending.data?.part === 'scripts' ? acceptScripts(context, state, pending, answer) : acceptGate(context, state, pending, answer)),
}
