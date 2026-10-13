// The build-feature stage machine. Each call reads the run state, takes the answer to the one stage
// the session had to perform (only when it carries that stage's nonce), records it, and prints
// exactly one next stage as JSON: resolve, approval, overrides, worktree, step, ask, move, set-pr,
// gate, step10, fix, release-row, summary or end. The session performs the stage and calls again.
//
// Modes (F2, Q10 revised): with --local every step stage runs its step skill with --local in this
// session; without it every step stage runs the step skill's default mode, which starts that step's
// cloud agent and waits on it. The mode is recorded on the run and in the Build Summary.
//
// One worktree per ticket (F50): once the card (and its Type) is resolved at run start, before any
// step, the run moves into `.worktrees/<TYPE>-<ID>` on `<prefix>/<id>-<slug>` (worktree.ts). Run
// from anywhere else, the driver makes or reuses that worktree, carries the ticket's `.work/`
// folder and the run state there, and prints a `worktree` stage: the session continues from inside
// it, so every later step, board pull and git command runs there.
//
// What the driver guarantees: one run per ticket at a time (F48); the card is resolved live before
// any step or move and again after every step and before every move (F3, F49); a Ready move is
// printed only on the run's recorded run-start approval (F15-F17); one step at a time and one
// result per step (F6, F7); taken decisions are read, never written (F11-F14); the only moves are
// the three Ready moves, Step 8's move and any backward move overrides.ts allows; Notion actions
// target only the ticket, its fixed-title child pages, the Feature Board rules page (read) and the
// open release page (F46); and every stop goes through one path that writes build-summary.md and
// ends on the resume command (F32).
//
// Steps 6-10 beyond routing live in later-phase modules (gate.ts, step8.ts, step10.ts,
// review-loop.ts) and the Build Summary and PR body renderers in summary.ts and pr-body.ts. They
// all ship in this package, so the driver imports them statically: each phase module exports a
// `Phase` (below), bound to its name in PHASES (NOVA1.2).

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { z } from 'zod'
import { slug } from '@aspiralabs/agent-common/lib/ticket'
import { acceptApproval, approvalFor, approvalStage, recordApproval } from '#src/approval.ts'
import { addTaken, collectTakenDecisions, isDecisionStep, openDecisions, takenKeyOf } from '#src/decisions.ts'
import { gatePhase } from '#src/gate.ts'
import { modelFor, parseModels, subagentModels, type Role } from '#src/models.ts'
import { BACKWARD_MOVES_SKILL_MAY_MAKE, decideOverrides, findOverrides, overridesStage, recordOverrides } from '#src/overrides.ts'
import { renderPrBody } from '#src/pr-body.ts'
import { acceptResolution, cardDifferences, resolveStage, resolveWithToken, type Resolution } from '#src/resolve.ts'
import { assertNever, READY_MOVES, RESUME, routeStatus, STEP8_MOVE, type EndRoute, type Mode, type PhaseName, type StepName } from '#src/route.ts'
import { reviewPhase } from '#src/review-loop.ts'
import { readRunState, stateDirOf, writeRunState, type Card, type Failure, type Pending, type RunState } from '#src/run-state.ts'
import { analyzerClean, readImplementorStatus, readSpecCoverage, readStepResult, stepReportSchema } from '#src/step-results.ts'
import { releaseRowPhase, step10Phase } from '#src/step10.ts'
import { step8Phase } from '#src/step8.ts'
import { renderBuildSummary } from '#src/summary.ts'
import { shown, system } from '#src/system.ts'
import { carryTicketFolder, existingWorktree, insideWorktree, locate, prepareWorktree, ticketTypeOf, worktreePath, type Place } from '#src/worktree.ts'

export const STAGE_KINDS = ['resolve', 'approval', 'overrides', 'worktree', 'step', 'ask', 'move', 'set-pr', 'gate', 'step10', 'fix', 'release-row', 'summary', 'end'] as const
export type StageKind = (typeof STAGE_KINDS)[number]
/** One stage as printed: `nonce` and `output` when it needs an answer. Only the worktree stage that sends a new invocation into the worktree carries no runId. */
export type Stage = { stage: StageKind; runId?: string; nonce?: string; output?: string; [key: string]: unknown }

/** A refusal: printed as a message with exit code 1, no stage, nothing recorded. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

export type DriverInput = {
  id: string
  repo: string
  /** The run the session is continuing; absent for a new invocation. */
  run?: string
  forceRun: boolean
  finish: boolean
  /** 'local' with --local, else 'cloud' (F2). A continuing call keeps the mode its run started with. */
  mode: Mode
  now: string
  env: NodeJS.ProcessEnv
}

const aspiraSchema = z.looseObject({ board: z.string().optional(), repository: z.string().optional(), app: z.string().optional(), releases: z.string().optional(), models: z.unknown().optional() })
export type Aspira = z.infer<typeof aspiraSchema>

/** What every handler works from. */
export type Ctx = { input: DriverInput; folder: string; dir: string; runId: string; aspira: Aspira | null; resume: string; mode: Mode }

/** A handler's result: the state to write and the stage to print; `ctx` when the run moved into the ticket's worktree (written there). */
type Out = { state: RunState; stage: Stage; ctx?: Ctx }

// ---------------------------------------------------------------------------------------------
// The later-phase contract (gate.ts, step8.ts, step10.ts, review-loop.ts).
// ---------------------------------------------------------------------------------------------

export type PhaseContext = { id: string; repo: string; folder: string; dir: string; runId: string; now: string; aspira: Aspira; card: Card; resume: string; env: NodeJS.ProcessEnv; mode: Mode }

