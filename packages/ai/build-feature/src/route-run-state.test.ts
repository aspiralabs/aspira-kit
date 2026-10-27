// Run-state routing (KIT-68, F6): with `statusFlow: false` build-feature picks its next stage from the files in the
// ticket's working folder, not from the card's Status. A stage is done when its own output says so: groom, a ready
// groom.json with no unresolved blocking follow-up; spec, spec.reviewed/spec.reviewed.md; plan,
// plan.review/trace/plan.json; implement, state.json records the implementor step as ready; review, state.json
// records the review-fix loop as finished. The next stage is the first one not done, and an edited upstream output
// never moves the route back. Folders are real temp directories.
//
// Contract these tests pin for the implementation (route.ts):
//   routeRunState(folder, facts): Promise<{ stage: 'groom'|'spec'|'plan'|'implement'|'review'|'finished'; route: Route; input?: string[]; needsAuthor?: { id: string; question: string }[] }>
//     facts   { id, app, mode?, autonomous? }, as stepCommand takes them
//     route   a step stage carries the command of the Playbook row of its mapped Status (stepCommand): groom ->
//             'Idea', spec -> 'Ready: Idea' (or 'In Review: Spec' when the spec step stopped on a reviewed spec),
//             plan -> 'Ready: Spec', implement -> 'Ready: Plan'; review is a sequence that ends after the review
//             phase (no release-row and no merge phase); finished is an end route
//     input   the spec rerun's input files, relative to the folder: spec.reviewed/spec.reviewed.md, then spec.md
//   The review-fix loop is finished when state.phases.review.ready names a review number.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { routeRunState, stepCommand } from '#build-feature/route.ts'
import { emptyRunState, writeRunState } from '#build-feature/run-state.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const facts = { id: 'NOM-4', app: '.' }
const RUN = 'run-20261012T090000Z'

async function folder(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'build-feature-run-state-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const groom = (status: 'ready' | 'needs-author', open = 0): string =>
  JSON.stringify({
    decisions: [{ id: 'Q1', question: 'Who owns the list?', options: ['The team', 'The user'], recommended: 'The team', reasoning: 'Shared editing is the norm', whyYours: 'it decides who can delete a list', branch: 'who', facts: [], decidedBy: open > 0 ? 'open' : 'author', answer: open > 0 ? null : 'The team' }],
    branches: [{ id: 'who', state: 'visited' }],
    round: 1,
    startedAt: '2026-10-11T09:00:00.000Z',
    open,
    page: { id: 'page-1', url: 'https://www.notion.so/page-1' },
    status,
    reasonCode: null,
    reason: null,
  })

const GROOM = 'groom/trace/groom.json'
const SPEC = 'spec.reviewed/spec.reviewed.md'
const PLAN = 'plan.review/trace/plan.json'
const step = (name: string, status: string) => ({ step: name, runId: RUN, command: `/aspira-${name} NOM-4`, status, startedAt: '2026-10-12T10:00:00.000Z', endedAt: '2026-10-12T10:40:00.000Z', usage: null })

async function withState(dir: string, fill: Record<string, unknown>): Promise<string> {
  await writeRunState(dir, { ...emptyRunState(), ...fill })
  return dir
}

describe('routeRunState', () => {
  it('T25 picks groom, groom, spec, plan, implement, review and finished from the files in the folder', async () => {
    const stages = [
      await folder(),
      await folder({ [GROOM]: groom('needs-author', 1) }),
      await folder({ [GROOM]: groom('ready') }),
      await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', 'spec.md': '# Spec\n' }),
      await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', 'spec.md': '# Spec\n', [PLAN]: '{}' }),
      await withState(await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', 'spec.md': '# Spec\n', [PLAN]: '{}' }), { steps: [step('implementor', 'ready')] }),
      await withState(await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', 'spec.md': '# Spec\n', [PLAN]: '{}' }), { steps: [step('implementor', 'ready')], phases: { review: { seen: [], fixed: [], ready: 1, finalBody: null } } }),
    ]
    const routed = await Promise.all(stages.map(async (dir) => (await routeRunState(dir, facts)).stage))
    expect(routed).toEqual(['groom', 'groom', 'spec', 'plan', 'implement', 'review', 'finished'])
  })

  it("T25 gives each step stage the command of its Playbook row's mapped Status", async () => {
    const run = (dir: string) => routeRunState(dir, facts)
    const groomed = await run(await folder())
    const spec = await run(await folder({ [GROOM]: groom('ready') }))
    const plan = await run(await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n' }))
    const implement = await run(await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', [PLAN]: '{}' }))
    expect([groomed.route, spec.route, plan.route, implement.route]).toEqual([stepCommand('Idea', facts), stepCommand('Ready: Idea', facts), stepCommand('Ready: Spec', facts), stepCommand('Ready: Plan', facts)])
    expect([groomed.route, spec.route, plan.route, implement.route].map((route) => (route.kind === 'step' ? route.command.split(' ')[0] : route.kind))).toEqual(['/aspira-groomer', '/aspira-spec-writer', '/aspira-planner', '/aspira-implementor'])
  })

  it('T25 reruns the spec on spec.reviewed.md and spec.md when the spec step is the one that stopped', async () => {
    const dir = await withState(await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', 'spec.md': '# Spec\n' }), { steps: [step('spec-writer', 'needs-author')] })
    const routed = await routeRunState(dir, facts)
    expect([routed.stage, routed.route, routed.input]).toEqual(['spec', stepCommand('In Review: Spec', facts), [SPEC, 'spec.md']])
  })

  it('T25 starts the spec from the idea when no reviewed spec exists', async () => {
    const routed = await routeRunState(await folder({ [GROOM]: groom('ready') }), facts)
    expect([routed.stage, routed.input === undefined || routed.input.includes('idea.md')]).toEqual(['spec', true])
  })

  it('T25 ends the review stage after the review phase: no release row and no merge', async () => {
    const dir = await withState(await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', [PLAN]: '{}' }), { steps: [step('implementor', 'ready')] })
    const routed = await routeRunState(dir, facts)
    const phases = routed.route.kind === 'sequence' ? routed.route.items.flatMap((item) => (item.kind === 'phase' ? [item.phase] : [])) : []
    expect([routed.stage, phases.includes('review'), phases.includes('release-row'), phases.includes('merge')]).toEqual(['review', true, false, false])
  })

  it('T25 does not move the route back when groom.json is touched after plan.json exists', async () => {
    const dir = await folder({ [GROOM]: groom('ready'), [SPEC]: '# Spec reviewed\n', [PLAN]: '{}' })
    const before = await routeRunState(dir, facts)
    const later = new Date(Date.now() + 60_000)
    await utimes(join(dir, GROOM), later, later)
    await utimes(join(dir, SPEC), later, later)
    await writeFile(join(dir, GROOM), groom('ready'))
    const after = await routeRunState(dir, facts)
    expect([before.stage, after.stage, after.route]).toEqual(['implement', 'implement', before.route])
  })
})
