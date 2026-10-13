// Step 6's project gate (F22), after an implementor 'complete' and before static analysis. The
// gate is the static check, unit and integration commands the project's AGENTS.md names (the app's
// AGENTS.md first, then the repository's); when it names none, the app root package.json scripts
// `check`, `test` and `test:integration` that exist (fallbackGate); when there are none either,
// the run records "no project gate found" and goes on. The session runs the commands and writes
// each exit code and output tail; a non-zero exit stops the run with that tail (redacted by the
// Build Summary renderer) before any commit or push.
//
// The gate runs once per build: its record is keyed to the implementor's export, so a restart, the
// analyzer and Step 8 do not run it again. When it finishes it also records which tracked paths
// were already changed, so Step 8 can tell the analyzer's changes from anything else.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Phase, PhaseContext, PhaseResult } from '#src/driver.ts'
import { tail } from '#src/redact.ts'
import type { Pending, RunState } from '#src/run-state.ts'
import { gitStatus, parseStatus } from '#src/system.ts'

export const NO_GATE = 'no project gate found'

/** The scripts the fallback runs, in this order, when they exist. */
export const FALLBACK_SCRIPTS = ['check', 'test', 'test:integration'] as const

/** A command as the gate lists it: what to run, where, and where it was named. */
export type Gate = { commands: string[]; cwd: string; source: string }

const resultSchema = z.object({ command: z.string().min(1), exitCode: z.number().int(), output: z.string().default('') })
const answerSchema = z.object({ nonce: z.string(), results: z.array(resultSchema) })

export const gateRecordSchema = z.object({
  /** The build this record belongs to (gateKey). */
  key: z.string(),
  status: z.enum(['passed', 'failed', 'none']),
  source: z.string().nullable(),
  commands: z.array(z.string()),
  results: z.array(resultSchema),
  /** Tracked paths already changed when the gate finished, before the analyzer ran. */
  dirtyBefore: z.array(z.string()),
})
export type GateRecord = z.infer<typeof gateRecordSchema>

/** The gate record in run state, or null when there is none (or it is not one). */
export function gateRecordOf(state: { phases?: Record<string, unknown> }): GateRecord | null {
  const parsed = gateRecordSchema.safeParse(state.phases?.gate)
  return parsed.success ? parsed.data : null
}

/** What the Build Summary says about the gate: which commands ran and how, or that there was none. */
export function gateSummaryLines(state: { phases?: Record<string, unknown> }): string[] {
  const record = gateRecordOf(state)
  if (record === null) return []
  if (record.status === 'none') return [`Project gate: ${NO_GATE}; the run went on to static analysis.`]
  const lines = [`Project gate (${record.source ?? 'unknown source'}): ${record.status}.`]
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

/** The gate commands a markdown file names, in order: inline code and fenced lines that run a check or a test. */
export function gateCommandsIn(markdown: string): string[] {
  const candidates: string[] = []
  const fenced = /```[^\n]*\n([\s\S]*?)```/g
  for (const block of markdown.matchAll(fenced)) candidates.push(...block[1]!.split('\n'))
  const prose = markdown.replace(fenced, '')
  for (const span of prose.matchAll(/`([^`\n]+)`/g)) candidates.push(span[1]!)
  const commands: string[] = []
  for (const raw of candidates) {
    const command = raw.trim().replace(/^\$\s+/, '')
    const program = command.split(/\s+/)[0] ?? ''
    if (!RUNNERS.has(program) || SHELL.test(command) || !GATE_WORDS.test(command.slice(program.length))) continue
    if (!commands.includes(command)) commands.push(command)
  }
  return commands
}

/** The package manager the app uses, from its lock file (the app's, then the repository's). */
function packageManager(dirs: readonly string[]): string {
  for (const dir of dirs) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
    if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun'
  }
  return 'npm'
}

const packageSchema = z.looseObject({ scripts: z.record(z.string(), z.unknown()).optional() })

/** The app root package.json scripts check, test and test:integration that exist, or null. */
export async function fallbackGate(repo: string, app: string): Promise<Gate | null> {
  const appDir = join(repo, app)
  const file = join(appDir, 'package.json')
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = packageSchema.safeParse(json)
  const scripts = parsed.success ? (parsed.data.scripts ?? {}) : {}
  const present = FALLBACK_SCRIPTS.filter((name) => typeof scripts[name] === 'string')
  if (present.length === 0) return null
  const manager = packageManager([appDir, repo])
  return { commands: present.map((name) => `${manager} run ${name}`), cwd: appDir, source: `${app === '.' ? '' : `${app}/`}package.json scripts` }
}

/** The gate the project's AGENTS.md names (the app's first, then the repository's), else the fallback, else null. */
export async function findGate(repo: string, app: string): Promise<Gate | null> {
  const files = [...new Set([join(repo, app, 'AGENTS.md'), join(repo, 'AGENTS.md')])]
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    const commands = gateCommandsIn(text)
    if (commands.length > 0) return { commands, cwd: dirname(file), source: file.slice(repo.length + 1) }
  }
  return fallbackGate(repo, app)
}

// ---------------------------------------------------------------------------------------------
// The phase.
// ---------------------------------------------------------------------------------------------

/** The build the gate belongs to: the implementor's export and its last recorded step. */
async function gateKey(folder: string, state: RunState): Promise<string> {
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

/** Gate stage after an implementor 'complete': nothing when this build's gate is recorded, else the commands to run. */
export async function gateStage(context: PhaseContext, state: RunState): Promise<PhaseResult> {
  const key = await gateKey(context.folder, state)
  const recorded = gateRecordOf(state)
  if (recorded !== null && recorded.key === key && recorded.status !== 'failed') return { kind: 'done', state }
  const app = context.aspira.app ?? '.'
  const gate = await findGate(context.repo, app)
  if (gate === null) {
    const record: GateRecord = { key, status: 'none', source: null, commands: [], results: [], dirtyBefore: await dirtyTracked(context) }
    return { kind: 'done', state: withRecord(state, record) }
  }
  return {
    kind: 'stage',
    state,
    stage: 'gate',
    body: {
      commands: gate.commands,
      cwd: gate.cwd,
      source: gate.source,
      instructions: `Run each command in "commands", in order and exactly as written, in ${gate.cwd} (they are the project gate ${gate.source} names). Change nothing to make them pass. Write {"nonce", "results": [{"command", "exitCode", "output"}]} to the output file, one result per command you ran, with output the last 40 lines it printed. Stop at the first command that fails.`,
    },
    data: { key, commands: gate.commands, source: gate.source },
  }
}

/** The session's gate results: every command passed, or the run stops with the failing command's tail. */
async function acceptGate(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<PhaseResult> {
  const commands = z.array(z.string()).parse(pending.data?.commands ?? [])
  const source = typeof pending.data?.source === 'string' ? pending.data.source : null
  const key = typeof pending.data?.key === 'string' ? pending.data.key : await gateKey(context.folder, state)
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
  next: gateStage,
  accept: acceptGate,
}