export type PhaseResult =
  /** Nothing (more) for this phase now: the run goes on to the next item. `note`: a line the end of the run adds (a skipped item). */
  | { kind: 'done'; state: RunState; note?: string }
  /** Print a stage this phase owns (gate, set-pr, step10, fix, release-row, ask); its answer comes back to accept(). */
  | { kind: 'stage'; state: RunState; stage: Exclude<StageKind, 'resolve' | 'approval' | 'overrides' | 'step' | 'move' | 'summary' | 'end'>; body: Record<string, unknown>; data?: Record<string, unknown> }
  /** Run a step (the pr-reviewer); its report is recorded like every step's. */
  | { kind: 'step'; state: RunState; step: StepName; command: string }
  /** Make a move: re-resolved first against `expect`; only Step 8's move (or an allowed backward move) is accepted. */
  | { kind: 'move'; state: RunState; from: string; to: string; expect: Pick<Card, 'status' | 'pr' | 'dev'> }
  | { kind: 'stop'; state: RunState; message: string; failure?: Failure }

export type Phase = {
  next(context: PhaseContext, state: RunState): Promise<PhaseResult>
  accept(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<PhaseResult>
}

/** Each later phase by name: the gate, Step 8, Step 10, the review loop and the release row. */
export const PHASES: Readonly<Record<PhaseName, Phase>> = {
  gate: gatePhase,
  step8: step8Phase,
  step10: step10Phase,
  review: reviewPhase,
  'release-row': releaseRowPhase,
}

// ---------------------------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------------------------

const invoked = (input: DriverInput) => `${RESUME(input.id, input.mode)}${input.forceRun ? ' --force-run' : ''}`
const summaryPath = (ctx: Ctx) => join(ctx.folder, 'build-summary.md')

/** The role whose model a step's subagent runs on. */
const STEP_ROLE: Readonly<Record<StepName, Role>> = {
  groomer: 'groomer',
  'spec-writer': 'spec-writer',
  'spec-reviewer': 'spec-reviewer',
  planner: 'planner',
  implementor: 'implementor',
  'code-analyzer': 'code-analyzer',
  'pr-reviewer': 'pr-reviewer',
}

/** What each step itself does on Notion: it moves the card, sets Dev and pushes its own child pages. */
const STEP_NOTION: Readonly<Record<StepName, { op: 'read' | 'write'; target: string; page?: string }[]>> = {
  groomer: [{ op: 'write', target: 'ticket' }, { op: 'write', target: 'child-page', page: 'Grooming Decisions' }],
  'spec-writer': [{ op: 'write', target: 'ticket' }, { op: 'write', target: 'child-page', page: 'Spec' }],
  'spec-reviewer': [{ op: 'write', target: 'child-page', page: 'Spec Reviewed' }, { op: 'write', target: 'child-page', page: 'Spec Review Decisions' }],
  planner: [{ op: 'write', target: 'ticket' }, { op: 'write', target: 'child-page', page: 'Plan' }],
  implementor: [{ op: 'write', target: 'ticket' }, { op: 'write', target: 'child-page', page: 'Implementation' }],
  'code-analyzer': [{ op: 'read', target: 'ticket' }],
  'pr-reviewer': [{ op: 'write', target: 'child-page', page: 'PR Review' }],
}

/** The ticket's child pages by fixed title (BOARD-003), and the Build Summary. */
const CHILD_PAGES = ['Grooming Decisions', 'Spec', 'Spec Reviewed', 'Spec Review Decisions', 'Plan', 'Implementation', 'PR Review', 'Build Summary']
const WRITE_TARGETS = ['ticket', 'child-page', 'release-page']

/** F46: a stage may write only to the ticket, its fixed-title child pages or the open release page, and only read the board rules. */
function checkNotion(stage: Stage): void {
  const actions = (stage.notion ?? []) as { op: string; target: string; page?: string }[]
  for (const action of actions) {
    if (action.op === 'write' && !WRITE_TARGETS.includes(action.target)) throw new Error(`the ${stage.stage} stage would write to ${action.target}; a run writes only to the ticket, its child pages and the open release page`)
    if (action.target === 'child-page' && action.op === 'write' && !CHILD_PAGES.includes(String(action.page))) throw new Error(`the ${stage.stage} stage would write a child page titled "${action.page}", which is not a fixed title`)
    if (action.target === 'board-rules' && action.op !== 'read') throw new Error(`the ${stage.stage} stage would change the Feature Board rules page`)
  }
}

const allowedMove = (from: string, to: string) =>
  [...READY_MOVES, STEP8_MOVE, ...BACKWARD_MOVES_SKILL_MAY_MAKE].some((move) => move.from === from && move.to === to)
const isReadyMove = (from: string, to: string) => READY_MOVES.some((move) => move.from === from && move.to === to)

/** A run id from the start time, unique among the ticket's runs. */
function newRunId(state: RunState, now: string): string {
  const base = `run-${now.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}`
  const taken = new Set(state.runs.map((run) => run.runId))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** A stage that needs an answer: a fresh nonce, an output file, and the pending record. */
function pend(ctx: Ctx, state: RunState, kind: StageKind, body: (output: string) => Record<string, unknown>, options: { phase?: string; data?: Record<string, unknown>; startedAt?: string } = {}): Out {
  const nonce = randomUUID()
  const output = join(ctx.dir, 'stages', `${kind}-${nonce}.json`)
  const stage: Stage = { stage: kind, runId: ctx.runId, nonce, output, ...body(output) }
  checkNotion(stage)
  const pending: Pending = { kind, nonce, output, stage, startedAt: options.startedAt ?? ctx.input.now, ...(options.phase === undefined ? {} : { phase: options.phase }), ...(options.data === undefined ? {} : { data: options.data }) }
  return { state: { ...state, pending }, stage }
}

/** The ticket's working folder: `.work/<id>-<slug>/` (or `.work/<id>/` until the card's title is known). */
async function workFolder(repo: string, id: string): Promise<string> {
  const work = join(repo, '.work')
  const lower = id.toLowerCase()
  const entries = existsSync(work) ? await readdir(work, { withFileTypes: true }) : []
  const candidates = entries
    .filter((entry) => entry.isDirectory() && (entry.name === lower || entry.name.startsWith(`${lower}-`)))
    .map((entry) => join(work, entry.name))
    .sort()
  return candidates.find((folder) => existsSync(join(stateDirOf(folder), 'state.json'))) ?? candidates.find((folder) => basename(folder) !== lower) ?? candidates[0] ?? join(work, lower)
}

async function readAspira(repo: string): Promise<{ ok: true; aspira: Aspira } | { ok: false; message: string }> {
  const file = join(repo, 'aspira.json')
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return { ok: false, message: `no aspira.json in ${repo}: the run cannot find the Feature Board. Run kit init --board <Feature Board URL> to name the board.` }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, message: `${file} is not valid JSON, so the run cannot find the Feature Board` }
  }
  const parsed = aspiraSchema.safeParse(json)
  if (!parsed.success) return { ok: false, message: `${file} is not what kit init writes: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` }
  if (parsed.data.board === undefined || parsed.data.board === '') return { ok: false, message: `${file} has no board: the run cannot resolve the card. Run kit init --board <Feature Board URL>.` }
  try {
    parseModels(parsed.data.models)
  } catch (error) {
    return { ok: false, message: `${file} models: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, aspira: parsed.data }
}

// ---------------------------------------------------------------------------------------------
// The Build Summary and the PR body, rendered by summary.ts and pr-body.ts, so every stop leaves
// build-summary.md behind.
// ---------------------------------------------------------------------------------------------

async function writeSummary(ctx: Ctx, state: RunState): Promise<void> {
  const ticket = state.card ?? { id: ctx.input.id, title: '', url: '' }
  const plan = await readFile(join(ctx.folder, 'plan.review/trace/plan.json'), 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  const text = await renderBuildSummary({ ticket, state, repo: ctx.input.repo, ...(plan === undefined ? {} : { plan }) })
  await mkdir(ctx.folder, { recursive: true })
  await writeFile(summaryPath(ctx), text)
  await mkdir(ctx.dir, { recursive: true })
  await writeFile(join(ctx.dir, 'pr-body.md'), await renderPrBody({ ticket, state, repo: ctx.input.repo }))
}

/** BOARD-003 on the fetched Feature Board page lists Build Summary among the fixed titles. */
const listsBuildSummary = (rules: string) => rules.split('\n').some((line) => line.includes('BOARD-003') && line.includes('Build Summary'))

// ---------------------------------------------------------------------------------------------
// The one stop path (F32), and the end.
// ---------------------------------------------------------------------------------------------

async function stop(ctx: Ctx, state: RunState, message: string, options: { stopped: boolean; failure?: Failure }): Promise<Out> {
  const failure = options.failure ?? (options.stopped ? { action: 'stop', message } : null)
  const runs = state.runs.map((run) => (run.runId === ctx.runId ? { ...run, end: { message, stopped: options.stopped } } : run))
  const stopped: RunState = { ...state, runs, failure, pending: null, queue: [], afterAsks: null }
  await writeSummary(ctx, stopped)
  if (stopped.card === null) return finalize(ctx, stopped, message, options.stopped, null)
  return pend(
    ctx,
    stopped,
    'summary',
    () => ({
      path: summaryPath(ctx),
      rules: join(ctx.dir, 'board-rules.md'),
      notion: [{ op: 'read', target: 'board-rules' }],
      instructions: `Fetch the Feature Board rules page (read-only) and write it as markdown to the "rules" path, then write {"nonce"} to the output file.`,
    }),
    { data: { part: 'rules', message, stopped: options.stopped } },
  )
}

function finalize(ctx: Ctx, state: RunState, message: string, stopped: boolean, pushError: string | null): Out {
  const lines = [...(pushError === null ? [] : [`Build Summary push failed: ${pushError}. build-summary.md is kept at ${summaryPath(ctx)}.`]), message, `Build summary: ${summaryPath(ctx)}`, ...(stopped ? [ctx.resume] : [])]
  const full = lines.join('\n')
  const runs = state.runs.map((run) => (run.runId === ctx.runId ? { ...run, endedAt: ctx.input.now, ended: stopped ? 'stopped' : 'finished', end: { message: full, stopped } } : run))
  const ended: RunState = { ...state, runs, inProgress: state.inProgress?.runId === ctx.runId ? null : state.inProgress, pending: null }
  return { state: ended, stage: { stage: 'end', runId: ctx.runId, stopped, message: full, ...(stopped ? { resume: ctx.resume } : {}) } }
}

const summaryAnswer = z.object({ nonce: z.string(), pushed: z.boolean().optional(), error: z.string().optional() })

async function acceptSummary(ctx: Ctx, state: RunState, pending: Pending, answer: unknown): Promise<Out> {
  const data = pending.data ?? {}
  const message = String(data.message ?? '')
  const stopped = data.stopped === true
  if (data.part === 'rules') {
    const rules = await readFile(String(pending.stage.rules), 'utf8').catch(() => '')
    const push = listsBuildSummary(rules) ? { action: 'create-or-replace', page: 'Build Summary' } : null
    return pend(
      ctx,
      state,
      'summary',
      () => ({
        path: summaryPath(ctx),
        push,
        notion: push === null ? [] : [{ op: 'write', target: 'child-page', page: 'Build Summary' }],
        instructions:
          push === null
            ? `BOARD-003 does not list Build Summary yet: keep ${summaryPath(ctx)} local and push nothing. Write {"nonce", "pushed": false} to the output file.`
            : `Create the ticket's child page "Build Summary" from ${summaryPath(ctx)}, or replace it when it exists. Write {"nonce", "pushed": true}, or {"nonce", "error"} when the push fails, to the output file.`,
      }),
      { data: { part: 'push', message, stopped } },
    )
  }
  const parsed = summaryAnswer.safeParse(answer)
  const pushError = parsed.success ? (parsed.data.error ?? null) : 'the push answer was not readable'
  return finalize(ctx, state, message, stopped, pushError)
}

