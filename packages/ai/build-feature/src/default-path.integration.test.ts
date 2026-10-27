// Pins build-feature's printed stage sequence for a card at each Status from Idea to In Review:
// Implementation, under the three configs an Aspira product can have: no aspira.json, a board-only one, and
// one with every key a product uses today (KIT-68 F1). The goldens under __goldens__/ were recorded at
// 7797a62, before any harness change. The full config leaves out database, webhooks and tunnel: they make the
// run isolate the worktree through the provider's API, which a test must not reach (the isolation suites cover them). Uses project() from driver.test-helper.ts unchanged, with its fake
// board answers and bare origin; the session answers each step with its success report and the run goes on
// until a stage that needs the model, the gate or the review.
import { afterAll, describe, it } from 'vitest'
import { BOARD, RELEASES, REPOSITORY, cleanup, project, type Project, type Stage } from './driver.test-helper.ts'
import { SLOW, SUCCESS } from './driver.integration.shared.ts'

afterAll(cleanup)

const PAGE = 'https://www.notion.so/Page-0123456789abcdef0123456789abcdef'
const CONFIGS: Record<string, Record<string, unknown> | null> = {
  none: null,
  board: { board: BOARD, repository: REPOSITORY },
  full: {
    board: BOARD,
    repository: REPOSITORY,
    releases: RELEASES,
    app: 'app',
    knowledge: PAGE,
    gates: [{ command: 'pnpm lint' }, { cwd: 'app', command: 'pnpm test' }],
    models: { 'implementor.verification': { model: 'opus', effort: 'high' } },
    dev: { command: 'pnpm dev', url: 'http://localhost:3000' },
    codebaseMaps: '.codebase-maps',
  },
}
const STATUSES = ['Idea', 'Ready: Idea', 'Shortlist', 'In Review: Spec', 'Ready: Spec', 'Ready: Plan', 'In Progress: Implementation', 'In Review: Implementation']
const MAX_STAGES = 14

/** What the plan pins of a printed stage: its kind and what it moves, runs, pushes or opens. */
function planOf(h: Project, stage: Stage): Record<string, unknown> {
  const clean = (value: unknown) => String(value).replaceAll(h.dir, '<root>')
  const command = typeof stage.command === 'string' ? stage.command.replace(/ --parent-run \S+$/, '').replace(/ --(?:guidelines|knowledge|packet) \S+/g, '') : undefined
  return {
    stage: stage.stage,
    ...(stage.step === undefined ? {} : { step: stage.step }),
    ...(command === undefined ? {} : { command }),
    ...(stage.from === undefined ? {} : { moves: { from: stage.from, to: stage.to } }),
    ...(stage.url === undefined ? {} : { pr: clean(stage.url) }),
    ...(stage.push === undefined ? {} : { push: stage.push !== null }),
    ...(stage.pr === undefined ? {} : { prRef: clean(stage.pr) }),
    ...(stage.status === undefined ? {} : { status: stage.status }),
    ...(stage.reason === undefined ? {} : { reason: stage.reason }),
    ...(stage.message === undefined ? {} : { message: clean(stage.message).split('\n')[0] }),
  }
}

/** Drives the run, answering resolve, approval, overrides, moves, PR and summary stages, and each step with its success report, and returns every stage it printed. */
async function sequence(h: Project): Promise<Record<string, unknown>[]> {
  let result = await h.advance({}, await h.start())
  for (let turn = 0; turn < MAX_STAGES; turn += 1) {
    const stage = result.stage
    if (stage === null || stage.stage !== 'step') break
    await h.report(stage, SUCCESS[String(stage.step)] ?? 'complete')
    result = await h.advance()
  }
  return h.stages.map((stage) => planOf(h, stage))
}

describe('F1: build-feature prints the same stage sequence for the three configs (goldens recorded at 7797a62)', () => {
  for (const name of Object.keys(CONFIGS)) {
    for (const status of STATUSES) {
      it.concurrent(`prints the stages of a card at ${status} under the ${name} config`, async ({ expect }) => {
        const h = await project({ status, aspira: CONFIGS[name]! })
        const stages = await sequence(h)
        const text = `${JSON.stringify(stages, null, 2).replaceAll(h.dir, '<root>')}\n`
        await expect(text).toMatchFileSnapshot(`./__goldens__/default-path-${name}-${status.replaceAll(/[^A-Za-z]+/g, '-')}.json`)
      }, SLOW)
    }
  }
})
