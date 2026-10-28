// The live Status picks what the run does next, through the Playbook's own table
// (@aspiralabs/ai/playbook): a step (the row's command with the ID filled in), a Ready move for
// the rows a human used to do by hand, the later phases (visual verify, gate, Step 8, Step 10, the review loop,
// the release row), or the end of the run. What the rows cannot say is decided here, from facts
// the driver reads: whether a review covers the current spec.md, what the implementor's last
// result was, and whether the analyzer finished clean.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readGroomRecord } from '@aspiralabs/ai/common/lib/groom-record'
import { readRunStatus } from '@aspiralabs/ai/common/lib/run-status'
import { currentApproval, type ApprovableStep } from '@aspiralabs/ai/common/lib/author-approval'
import { commandFor, nextStep } from '@aspiralabs/ai/playbook'
import { emptyRunState, readRunState, type RunState } from '#build-feature/run-state.ts'
import { analyzedApps, analyzerReady, readImplementorApps } from '#build-feature/step-results.ts'

/** The steps, in Playbook order. */
export const STEPS = ['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const
export type StepName = (typeof STEPS)[number]
export const isStep = (value: string): value is StepName => (STEPS as readonly string[]).includes(value)

/**
 * The steps the run passes --take-recommended to in the default mode: an agent decision never stops the
 * run. Their cloud modes refuse the flag ("--take-recommended only applies to local"), so
 * a cloud run passes nothing and a needs-author result stops it, naming the open decisions.
 */
export const TAKE_RECOMMENDED: readonly StepName[] = ['groomer', 'spec-writer', 'planner']

/**
 * How the run runs each step (F2, Q10 revised; KIT-51): 'local', the default, runs the step skill in this
 * session; 'cloud' (--cloud) runs the step skill with --cloud, which starts the step's cloud agent and waits on it.
 */
export const MODES = ['local', 'cloud'] as const
export type Mode = (typeof MODES)[number]

/** The command that resumes a run: `/aspira-build-feature <ID>`, with --cloud in cloud mode and --autonomous when the run skips the human gates (KIT-24). */
export const RESUME = (id: string, mode: Mode = 'local', autonomous = false): string => `/aspira-build-feature ${id}${mode === 'cloud' ? ' --cloud' : ''}${autonomous ? ' --autonomous' : ''}`

/** The line the Build Summary gives the mode. */
export const modeLine = (mode: Mode, autonomous = false): string =>
  mode === 'local'
    ? `Mode: in this session (the default: every step ran its skill in this session)${autonomous ? ' and --autonomous (no human gate: the groomer took every question as recommended and confirmed itself; an ask with a recommended option was answered with it)' : ''}`
    : "Mode: --cloud (every step ran its skill with --cloud: the step's own agent, started and waited on)"

/** The later-phase modules, in run order. */
export const PHASES = ['visual-verify', 'gate', 'step8', 'step10', 'review', 'release-row', 'merge'] as const
export type PhaseName = (typeof PHASES)[number]

/** The Ready moves a human used to make by hand, which the run makes on its run-start approval (F15, F16). */
export const READY_MOVES: readonly { from: string; to: string }[] = [
  { from: 'Shortlist', to: 'Ready: Idea' },
  { from: 'In Review: Spec', to: 'Ready: Spec' },
  { from: 'In Review: Plan', to: 'Ready: Plan' },
]

/**
 * The success move of a step the author approved by hand (KIT-83: `--approve <step>`): the move the step's
 * own ready run would have made, made only while an author approval covers the step's output as it is now.
 */
export const APPROVAL_MOVES: readonly { step: ApprovableStep; from: string; to: string }[] = [
  { step: 'spec-writer', from: 'In Progress: Spec', to: 'In Review: Spec' },
  { step: 'planner', from: 'In Progress: Plan', to: 'In Review: Plan' },
]

/** The move after the run merged the PR itself (BOARD-004 as revised 2026-10-23), on its run-start approval. */
export const MERGE_MOVE = { from: 'In Review: Implementation', to: 'Ready: Implementation' } as const

/** The one move Step 8 makes, after the PR property reads back (BOARD-005). */
export const STEP8_MOVE = { from: 'In Progress: Implementation', to: 'In Review: Implementation' } as const

export type StepRoute = { kind: 'step'; step: StepName; command: string; launcher: string[] }
export type SequenceItem = { kind: 'phase'; phase: PhaseName } | (StepRoute & { done: boolean })
export type EndRoute = { kind: 'end'; reason: 'nothing-to-do' | 'dropped' | 'unknown' | 'unsettled' | 'finished'; message: string }

export type Route =
  | StepRoute
  | { kind: 'readyMove'; from: string; to: string }
  /** A step's success move on the author's approval of its output (KIT-83). */
  | { kind: 'approvedMove'; step: ApprovableStep; from: string; to: string }
  /** Walk the items in order: a phase decides itself whether it has work left; a step runs unless done. */
  | { kind: 'sequence'; items: SequenceItem[]; then: EndRoute }
  | EndRoute

export type RouteFacts = {
  id: string
  /** aspira.json `app`, or '.' (A2). */
  app: string
  /** In Review: Spec: a ready spec step export (spec.reviewed/) covers the current spec.md (A6, KIT-48). */
  specCovered: boolean
  /** In Review: Plan: the planner's last export is ready with no open decision (KIT-87); absent, false. */
  planCovered?: boolean
  /** The steps whose output, as it is now, the author approved with --approve (KIT-83). */
  approved?: readonly ApprovableStep[]
  /** The implementor's last exported status (implementation-local.json), read through readRunStatus, or null. */
  implementor: string | null
  /** The code-analyzer finished ready after the last build. */
  analyzerReady: boolean
  /** The app directories the build changed, each analyzed on its own (KIT-39); absent or empty: `app` alone. */
  apps?: string[]
  /** Which of `apps` the analyzer has finished ready since the last build. */
  analyzed?: string[]
  /** How each step runs. Default 'local' (in this session); 'cloud' with --cloud. */
  mode?: Mode
  /** --autonomous (KIT-24): the groomer runs with --autonomous, in the default mode only. */
  autonomous?: boolean
  /** This ticket's PR was merged by a build-feature run (state.phases.merge). */
  merged?: boolean
}

/** The end of an exhaustive switch over a union (TS-008). */
export const assertNever = (value: never): never => {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`)
}

const stepOf = (command: string): StepName => {
  const name = /^\/aspira-([a-z-]+)\s/.exec(command)?.[1] ?? ''
  if (!isStep(name)) throw new Error(`the Playbook command "${command}" names no step the run knows`)
  return name
}

/** One launcher command line: the step's own script, the subcommand (`local`, `start`, `wait`) and its arguments. */
const launcherLine = (step: StepName, sub: 'local' | 'start' | 'wait', args: string): string => `~/.claude/skills/aspira-${step}/scripts/${step}.sh ${sub} ${args}`.trim()

/**
 * `command`'s launcher form (F44): the step's own script instead of the slash command, so a
 * subagent runs its launcher script directly instead of the Skill tool. Local: `.sh local <args>`.
 * Cloud: `.sh start <args>` then `.sh wait <RUN>`. The mode flag (--cloud, or a legacy --local) is
 * dropped either way: the subcommand carries the mode.
 * Exported so a caller holding only a command string (the review loop's own re-review command,
 * which stepCommand never builds) can still get its launcher form, with the same algorithm.
 */
export function launcherFor(command: string, mode: Mode): string[] {
  const step = stepOf(command)
  const args = command.split(' ').slice(1).filter((word) => word !== '--local' && word !== '--cloud').join(' ')
  if (mode === 'cloud') return [launcherLine(step, 'start', args), launcherLine(step, 'wait', '<RUN>')]
  return [launcherLine(step, 'local', args)]
}

/**
 * A row's command as the run invokes it: ID filled, <app-dir> filled; in the default mode the row's
 * command plus --take-recommended where it applies, in cloud mode the same command with --cloud.
 */
export function stepCommand(status: string, facts: Pick<RouteFacts, 'id' | 'app' | 'mode' | 'autonomous'>): StepRoute {
  const row = nextStep(status)
  const filled = row === null ? null : commandFor(row, facts.id)
  if (filled === null) throw new Error(`the Playbook row for ${status} has no command`)
  const command = filled.replaceAll('<app-dir>', facts.app)
  const step = stepOf(command)
  const mode = facts.mode ?? 'local'
  if (mode === 'cloud') {
    const cloudCommand = `${command.split(' ').filter((word) => word !== '--local' && word !== '--cloud').join(' ')} --cloud`
    return { kind: 'step', step, command: cloudCommand, launcher: launcherFor(cloudCommand, mode) }
  }
  const taken = TAKE_RECOMMENDED.includes(step) ? `${command} --take-recommended` : command
  // --autonomous (KIT-24): only the groomer has a chat gate of its own (exit-criterion questions and Confirm).
  const localCommand = facts.autonomous === true && step === 'groomer' ? `${taken} --autonomous` : taken
  return { kind: 'step', step, command: localCommand, launcher: launcherFor(localCommand, mode) }
}

/** The app directories the analyzer runs on: the ones the build changed, else aspira.json's app (KIT-39). */
export const analyzerApps = (facts: Pick<RouteFacts, 'app' | 'apps'>): string[] => (facts.apps?.length ? facts.apps : [facts.app])

/** One analyzer step per app directory the build changed (KIT-39), each done when its own run ended ready since the last build. */
function analyzerSteps(facts: RouteFacts): (StepRoute & { done: boolean })[] {
  return analyzerApps(facts).map((app) => ({ ...stepCommand('In Progress: Implementation', { ...facts, app }), done: facts.apps?.length ? (facts.analyzed ?? []).includes(app) : facts.analyzerReady }))
}

/** What the run does for a live Status. */
export function routeStatus(status: string, facts: RouteFacts): Route {
  const row = nextStep(status)
  const named = row?.statuses.find((candidate) => candidate.toLowerCase() === status.trim().toLowerCase())
  if (row === null || named === undefined) return { kind: 'end', reason: 'unknown', message: `unknown Status "${status}" for ${facts.id}: the Playbook has no row for it, so the run cannot pick a step` }
  switch (named) {
    case 'Idea':
    case 'Grooming':
    case 'Ready: Idea':
    case 'Ready: Spec':
    case 'Ready: Plan':
      return stepCommand(named, facts)
    case 'In Progress: Spec':
    case 'In Progress: Plan': {
      // A step the author approved by hand (KIT-83) makes its success move instead of running again.
      const approved = APPROVAL_MOVES.find((move) => move.from === named && (facts.approved ?? []).includes(move.step))
      return approved === undefined ? stepCommand(named, facts) : { kind: 'approvedMove', ...approved }
    }
    case 'Shortlist':
      return { kind: 'readyMove', from: 'Shortlist', to: 'Ready: Idea' }
    case 'In Review: Spec':
      // The one spec step reruns from here on the answered spec (KIT-48); a ready export that covers spec.md, or the author's approval, moves the card on.
      return facts.specCovered || (facts.approved ?? []).includes('spec-writer') ? { kind: 'readyMove', from: 'In Review: Spec', to: 'Ready: Spec' } : stepCommand(named, facts)
    case 'In Review: Plan':
      // The planner reruns from here on the answered decisions (KIT-87), with In Progress: Plan's command (this row has none); a ready plan with no open decision, or the author's approval, moves the card on.
      return facts.planCovered === true || (facts.approved ?? []).includes('planner') ? { kind: 'readyMove', from: 'In Review: Plan', to: 'Ready: Plan' } : stepCommand('In Progress: Plan', facts)
    case 'In Progress: Implementation': {
      if (facts.implementor !== 'ready') return stepCommand('Ready: Plan', facts)
      return {
        kind: 'sequence',
        items: [{ kind: 'phase', phase: 'visual-verify' }, { kind: 'phase', phase: 'gate' }, ...analyzerSteps(facts), { kind: 'phase', phase: 'step8' }],
        then: { kind: 'end', reason: 'unsettled', message: `${facts.id} is still in In Progress: Implementation after Step 8; resolve it again` },
      }
    }
    case 'In Review: Implementation': {
      // A card that reached In Review without the gate and a clean analyzer run on its last build (moved by
      // hand after a stop, or by the cloud implementor's own PR) gets both here first; Step 8 then commits and
      // pushes the analyzer's fixes on the open PR (NOM-38: the run went straight from the build to the review).
      const steps = analyzerSteps(facts)
      // Step 8 stays in the sequence: it does nothing once the last analyzer result is committed.
      const late: SequenceItem[] = facts.implementor === 'ready' && steps.some((step) => !step.done) ? [{ kind: 'phase', phase: 'gate' }, ...steps] : []
      return {
        kind: 'sequence',
        items: [
          ...late,
          { kind: 'phase', phase: 'step8' },
          { kind: 'phase', phase: 'step10' },
          { kind: 'phase', phase: 'review' },
          { kind: 'phase', phase: 'release-row' },
          { kind: 'phase', phase: 'merge' },
        ],
        then: { kind: 'end', reason: 'unsettled', message: `${facts.id} is still in In Review: Implementation after the merge; resolve it again` },
      }
    }
    case 'Ready: Implementation':
      if (facts.merged === true) return { kind: 'end', reason: 'finished', message: `${facts.id}: the review left nothing medium or above, the run merged the PR and moved the card to Ready: Implementation` }
      return { kind: 'end', reason: 'nothing-to-do', message: `nothing to do: ${facts.id} is in ${named}; ${row.step}` }
    case 'Released':
      return { kind: 'end', reason: 'nothing-to-do', message: `nothing to do: ${facts.id} is in ${named}; ${row.step}` }
    case 'Dropped':
      return { kind: 'end', reason: 'dropped', message: `ticket is dropped: ${facts.id} is in Dropped and is not being built` }
    default:
      return { kind: 'end', reason: 'unknown', message: `unknown Status "${status}" for ${facts.id}: the run has no route for it` }
  }
}

/** The stages a run with `statusFlow: false` walks, in order (KIT-68, F6). */
export type RunStage = 'groom' | 'spec' | 'plan' | 'implement' | 'review' | 'finished'

export type RunStateRoute = {
  stage: RunStage
  route: Route
  /** The spec rerun's input files, relative to the folder: the reviewed spec, then spec.md. */
  input?: string[]
  /** Blocking follow-ups of a confirmed grooming: the run ends needs-author listing them. */
  needsAuthor?: { id: string; question: string }[]
}

const SPEC_REVIEWED = 'spec.reviewed/spec.reviewed.md'
const PLAN_FILE = 'plan.review/trace/plan.json'

/**
 * With `statusFlow: false` the card's Status carries nothing, so the next stage comes from the files in the ticket
 * folder: a stage is done when its own output says so, and the first stage not done is next. An upstream output
 * edited later never moves the route back. Each step stage uses the Playbook row of the Status it maps to; the
 * implement and review walks join in one sequence that has no Step 8 push or PR, no release row and no merge.
 */
export async function routeRunState(folder: string, facts: Pick<RouteFacts, 'id' | 'app' | 'mode' | 'autonomous'>): Promise<RunStateRoute> {
  const state: RunState = await readRunState(folder).catch(() => emptyRunState())
  const has = (file: string): boolean => existsSync(join(folder, file))
  const lastReady = (step: StepName): boolean | null => {
    const last = state.steps.findLast((candidate) => candidate.step === step)
    return last === undefined ? null : readRunStatus(last.status)?.status === 'ready'
  }
  const reviewed = (state.phases.review as { ready?: unknown } | undefined)?.ready
  if (typeof reviewed === 'number') {
    return { stage: 'finished', route: { kind: 'end', reason: 'finished', message: `${facts.id}: the review left nothing medium or above; the work is on its ticket branch` } }
  }
  if (lastReady('implementor') === true) {
    const apps = await readImplementorApps(folder)
    const full: RouteFacts = { ...facts, specCovered: true, implementor: 'ready', analyzerReady: analyzerReady(state), apps, analyzed: analyzedApps(state, apps) }
    return {
      stage: 'review',
      route: {
        kind: 'sequence',
        items: [{ kind: 'phase', phase: 'visual-verify' }, { kind: 'phase', phase: 'gate' }, ...analyzerSteps(full), { kind: 'phase', phase: 'review' }],
        then: { kind: 'end', reason: 'finished', message: `${facts.id}: the review left nothing medium or above; the work is on its ticket branch` },
      },
    }
  }
  // A stopped step whose output the author approved (KIT-83) counts as done.
  const approved = async (step: ApprovableStep): Promise<boolean> => (await currentApproval(folder, step)) !== null
  if (has(PLAN_FILE) && (lastReady('planner') !== false || (await approved('planner')))) return { stage: 'implement', route: stepCommand('Ready: Plan', facts) }
  const specStopped = lastReady('spec-writer') === false && !(await approved('spec-writer'))
  if (has(SPEC_REVIEWED) && !specStopped) return { stage: 'plan', route: stepCommand('Ready: Spec', facts) }
  const record = await readGroomRecord(folder).catch(() => undefined)
  const groomed = record !== undefined && readRunStatus(record.status)?.status === 'ready'
  if (!groomed) return { stage: 'groom', route: stepCommand('Idea', facts) }
  const blocking = record.decisions.filter((decision) => decision.decidedBy === 'follow-up' && decision.followUp === 'blocks').map((decision) => ({ id: decision.id, question: decision.question }))
  if (blocking.length > 0) return { stage: 'groom', route: stepCommand('Idea', facts), needsAuthor: blocking }
  if (has(SPEC_REVIEWED) && specStopped) return { stage: 'spec', route: stepCommand('In Review: Spec', facts), input: [SPEC_REVIEWED, 'spec.md'] }
  return { stage: 'spec', route: stepCommand('Ready: Idea', facts) }
}