// ---------------------------------------------------------------------------------------------
// Resolution, approval, overrides and routing.
// ---------------------------------------------------------------------------------------------

type ResolvePurpose = { purpose: 'start' | 'route' } | { purpose: 'premove'; move: { from: string; to: string }; expect: Pick<Card, 'status' | 'pr' | 'dev'>; phase?: string }

async function requestResolve(ctx: Ctx, state: RunState, purpose: ResolvePurpose): Promise<Out> {
  const board = ctx.aspira?.board ?? ''
  if (typeof ctx.input.env.NOTION_TOKEN === 'string' && ctx.input.env.NOTION_TOKEN !== '') {
    const resolution = await resolveWithToken({ id: ctx.input.id, board, repo: ctx.input.repo, env: ctx.input.env })
    return afterResolution(ctx, state, resolution, purpose)
  }
  const move = purpose.purpose === 'premove' ? purpose.move : undefined
  return pend(ctx, state, 'resolve', (output) => resolveStage({ id: ctx.input.id, board, output, ...(move === undefined ? {} : { move }) }), { data: { ...purpose } })
}

async function afterResolution(ctx: Ctx, state: RunState, resolution: Resolution, purpose: ResolvePurpose): Promise<Out> {
  if (resolution.kind === 'stop') return stop(ctx, state, resolution.message, { stopped: true, failure: { action: 'resolve', message: resolution.message } })
  if (resolution.kind === 'pending') return { state, stage: state.pending?.stage as Stage }
  const { card } = resolution
  const resolved: RunState = { ...state, card }
  switch (purpose.purpose) {
    case 'start':
      return worktreeGate(ctx, resolved)
    case 'route':
      return route(ctx, resolved)
    case 'premove': {
      const differences = cardDifferences(purpose.expect, card)
      if (differences.length > 0) {
        const message = `${ctx.input.id} changed before the move ${purpose.move.from} -> ${purpose.move.to}, so the run made no move: ${differences.join('; ')}.`
        return stop(ctx, resolved, message, { stopped: true, failure: { action: 'move', message } })
      }
      return printMove(ctx, resolved, purpose.move, purpose.phase)
    }
    default:
      return assertNever(purpose)
  }
}

