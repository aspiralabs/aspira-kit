// KIT-83: `--approve <step> --reason "<why>"` lets the author accept a stopped step's output and the run goes on
// past it, recorded with who, when, why and the output's hash; KIT-87: from In Review: Plan the run reruns the
// planner while its last export needs the author, and moves to Ready: Plan only once the plan is ready.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NOW, cleanup, ofKind, project, type DecisionFixture } from './driver.test-helper.ts'
import { SLOW, commandOf, PLANNER_DECISIONS } from './driver.integration.shared.ts'

afterAll(cleanup)

const REASON = 'incomplete only because of KIT-81'

/** A run whose spec step ended incomplete, leaving the card in In Progress: Spec, ended. */
async function stoppedSpec() {
  const h = await project({ status: 'Ready: Idea' })
  const spec = await h.advance({}, await h.start())
  await h.report(spec.stage!, 'incomplete', { card: { status: 'In Progress: Spec' } })
  await h.advance()
  return h
}

describe('KIT-83: the author approves a stopped step by hand', () => {
  it('without --approve, a new run reruns the spec step', async () => {
    const h = await stoppedSpec()
    expect(commandOf(await h.advance({}, await h.start()))).toBe('/aspira-spec-writer KIT-11 --take-recommended')
  }, SLOW)

  it('records the approval, makes the spec step success move and the Ready move, and runs the planner; the Build Summary names it', async () => {
    const h = await stoppedSpec()
    const planner = await h.advance({}, await h.start(['--approve', 'spec-writer', '--reason', REASON]))
    const approvals = JSON.parse(await readFile(join(h.folder, '.local', 'author-approvals.json'), 'utf8')) as Record<string, unknown>[]
    await h.stop()
    expect({
      next: commandOf(planner),
      moves: ofKind(h.stages, 'move').map((stage) => `${String(stage.from)} -> ${String(stage.to)}`),
      approvals: approvals.map(({ step, name, at, reason, runId, output, sha256 }) => ({ step, name, at, reason, runId, output, hashed: typeof sha256 === 'string' && sha256.length === 64 })),
      summary: (await h.summary()).includes(`Author approval of the spec-writer output spec.reviewed/spec.reviewed.md`) && (await h.summary()).includes(REASON),
    }).toEqual({
      next: '/aspira-planner KIT-11 --take-recommended',
      moves: ['In Progress: Spec -> In Review: Spec', 'In Review: Spec -> Ready: Spec'],
      approvals: [{ step: 'spec-writer', name: 't', at: NOW, reason: REASON, runId: h.runId, output: 'spec.reviewed/spec.reviewed.md', hashed: true }],
      summary: true,
    })
  }, SLOW)

  it('no longer holds once the approved output changed: the spec step runs again', async () => {
    const h = await stoppedSpec()
    await h.advance({ step: async () => 'return' }, await h.start(['--approve', 'spec-writer', '--reason', REASON]))
    await h.stop()
    await writeFile(join(h.folder, 'spec.reviewed/spec.reviewed.md'), 'an edit after the approval\n')
    h.card.status = 'In Progress: Spec'
    expect(commandOf(await h.advance({}, await h.start()))).toBe('/aspira-spec-writer KIT-11 --take-recommended')
  }, SLOW)

  it('is refused on a continuing call, without a reason, or for a step that cannot be approved', async () => {
    const h = await stoppedSpec()
    const started = await h.start()
    const refused = [await h.next(['--approve', 'spec-writer', '--reason', REASON]), await h.start(['--approve', 'spec-writer']), await h.start(['--approve', 'implementor', '--reason', REASON])]
    expect({ started: started.stage?.stage, codes: refused.map((result) => result.code), texts: refused.map((result) => /--approve/.test(result.text)) }).toEqual({ started: 'resolve', codes: [1, 1, 1], texts: [true, true, true] })
  }, SLOW)
})

describe('KIT-87: the planner reruns from In Review: Plan after the author answers', () => {
  const open: DecisionFixture[] = [{ ...PLANNER_DECISIONS[0]!, decidedBy: 'open', answer: null }]

  it('reruns the planner instead of moving to Ready: Plan while its last export needs the author, then moves once it is ready', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'needs-author', { decisions: open, card: { status: 'In Review: Plan' } })
    await h.advance()
    const rerun = await h.advance({}, await h.start())
    await h.report(rerun.stage!, 'ready', { decisions: PLANNER_DECISIONS })
    const implementor = await h.advance()
    expect({ rerun: commandOf(rerun), moves: ofKind(h.stages, 'move').map((stage) => `${String(stage.from)} -> ${String(stage.to)}`), next: commandOf(implementor) }).toEqual({
      rerun: '/aspira-planner KIT-11 --take-recommended',
      moves: ['In Review: Plan -> Ready: Plan'],
      next: '/aspira-implementor KIT-11',
    })
  }, SLOW)
})

describe('KIT-88: the next run rewrites a stale Build Summary from the board', () => {
  it('after steps ran outside build-feature, a new run picks up at the live Status and its summary names it, not the old stop', async () => {
    const h = await stoppedSpec()
    const stale = await h.summary()
    // The author ran the spec and planner skills standalone: the card is now in Ready: Plan.
    h.card.status = 'Ready: Plan'
    const implementor = await h.advance({}, await h.start())
    await h.stop()
    const summary = await h.summary()
    expect({ stale: stale.includes('Card: In Progress: Spec'), next: commandOf(implementor), card: summary.includes('Card: Ready: Plan'), oldStop: summary.includes('spec-writer ended incomplete') }).toEqual({ stale: true, next: '/aspira-implementor KIT-11', card: true, oldStop: false })
  }, SLOW)
})
