// T29 (F44): route.ts's StepRoute carries only the Playbook slash command today ("/aspira-<agent>
// <ID> ..."); there is no translated launcher form a subagent could run directly against
// the step skill's own script. P23 adds StepRoute.launcher, built from agent-common's launcherFor
// (local: the step's own `.sh local` script; cloud, the command carrying --cloud: a `start` line followed by a
// `wait` line). This file pins that translation against every Playbook row that has a command, so
// it fails for that reason until P23 lands it.

import { PLAYBOOK } from '@aspiralabs/kit/playbook'
import { describe, expect, it } from 'vitest'
import { stepCommand, type StepRoute } from '#src/route.ts'

const ID = 'KIT-2'
const APP = 'apps/web'

/**
 * route.launcher does not exist on StepRoute yet (P23 adds it). Reading it here is the validated
 * boundary TS-003 allows a cast at: the field is absent today, so this reads back `undefined`
 * until P23 lands it, which is the whole point of this red test.
 */
const launcherOf = (route: StepRoute): string[] | undefined => (route as StepRoute & { launcher?: string[] }).launcher

const localLine = (step: string, args: string): string[] => [`.claude/skills/aspira-${step}/scripts/${step}.sh local ${args}`.trim()]
const startWait = (step: string, args: string): string[] => [`.claude/skills/aspira-${step}/scripts/${step}.sh start ${args}`.trim(), `.claude/skills/aspira-${step}/scripts/${step}.sh wait <RUN>`]

type Case = { status: string; step: string; local: { command: string; launcher: string[] }; cloud: { command: string; launcher: string[] } }

// Every PLAYBOOK row with a command (9 of its 14 rows); the other 5 (Shortlist, In Review: Plan,
// Ready: Implementation, Released, Dropped) have no command and are out of scope here. Every
// expected value is copied by hand from the row and from the brief's own transformation rule
// (TEST-006: never recomputed the way stepCommand or the future launcherFor would compute it).
const CASES: Case[] = [
  { status: 'Idea', step: 'groomer', local: { command: `/aspira-groomer ${ID} --take-recommended`, launcher: localLine('groomer', `${ID} --take-recommended`) }, cloud: { command: `/aspira-groomer ${ID} --cloud`, launcher: startWait('groomer', ID) } },
  { status: 'Ready: Idea', step: 'spec-writer', local: { command: `/aspira-spec-writer ${ID} --take-recommended`, launcher: localLine('spec-writer', `${ID} --take-recommended`) }, cloud: { command: `/aspira-spec-writer ${ID} --cloud`, launcher: startWait('spec-writer', ID) } },
  { status: 'In Progress: Spec', step: 'spec-writer', local: { command: `/aspira-spec-writer ${ID} --take-recommended`, launcher: localLine('spec-writer', `${ID} --take-recommended`) }, cloud: { command: `/aspira-spec-writer ${ID} --cloud`, launcher: startWait('spec-writer', ID) } },
  // KIT-48: the spec writer reruns from In Review: Spec on the answered spec.
  { status: 'In Review: Spec', step: 'spec-writer', local: { command: `/aspira-spec-writer ${ID} --take-recommended`, launcher: localLine('spec-writer', `${ID} --take-recommended`) }, cloud: { command: `/aspira-spec-writer ${ID} --cloud`, launcher: startWait('spec-writer', ID) } },
  { status: 'Ready: Spec', step: 'planner', local: { command: `/aspira-planner ${ID} --take-recommended`, launcher: localLine('planner', `${ID} --take-recommended`) }, cloud: { command: `/aspira-planner ${ID} --cloud`, launcher: startWait('planner', ID) } },
  { status: 'In Progress: Plan', step: 'planner', local: { command: `/aspira-planner ${ID} --take-recommended`, launcher: localLine('planner', `${ID} --take-recommended`) }, cloud: { command: `/aspira-planner ${ID} --cloud`, launcher: startWait('planner', ID) } },
  { status: 'Ready: Plan', step: 'implementor', local: { command: `/aspira-implementor ${ID}`, launcher: localLine('implementor', ID) }, cloud: { command: `/aspira-implementor ${ID} --cloud`, launcher: startWait('implementor', ID) } },
  {
    status: 'In Progress: Implementation',
    step: 'code-analyzer',
    local: { command: `/aspira-code-analyzer ${ID} --app ${APP}`, launcher: localLine('code-analyzer', `${ID} --app ${APP}`) },
    cloud: { command: `/aspira-code-analyzer ${ID} --app ${APP} --cloud`, launcher: startWait('code-analyzer', `${ID} --app ${APP}`) },
  },
  { status: 'In Review: Implementation', step: 'pr-reviewer', local: { command: `/aspira-pr-reviewer ${ID}`, launcher: localLine('pr-reviewer', ID) }, cloud: { command: `/aspira-pr-reviewer ${ID} --cloud`, launcher: startWait('pr-reviewer', ID) } },
]

it('CASES covers every PLAYBOOK row that has a command', () => {
  const rowsWithCommand = PLAYBOOK.filter((row) => row.command !== null).length
  expect(CASES.length).toBe(rowsWithCommand)
})

describe('T29 F44: stepCommand prints the launcher alongside the Playbook command', () => {
  it("local: the launcher is the step skill's own script, local, keeping --take-recommended for the four TAKE_RECOMMENDED steps and --app for code-analyzer; stepOf still names the right step", () => {
    const actual = CASES.map(({ status }) => {
      const route = stepCommand(status, { id: ID, app: APP, mode: 'local' })
      return { step: route.step, command: route.command, launcher: launcherOf(route) }
    })
    expect(actual).toEqual(CASES.map(({ step, local }) => ({ step, command: local.command, launcher: local.launcher })))
  })

  it("cloud: the launcher starts the step's cloud agent, then waits on it, naming the run; stepOf still names the right step and the Playbook command carries --cloud, which the launcher drops", () => {
    const actual = CASES.map(({ status }) => {
      const route = stepCommand(status, { id: ID, app: APP, mode: 'cloud' })
      return { step: route.step, command: route.command, launcher: launcherOf(route) }
    })
    expect(actual).toEqual(CASES.map(({ step, cloud }) => ({ step, command: cloud.command, launcher: cloud.launcher })))
  })
})