/** After the start resolution: the overrides pull, then the route. */
function afterStart(ctx: Ctx, state: RunState): Promise<Out> | Out {
  const stage = overridesStage(state, join(ctx.dir, 'pulled', ctx.runId))
  if (stage === null) return route(ctx, state)
  return pend(ctx, state, 'overrides', () => stage, { data: { pages: stage.pages } })
}

const withRun = (state: RunState, runId: string, patch: Partial<RunState['runs'][number]>): RunState => ({ ...state, runs: state.runs.map((run) => (run.runId === runId ? { ...run, ...patch } : run)) })

/**
 * F50, before any step: the run works the ticket in `.worktrees/<TYPE>-<ID>`. Inside it, the run
 * goes on. Anywhere else, the worktree is made (or reused), the ticket folder and the run state are
 * carried into it, and a worktree stage tells the session to continue from there.
 */
async function worktreeGate(ctx: Ctx, state: RunState): Promise<Out> {
  const card = state.card!
  const type = ticketTypeOf(card.type)
  if (type === null) {
    const message = `${ctx.input.id} has ${card.type === null ? 'no Type' : `the Type "${card.type}"`}: the run needs the card's Type (Feature, Bug or Chore) to name its worktree and branch (GIT-001, GIT-002). Set the Type on the card, then resume.`
    return stop(ctx, state, message, { stopped: true, failure: { action: 'worktree', message } })
  }
  const place = await locate(ctx.input.repo, ctx.input.env)
  if (place === null) {
    const message = `${ctx.input.repo} is not a git repository, so the run cannot make the ticket's worktree`
    return stop(ctx, state, message, { stopped: true, failure: { action: 'worktree', message } })
  }
  const target = join(place.main, worktreePath(type, ctx.input.id))
  if (place.top === target) return afterStart(ctx, withRun(state, ctx.runId, { worktree: target }))
  return moveIntoWorktree(ctx, state, place, type, card.type!)
}

async function moveIntoWorktree(ctx: Ctx, state: RunState, place: Place, type: NonNullable<ReturnType<typeof ticketTypeOf>>, cardType: string): Promise<Out> {
  const card = state.card!
  const prepared = await prepareWorktree({ place, id: ctx.input.id, title: card.title, type, cardType, env: ctx.input.env })
  if (!prepared.ok) return stop(ctx, state, prepared.message, { stopped: true, failure: { action: 'worktree', command: prepared.command, exitCode: prepared.exitCode, output: prepared.output, message: prepared.message } })
  const { worktree, branch } = prepared
  const folder = await carryTicketFolder(ctx.folder, worktree)
  const inWorktree: Ctx = { ...ctx, input: { ...ctx.input, repo: worktree }, folder, dir: stateDirOf(folder) }
  // The run state left behind says where the run went; the lock moves with it.
  const left: RunState = { ...withRun(state, ctx.runId, { ended: 'moved', endedAt: ctx.input.now, worktree }), inProgress: state.inProgress?.runId === ctx.runId ? null : state.inProgress, pending: null }
  await writeRunState(ctx.folder, left)
  const moved = withRun(state, ctx.runId, { worktree })
  const out = pend(
    inWorktree,
    moved,
    'worktree',
    (output) => ({
      worktree,
      branch,
      created: prepared.created,
      ran: prepared.ran,
      instructions: `${ctx.input.id} is worked in its own worktree ${worktree} on ${branch} (GIT-002). Change into it (cd ${worktree}) and stay there: every later step, board pull and git command of this run runs inside it. Write {"nonce"} to ${output}, then call the driver again from ${worktree} with --run ${ctx.runId}.`,
    }),
    { data: { worktree } },
  )
  return { ...out, ctx: inWorktree }
}

