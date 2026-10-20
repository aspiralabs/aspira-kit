// The live Status picks what the run does next, through the Playbook's own table
// (@aspiralabs/kit/playbook): a step (the row's command with the ID filled in), a Ready move for
// the rows a human used to do by hand, the later phases (gate, Step 8, Step 10, the review loop,
// the release row), or the end of the run. What the rows cannot say is decided here, from facts
// the driver reads: whether a review covers the current spec.md, what the implementor's last
// result was, and whether the analyzer finished clean.

import { commandFor, nextStep } from '@aspiralabs/kit/playbook'

/** The steps, in Playbook order. */
export const STEPS = ['groomer', 'spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const
export type StepName = (typeof STEPS)[number]
export const isStep = (value: string): value is StepName => (STEPS as readonly string[]).includes(value)

/**
 * The steps the run passes --take-recommended to under --local: an agent decision never stops the
 * run. Their default (cloud) modes refuse the flag ("--take-recommended only applies to local"), so
 * a cloud run passes nothing and a needs-author result stops it, naming the open decisions.
 */
export const TAKE_RECOMMENDED: readonly StepName[] = ['groomer', 'spec-writer', 'spec-reviewer', 'planner']

/**
 * How the run runs each step (F2, Q10 revised): 'local' runs the step skill with --local in this
 * session; 'cloud' runs its default mode, which starts the step's cloud agent and waits on it.
 */
export const MODES = ['local', 'cloud'] as const
export type Mode = (typeof MODES)[number]

/** The command that resumes a run: `/aspira-build-feature <ID>`, with --local in local mode and --autonomous when the run skips the human gates (KIT-24). */
export const RESUME = (id: string, mode: Mode = 'local', autonomous = false): string => `/aspira-build-feature ${id}${mode === 'local' ? ' --local' : ''}${autonomous ? ' --autonomous' : ''}`

/** The line the Build Summary gives the mode. */
export const modeLine = (mode: Mode, autonomous = false): string =>
  mode === 'local'
    ? `Mode: --local (every step ran its skill with --local in this session)${autonomous ? ' and --autonomous (no human gate: the groomer took every question as recommended and confirmed itself; an ask with a recommended option was answered with it)' : ''}`
    : "Mode: cloud (every step ran its skill's default mode: the step's own agent, started and waited on)"

/** The later-phase modules, in run order. */
export const PHASES = ['gate', 'step8', 'step10', 'review', 'release-row'] as const
export type PhaseName = (typeof PHASES)[number]

/** The Ready moves a human used to make by hand, which the run makes on its run-start approval (F15, F16). */
export const READY_MOVES: readonly { from: string; to: string }[] = [
  { from: 'Shortlist', to: 'Ready: Idea' },
  { from: 'In Review: Spec', to: 'Ready: Spec' },
  { from: 'In Review: Plan', to: 'Ready: Plan' },
]

/** The one move Step 8 makes, after the PR property reads back (BOARD-005). */
export const STEP8_MOVE = { from: 'In Progress: Implementation', to: 'In Review: Implementation' } as const

export type StepRoute = { kind: 'step'; step: StepName; command: string; launcher: string[] }
export type SequenceItem = { kind: 'phase'; phase: PhaseName } | (StepRoute & { done: boolean })
export type EndRoute = { kind: 'end'; reason: 'nothing-to-do' | 'dropped' | 'unknown' | 'unsettled' | 'finished'; message: string }

export type Route =
  | StepRoute
  | { kind: 'readyMove'; from: string; to: string }
  /** Walk the items in order: a phase decides itself whether it has work left; a step runs unless done. */
  | { kind: 'sequence'; items: SequenceItem[]; then: EndRoute }
  | EndRoute

export type RouteFacts = {
  id: string
  /** aspira.json `app`, or '.' (A2). */
  app: string
  /** In Review: Spec: a review (spec.written/ or a ready spec-reviewer run) covers the current spec.md (A6). */
  specCovered: boolean
  /** The implementor's last exported status (implementation-local.json), read through readRunStatus, or null. */
  implementor: string | null
  /** The code-analyzer finished ready after the last build. */
  analyzerReady: boolean
  /** The app directories the build changed, each analyzed on its own (KIT-39); absent or empty: `app` alone. */
  apps?: string[]
  /** Which of `apps` the analyzer has finished ready since the last build. */
  analyzed?: string[]
  /** How each step runs. Default 'local'. */
  mode?: Mode
  /** --autonomous (KIT-24): the groomer runs with --autonomous under --local. */
  autonomous?: boolean
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
const launcherLine = (step: StepName, sub: 'local' | 'start' | 'wait', args: string): string => `.claude/skills/aspira-${step}/scripts/${step}.sh ${sub} ${args}`.trim()

/**
 * `command`'s launcher form (F44): the step's own script instead of the slash command, so a
 * subagent runs its launcher script directly instead of the Skill tool. Local: `.sh local <args>`,
 * `--local` dropped (implied by `local`). Cloud: `.sh start <args>` then `.sh wait <RUN>`.
 * Exported so a caller holding only a command string (the review loop's own re-review command,
 * which stepCommand never builds) can still get its launcher form, with the same algorithm.
 */
export function launcherFor(command: string, mode: Mode): string[] {
  const step = stepOf(command)
  const args = command.split(' ').slice(1).filter((word) => word !== '--local').join(' ')
  if (mode === 'cloud') return [launcherLine(step, 'start', args), launcherLine(step, 'wait', '<RUN>')]
  return [launcherLine(step, 'local', args)]
}

/**
 * A row's command as the run invokes it: ID filled, <app-dir> filled; under --local the row's
 * --local and --take-recommended where it applies, in cloud mode the same command without --local.
 */
export function stepCommand(status: string, facts: Pick<RouteFacts, 'id' | 'app' | 'mode' | 'autonomous'>): StepRoute {
  const row = nextStep(status)
  const filled = row === null ? null : commandFor(row, facts.id)
  if (filled === null) throw new Error(`the Playbook row for ${status} has no command`)
  const command = filled.replaceAll('<app-dir>', facts.app)
  const step = stepOf(command)
  const mode = facts.mode ?? 'local'
  if (mode === 'cloud') {
    const cloudCommand = command.split(' ').filter((word) => word !== '--local').join(' ')
    return { kind: 'step', step, command: cloudCommand, launcher: launcherFor(cloudCommand, mode) }
  }
  const taken = TAKE_RECOMMENDED.includes(step) ? `${command} --take-recommended` : command
  // --autonomous (KIT-24): only the groomer has a chat gate of its own (exit-criterion questions and Confirm).
  const localCommand = facts.autonomous === true && step === 'groomer' ? `${taken} --autonomous` : taken
  return { kind: 'step', step, command: localCommand, launcher: launcherFor(localCommand, mode) }
}

/** The app directories the analyzer runs on: the ones the build changed, else aspira.json's app (KIT-39). */
export const analyzerApps = (facts: Pick<RouteFacts, 'app' | 'apps'>): string[] => (facts.apps?.length ? facts.apps : [facts.app])

/** What the run does for a live Status. */
export function routeStatus(status: string, facts: RouteFacts): Route {
  const row = nextStep(status)
  const named = row?.statuses.find((candidate) => candidate.toLowerCase() === status.trim().toLowerCase())
  if (row === null || named === undefined) return { kind: 'end', reason: 'unknown', message: `unknown Status "${status}" for ${facts.id}: the Playbook has no row for it, so the run cannot pick a step` }
  switch (named) {
    case 'Idea':
    case 'Grooming':
    case 'Ready: Idea':
    case 'In Progress: Spec':
    case 'Ready: Spec':
    case 'In Progress: Plan':
    case 'Ready: Plan':
      return stepCommand(named, facts)
    case 'Shortlist':
    case 'In Review: Plan': {
      const move = READY_MOVES.find((candidate) => candidate.from === named)!
      return { kind: 'readyMove', from: move.from, to: move.to }
    }
    case 'In Review: Spec':
      return facts.specCovered ? { kind: 'readyMove', from: 'In Review: Spec', to: 'Ready: Spec' } : stepCommand(named, facts)
    case 'In Progress: Implementation': {
      if (facts.implementor !== 'ready') return stepCommand('Ready: Plan', facts)
      return {
        kind: 'sequence',
        // One analyzer step per app directory the build changed (KIT-39), each done when its own run ended ready.
        items: [
          { kind: 'phase', phase: 'gate' },
          ...analyzerApps(facts).map((app) => ({ ...stepCommand(named, { ...facts, app }), done: facts.apps?.length ? (facts.analyzed ?? []).includes(app) : facts.analyzerReady })),
          { kind: 'phase', phase: 'step8' },
        ],
        then: { kind: 'end', reason: 'unsettled', message: `${facts.id} is still in In Progress: Implementation after Step 8; resolve it again` },
      }
    }
    case 'In Review: Implementation':
      return {
        kind: 'sequence',
        items: [
          { kind: 'phase', phase: 'step10' },
          { kind: 'phase', phase: 'review' },
          { kind: 'phase', phase: 'release-row' },
        ],
        then: { kind: 'end', reason: 'finished', message: `${facts.id}: the PR is reviewed and ready for a human to merge (BOARD-004); the run never merges and never moves the card to Ready: Implementation` },
      }
    case 'Ready: Implementation':
    case 'Released':
      return { kind: 'end', reason: 'nothing-to-do', message: `nothing to do: ${facts.id} is in ${named}; ${row.step}` }
    case 'Dropped':
      return { kind: 'end', reason: 'dropped', message: `ticket is dropped: ${facts.id} is in Dropped and is not being built` }
    default:
      return { kind: 'end', reason: 'unknown', message: `unknown Status "${status}" for ${facts.id}: the run has no route for it` }
  }
}