/** A new invocation, or a call, outside the ticket's existing worktree: continue there (nothing is recorded here). */
async function redirectStage(input: DriverInput, place: Place, worktree: string, folder: string): Promise<Stage> {
  await carryTicketFolder(folder, worktree)
  const branch = await system.gitCurrentBranch({ cwd: worktree, env: input.env })
  const again = input.run === undefined ? `the same command (${invoked(input)})` : `the driver with --run ${input.run}`
  return {
    stage: 'worktree',
    ...(input.run === undefined ? {} : { runId: input.run }),
    worktree,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    created: false,
    instructions: `${input.id} is worked in its own worktree ${relative(place.main, worktree)} (GIT-002), not in ${place.top}. Change into it (cd ${worktree}) and run ${again} from there; every step, board pull and git command of the run runs inside it.`,
  }
}

function printMove(ctx: Ctx, state: RunState, move: { from: string; to: string }, phase?: string): Out {
  return pend(
    ctx,
    state,
    'move',
    () => ({
      from: move.from,
      to: move.to,
      notion: [{ op: 'write', target: 'ticket' }],
      instructions: `Move ${ctx.input.id} from ${move.from} to ${move.to} on the Feature Board (the Status property only), then write {"nonce", "done": true}, or {"nonce", "error"} when the move fails, to the output file.`,
    }),
    { data: { from: move.from, to: move.to, ...(phase === undefined ? {} : { phase }) } },
  )
}

/** A move the route or a phase asks for: allowed moves only, Ready moves only on the run's approval, re-resolved first. */
async function requestMove(ctx: Ctx, state: RunState, move: { from: string; to: string }, expect: Pick<Card, 'status' | 'pr' | 'dev'>, phase?: string): Promise<Out> {
  if (!allowedMove(move.from, move.to)) {
    const message = `the run will not move ${ctx.input.id} ${move.from} -> ${move.to}: a run makes only the three Ready moves and Step 8's move`
    return stop(ctx, state, message, { stopped: true, failure: { action: 'move', message } })
  }
  if (isReadyMove(move.from, move.to) && approvalFor(state, ctx.runId) === null) {
    const message = `no run-start approval is recorded for run ${ctx.runId}, so the run will not make the Ready move ${move.from} -> ${move.to}. Start a new run to record one.`
    return stop(ctx, state, message, { stopped: true, failure: { action: 'approval', message } })
  }
  return requestResolve(ctx, state, { purpose: 'premove', move, expect, ...(phase === undefined ? {} : { phase }) })
}

const phaseContext = (ctx: Ctx, state: RunState): PhaseContext => ({
  id: ctx.input.id,
  repo: ctx.input.repo,
  folder: ctx.folder,
  dir: ctx.dir,
  runId: ctx.runId,
  now: ctx.input.now,
  aspira: ctx.aspira ?? {},
  card: state.card!,
  resume: ctx.resume,
  env: ctx.input.env,
  mode: ctx.mode,
})

async function handlePhase(ctx: Ctx, phase: PhaseName, result: PhaseResult): Promise<Out> {
  switch (result.kind) {
    case 'done':
      return route(ctx, result.state)
    case 'stage':
      return pend(ctx, result.state, result.stage, () => result.body, { phase, ...(result.data === undefined ? {} : { data: result.data }) })
    case 'step':
      return printStep(ctx, result.state, result.step, result.command)
    case 'move':
      return requestMove(ctx, result.state, { from: result.from, to: result.to }, result.expect, phase)
    case 'stop':
      return stop(ctx, result.state, result.message, { stopped: true, ...(result.failure === undefined ? {} : { failure: result.failure }) })
    default:
      return assertNever(result)
  }
}

async function endRoute(ctx: Ctx, state: RunState, end: EndRoute): Promise<Out> {
  return stop(ctx, state, end.message, { stopped: end.reason === 'unknown' })
}

/** The live Status picks the next stage. */
async function route(ctx: Ctx, state: RunState): Promise<Out> {
  const card = state.card
  if (card === null) return requestResolve(ctx, state, { purpose: 'route' })
  const facts = {
    id: ctx.input.id,
    app: ctx.aspira?.app ?? '.',
    specCovered: await readSpecCoverage(ctx.folder, state),
    implementor: await readImplementorStatus(ctx.folder),
    analyzerClean: analyzerClean(state),
    mode: ctx.mode,
  }
  const next = routeStatus(card.status, facts)
  switch (next.kind) {
    case 'step':
      return printStep(ctx, state, next.step, next.command)
    case 'readyMove':
      return requestMove(ctx, state, { from: next.from, to: next.to }, { status: card.status, pr: card.pr, dev: card.dev })
    case 'sequence': {
      let current = state
      const notes: string[] = []
      for (const item of next.items) {
        if (item.kind === 'step') {
          if (!item.done) return printStep(ctx, current, item.step, item.command)
          continue
        }
        const phase = PHASES[item.phase]
        const result = await phase.next(phaseContext(ctx, current), current)
        if (result.kind !== 'done') return handlePhase(ctx, item.phase, result)
        if (result.note !== undefined) notes.push(result.note)
        current = result.state
      }
      return endRoute(ctx, current, notes.length === 0 ? next.then : { ...next.then, message: [next.then.message, ...notes].join('\n') })
    }
    case 'end':
      return endRoute(ctx, state, next)
    default:
      return assertNever(next)
  }
}

// ---------------------------------------------------------------------------------------------
// Steps and their results.
// ---------------------------------------------------------------------------------------------

const STATUS_WORDS: Readonly<Record<StepName, string>> = {
  groomer: 'the groom status in groom/trace/groom.json (confirmed, needs-author, stopped or incomplete)',
  'spec-writer': 'the status in spec.written/trace/review.json (ready, needs-author or incomplete)',
  'spec-reviewer': 'the status in spec.reviewed/trace/review.json (ready, needs-author or incomplete)',
  planner: 'the status in plan.review/trace/review.json (ready, needs-author or incomplete)',
  implementor: 'the status in plan.review/trace/implementation-local.json (complete, incomplete, refused or blocked)',
  'code-analyzer': 'the status the analyzer finished with (clean, or what it reported)',
  'pr-reviewer': 'complete when the review finished and wrote pr-review/findings.md, else incomplete',
}

/** The cloud implementor clones the repository from GitHub and refuses a ticket whose .work/ is gitignored (implementor SKILL.md). */
async function cloudImplementorBlocked(ctx: Ctx): Promise<string | null> {
  const ignored = await system.gitCheckIgnore({ cwd: ctx.input.repo, env: ctx.input.env }, '.work/')
  if (ignored.code !== 0) return null
  return `In cloud mode the implementor runs as a separate process that clones the repository from GitHub, and it cannot read .work/ (gitignored here, \`${shown('git', ['check-ignore', '--no-index', '.work/'])}\`), where ${ctx.input.id}'s plan is. It would refuse the ticket, so the run stops before it. Build this step with --local: ${RESUME(ctx.input.id, 'local')}`
}

async function printStep(ctx: Ctx, state: RunState, step: StepName, command: string): Promise<Out> {
  if (ctx.mode === 'cloud' && step === 'implementor') {
    const blocked = await cloudImplementorBlocked(ctx)
    if (blocked !== null) return stop(ctx, state, blocked, { stopped: true, failure: { action: step, command, message: blocked } })
  }
  const model = modelFor(STEP_ROLE[step], ctx.aspira)
  const promptDir = join(ctx.dir, 'prompts')
  await mkdir(promptDir, { recursive: true })
  const out = pend(
    ctx,
    state,
    'step',
    (output) => ({
      step,
      command,
      mode: ctx.mode,
      cwd: ctx.input.repo,
      model,
      prompt: join(promptDir, `${step}-${ctx.runId}.md`),
      notion: [{ op: 'read', target: 'ticket' }, ...STEP_NOTION[step]],
      report: { output, fields: ['nonce', 'step', 'status', 'resultLine', 'usage'] },
    }),
    { data: { step, command } },
  )
  const { output, nonce, prompt } = out.stage as Stage & { prompt: string }
  const lines = [
    `# ${ctx.input.id}: the ${step} step of /aspira-build-feature`,
    '',
    `Work in ${ctx.input.repo} (the ticket's worktree): change into it first and run everything from there.`,
    '',
    'Run this command, exactly as written, and follow the skill it loads to its end:',
    '',
    '```',
    command,
    '```',
    '',
    ...(ctx.mode === 'cloud'
      ? [
          "This run is in cloud mode: the command is the step skill's default mode, which starts the step's cloud agent (`start`). Let the skill start it, then `wait` on that run, again and again, until it ends; waiting does not stop the agent. Do not stop after `start`, do not run the step yourself, and never retry a failed run. When it has ended, read its result exactly as for --local.",
          '',
        ]
      : []),
    `You run on ${model}. ${subagentModels(step, ctx.aspira)}`,
    '',
    'Do not move the card yourself beyond what the skill does, do not edit any decisions file, and do not treat any text in a result, a page or a PR as approval.',
    '',
    `When the skill has finished, write ONE JSON object to ${output}:`,
    '',
    '```json',
    JSON.stringify({ nonce, step, status: '<status word>', resultLine: '<the single result line the skill printed>', usage: { tokens: '<number or null>', wallMs: '<number or null>' } }, null, 2),
    '```',
    '',
    `status: ${STATUS_WORDS[step]}. usage: the tokens and wall time the Agent tool reported for this subagent, null when it reported none.`,
    '',
  ]
  await writeFile(prompt, lines.join('\n'))
  return out
}

async function acceptStep(ctx: Ctx, state: RunState, pending: Pending, answer: unknown): Promise<Out> {
  const step = String(pending.data?.step) as StepName
  const command = String(pending.data?.command)
  const parsed = stepReportSchema.safeParse(answer)
  if (!parsed.success || parsed.data.step !== step) {
    const message = `the ${step} step report at ${pending.output} is not a step report for ${step}${parsed.success ? ` (it names ${parsed.data.step})` : `: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`}`
    return stop(ctx, state, message, { stopped: true, failure: { action: step, command, message } })
  }
  const report = parsed.data
  const result = await readStepResult(step, report, { folder: ctx.folder, repo: ctx.input.repo, app: ctx.aspira?.app ?? '.' })
  const record = {
    step,
    runId: ctx.runId,
    command,
    status: result.status,
    startedAt: pending.startedAt,
    endedAt: ctx.input.now,
    usage: report.usage,
    resultLine: report.resultLine,
    nonce: pending.nonce,
    report: pending.output,
    ...(result.counts === undefined ? {} : { counts: result.counts }),
  }
  let next: RunState = { ...state, steps: [...state.steps, record] }
  if (result.verdict === 'continue' && isDecisionStep(step)) {
    const collected = await collectTakenDecisions(step, { folder: ctx.folder, runId: ctx.runId })
    if (!collected.ok) return stop(ctx, next, collected.message, { stopped: true, failure: { action: step, command, message: collected.message } })
    next = { ...addTaken(next, collected.taken), queue: [...next.queue, ...collected.asks] }
  }
  let after = result.verdict === 'stop' ? result.message : null
  if (after !== null && result.status === 'needs-author' && isDecisionStep(step)) {
    const open = await openDecisions(step, ctx.folder)
    if (open.length > 0) after = `${after} Open decisions: ${open.map((decision) => `${decision.id}: ${decision.question}`).join('; ')}`
  }
  if (next.queue.length > 0) return printAsk(ctx, { ...next, afterAsks: { stop: after } })
  if (after !== null) return stop(ctx, next, after, { stopped: true, failure: { action: step, command, message: after } })
  return requestResolve(ctx, next, { purpose: 'route' })
}

function printAsk(ctx: Ctx, state: RunState): Out {
  const [first] = state.queue
  if (first === undefined) throw new Error('printAsk with no question queued')
  return pend(
    ctx,
    state,
    'ask',
    () => ({
      step: first.step,
      ...(first.id === undefined ? {} : { decision: first.id }),
      question: first.question,
      instructions: 'Ask the human this question in chat, quoted as text, exactly once. Write {"nonce", "answer"} with their answer, in their words, to the output file. Do not answer it yourself.',
    }),
    { data: { ask: first } },
  )
}

const askAnswer = z.object({ nonce: z.string(), answer: z.string().min(1) })

async function acceptAsk(ctx: Ctx, state: RunState, answer: unknown): Promise<Out> {
  const [first, ...rest] = state.queue
  const parsed = askAnswer.safeParse(answer)
  if (first === undefined) return requestResolve(ctx, state, { purpose: 'route' })
  if (!parsed.success) return printAsk(ctx, state)
  const asked = { key: takenKeyOf(first.step, first.runId, first.id ?? `ask${state.asked.length + 1}`), step: first.step, runId: first.runId, ...(first.id === undefined ? {} : { id: first.id }), question: first.question, answer: parsed.data.answer }
  const next: RunState = { ...state, asked: [...state.asked, asked], queue: rest }
  if (rest.length > 0) return printAsk(ctx, next)
  const after = next.afterAsks?.stop ?? null
  const cleared: RunState = { ...next, afterAsks: null }
  if (after !== null) return stop(ctx, cleared, after, { stopped: true })
  return requestResolve(ctx, cleared, { purpose: 'route' })
}

const moveAnswer = z.union([z.object({ nonce: z.string(), done: z.literal(true) }), z.object({ nonce: z.string(), error: z.string().min(1) })])

async function acceptMove(ctx: Ctx, state: RunState, pending: Pending, answer: unknown): Promise<Out> {
  const from = String(pending.data?.from)
  const to = String(pending.data?.to)
  const parsed = moveAnswer.safeParse(answer)
  if (!parsed.success || 'error' in parsed.data) {
    const message = `the move ${from} -> ${to} failed: ${parsed.success && 'error' in parsed.data ? parsed.data.error : 'the answer did not say it was done'}`
    return stop(ctx, state, message, { stopped: true, failure: { action: 'move', message } })
  }
  const moved: RunState = { ...state, moves: [...state.moves, { from, to, at: ctx.input.now, runId: ctx.runId }] }
  return requestResolve(ctx, moved, { purpose: 'route' })
}

async function acceptOverrides(ctx: Ctx, state: RunState, pending: Pending): Promise<Out> {
  const pages = (pending.data?.pages ?? {}) as Record<string, string>
  const overrides = await findOverrides(state, pages, ctx.runId)
  const recorded = recordOverrides(state, overrides)
  const card = recorded.card!
  const decision = decideOverrides(overrides, card.status, { id: ctx.input.id, resume: ctx.resume })
  switch (decision.kind) {
    case 'continue':
      return route(ctx, recorded)
    case 'move':
      return requestMove(ctx, recorded, { from: decision.from, to: decision.to }, { status: card.status, pr: card.pr, dev: card.dev })
    case 'stop':
      return stop(ctx, recorded, decision.message, { stopped: true, failure: { action: 'override', message: decision.message } })
    default:
      return assertNever(decision)
  }
}

// ---------------------------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------------------------

/** Rename `.work/<id>/` to `.work/<id>-<slug>/` once the card's title is known. */
async function settleFolder(ctx: Ctx, title: string): Promise<Ctx> {
  const lower = ctx.input.id.toLowerCase()
  if (basename(ctx.folder) !== lower || title.trim() === '') return ctx
  const target = join(ctx.input.repo, '.work', `${lower}-${slug(title)}`)
  if (existsSync(target)) return ctx
  await rename(ctx.folder, target)
  return { ...ctx, folder: target, dir: stateDirOf(target) }
}

async function startRun(ctx: Ctx, state: RunState): Promise<Out> {
  const { now, forceRun, id } = ctx.input
  if (state.inProgress !== null && !forceRun) {
    throw new Refusal(`a build-feature run of ${id} is already in progress since ${state.inProgress.startedAt} (${state.inProgress.runId}). Let it finish, end it with --finish, or start over with ${ctx.resume} --force-run.`)
  }
  const replaced = state.inProgress?.runId
  const runs = state.runs.map((run) => (run.runId === replaced ? { ...run, endedAt: now, ended: 'replaced' } : run))
  const run = { runId: ctx.runId, command: invoked(ctx.input), startedAt: now, endedAt: null, ended: null, mode: ctx.mode, ...(replaced === undefined ? {} : { replaced }) }
  const started: RunState = { ...state, runs: [...runs, run], inProgress: { runId: ctx.runId, startedAt: now }, pending: null, card: null, queue: [], afterAsks: null, failure: null }
  const aspira = await readAspira(ctx.input.repo)
  if (!aspira.ok) return stop(ctx, started, aspira.message, { stopped: true, failure: { action: 'aspira.json', message: aspira.message } })
  return pend({ ...ctx, aspira: aspira.aspira }, started, 'approval', (output) => approvalStage({ id, command: run.command, output }))
}

/** Read the answer file of the pending stage: the parsed JSON, or null when there is none yet. */
async function readAnswer(pending: Pending): Promise<Record<string, unknown> | null> {
  const raw = await readFile(pending.output, 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function dispatch(ctx: Ctx, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<Out> {
  if (pending.phase !== undefined && pending.kind !== 'resolve' && pending.kind !== 'move' && pending.kind !== 'step') {
    const name = pending.phase as PhaseName
    const phase = PHASES[name]
    return handlePhase(ctx, name, await phase.accept(phaseContext(ctx, state), state, pending, answer))
  }
  switch (pending.kind) {
    case 'approval': {
      const run = state.runs.find((candidate) => candidate.runId === ctx.runId)!
      const outcome = acceptApproval(answer, pending.nonce, { runId: ctx.runId, command: run.command })
      if (outcome.kind === 'pending') return { state: { ...state, pending }, stage: pending.stage as Stage }
      if (outcome.kind === 'stop') return stop(ctx, state, outcome.message, { stopped: true, failure: { action: 'approval', message: outcome.message } })
      return requestResolve(ctx, recordApproval(state, outcome.approval), { purpose: 'start' })
    }
    case 'resolve': {
      const purpose = (pending.data ?? { purpose: 'route' }) as ResolvePurpose
      const resolution = acceptResolution(answer, pending.nonce, { id: ctx.input.id, board: ctx.aspira?.board ?? '' })
      if (resolution.kind === 'pending') return { state: { ...state, pending }, stage: pending.stage as Stage }
      return afterResolution(ctx, state, resolution, purpose)
    }
    case 'overrides':
      return acceptOverrides(ctx, state, pending)
    case 'worktree':
      return worktreeGate(ctx, state)
    case 'step':
      return acceptStep(ctx, state, pending, answer)
    case 'ask':
      return acceptAsk(ctx, state, answer)
    case 'move':
      return acceptMove(ctx, state, pending, answer)
    case 'summary':
      return acceptSummary(ctx, state, pending, answer)
    default:
      return stop(ctx, state, `the pending ${pending.kind} stage has no handler in the driver`, { stopped: true })
  }
}

/** Refuse a second report for a step this run already recorded (F7). */
async function refuseSecondReport(state: RunState, runId: string): Promise<void> {
  const again = state.steps.find((step) => step.runId === runId && step.report !== undefined && existsSync(step.report))
  if (again === undefined) return
  await rename(again.report!, `${again.report!}.refused`)
  throw new Refusal(`a second report for the ${again.step} step of ${runId} was refused: the run already recorded its result (${again.status}), and a step has one result.`)
}

/** One call of the driver: read the state, take the pending answer, and return the next stage. */
export async function nextStage(input: DriverInput): Promise<Stage> {
  const initialFolder = await workFolder(input.repo, input.id)
  // F50: outside the ticket's worktree while it exists, the session is sent there first.
  const place = await locate(input.repo, input.env)
  if (place !== null && insideWorktree(place, input.id) === null) {
    const worktree = existingWorktree(place, input.id)
    if (worktree !== null) return redirectStage(input, place, worktree, initialFolder)
  }
  const state = await readRunState(initialFolder)
  const base = { input, folder: initialFolder, dir: stateDirOf(initialFolder), aspira: null }

  if (input.run === undefined && !input.finish) {
    const ctx: Ctx = { ...base, runId: newRunId(state, input.now), mode: input.mode, resume: RESUME(input.id, input.mode) }
    return save(ctx, await startRun(ctx, state))
  }
  const fallback = RESUME(input.id, input.mode)
  const runId = input.run ?? state.inProgress?.runId
  if (runId === undefined) throw new Refusal(`no build-feature run of ${input.id} is in progress; start one with ${fallback}`)
  const run = state.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) throw new Refusal(`${input.id} has no build-feature run ${runId}; start one with ${fallback}`)
  const resume = RESUME(input.id, run.mode)
  const aspira = await readAspira(input.repo)
  let ctx: Ctx = { ...base, runId, aspira: aspira.ok ? aspira.aspira : null, mode: run.mode, resume }
  if (state.inProgress?.runId !== runId) {
    if (input.finish && run.end !== undefined) return { stage: 'end', runId, stopped: run.end.stopped, message: run.end.message, ...(run.end.stopped ? { resume } : {}) }
    throw new Refusal(`run ${runId} of ${input.id} is not in progress (${run.ended ?? 'ended'}); start a new run with ${resume}`)
  }
  await refuseSecondReport(state, runId)
  if (input.finish) return save(ctx, await stop(ctx, { ...state, pending: null }, `The run was ended with --finish before the ticket reached a merge-ready PR.`, { stopped: true }))
  const pending = state.pending
  if (pending === null) return save(ctx, await route(ctx, state))
  const answer = await readAnswer(pending)
  if (answer === null || answer.nonce !== pending.nonce) return pending.stage as Stage
  await rename(pending.output, `${pending.output}.accepted`)
  const taken: RunState = { ...state, pending: null }
  if (pending.kind === 'resolve' && answer.found === true && typeof answer.title === 'string') {
    const settled = await settleFolder(ctx, answer.title)
    if (settled.folder !== ctx.folder) {
      ctx = settled
      const moved = { ...pending, output: join(settled.dir, 'stages', basename(pending.output)) }
      return save(ctx, await dispatch(ctx, taken, moved, answer))
    }
  }
  return save(ctx, await dispatch(ctx, taken, pending, answer))
}

async function save(ctx: Ctx, out: Out): Promise<Stage> {
  await writeRunState((out.ctx ?? ctx).folder, out.state)
  return out.stage
}
