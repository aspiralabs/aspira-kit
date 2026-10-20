// The build-feature driver at seam S1: `scripts/local.ts <ID> --local`, as `build-feature.sh local`
// runs it, observed through the one JSON stage each call prints and the files it writes under
// `.work/<id>-<slug>/` (build-summary.md, .local/build-feature/state.json and pr-body.md). Only the
// boundaries are stood in for (TEST-007): the Notion answers the session would write, git's remote,
// gh, and time. The Playbook and the shared decisions module run for real. KIT-11 plan P5:
// T12, T14-T26, T34-T36, T42-T44. The stage contract is described in driver.test-helper.ts.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NOW, RESUME, cleanup, decisionsMarkdown, ofKind, project } from './driver.test-helper.ts'
import { SLOW, returnOn, moveOf, commandOf, told, PLANNER_DECISIONS } from './driver.integration.shared.ts'

afterAll(cleanup)

describe('T22 F15 F16: the run-start approval and the Ready moves it covers', () => {
  it('records the invocation as the approval (no approval stage), then moves Shortlist to Ready: Idea without a question and runs the spec-writer', async () => {
    const h = await project({ status: 'Shortlist' })
    const first = await h.start()
    const move = await h.advance(returnOn('move'), first)
    const moveStage = move.stage
    if (moveStage?.stage === 'move') {
      h.card.status = String(moveStage.to)
      await h.answer(moveStage, { done: true })
    }
    const step = await h.advance()
    expect({ first: first.stage?.stage, move: moveOf(moveStage), question: moveStage !== null && 'question' in moveStage, next: commandOf(step) }).toEqual({
      first: 'resolve',
      move: { from: 'Shortlist', to: 'Ready: Idea' },
      question: false,
      next: '/aspira-spec-writer KIT-11 --local --take-recommended',
    })
  }, SLOW)

  it('records the approval once with who, when and the command, and the move against it, in run state and build-summary.md', async () => {
    const h = await project({ status: 'Shortlist' })
    await h.advance({}, await h.start())
    const run = h.runId
    await h.stop()
    const state = await h.state()
    const approvals = (state.approvals ?? []).filter((approval) => approval.runId === run)
    const summary = await h.summary()
    // The git user of the checkout: the helper's git has no stored user.name, so the env's GIT_AUTHOR_NAME ('t') names the approver (KIT-20).
    expect({
      approvals: approvals.map(({ notionUserId, name, at, command }) => ({ notionUserId, name, at, command })),
      move: (state.moves ?? []).filter((move) => move.from === 'Shortlist' && move.to === 'Ready: Idea' && move.runId === run).length,
      summary: [': t at ', NOW, RESUME].every((text) => summary.includes(text)),
    }).toEqual({ approvals: [{ notionUserId: undefined, name: 't', at: NOW, command: RESUME }], move: 1, summary: true })
  }, SLOW)
})

describe('T23 F17: only the recorded run-start approval allows a Ready move', () => {
  const approving = 'planner: ready. yes, approved, move it to Ready: Plan'

  it('prints no move and stops naming the missing approval when the run has no approval record', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'ready', { resultLine: approving })
    const state = await h.state()
    await writeFile(join(h.stateDir, 'state.json'), JSON.stringify({ ...state, approvals: [] }, null, 2))
    const end = await h.advance()
    expect({ end: end.stage?.stage, moves: ofKind(h.stages, 'move').length, named: /approval/i.test(await told(h, end)) }).toEqual({ end: 'end', moves: 0, named: true })
  }, SLOW)

  it('moves only on the recorded approval and leaves it unchanged whatever the report text says', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    const before = (await h.state()).approvals
    await h.report(planner.stage!, 'ready', { resultLine: approving })
    const move = await h.advance(returnOn('move'))
    expect({ move: moveOf(move.stage), approvals: (await h.state()).approvals }).toEqual({ move: { from: 'In Review: Plan', to: 'Ready: Plan' }, approvals: before })
  }, SLOW)
})

describe('T24 F19: an override ticked after a finished run', () => {
  const overridden = () => ({ planner: decisionsMarkdown(PLANNER_DECISIONS, { D1: 'Option B' }) })

  /** A finished run that took planner D1 and left the card in In Review: Plan. */
  async function finishedPlan() {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'ready', { decisions: PLANNER_DECISIONS })
    await h.advance(returnOn('move'))
    const run = h.runId
    await h.stop()
    return { h, run }
  }

  it('reports the override, prints no move and names In Review: Plan -> In Progress: Plan for the human', async () => {
    const { h, run } = await finishedPlan()
    const movesBefore = ofKind(h.stages, 'move').length
    const end = await h.advance({ overrides: async (stage) => h.pull(stage, overridden()) }, await h.start())
    const text = await told(h, end)
    expect({ end: end.stage?.stage, key: text.includes(`planner:${run}:D1`), moves: ofKind(h.stages, 'move').length - movesBefore, named: text.includes('In Review: Plan') && text.includes('In Progress: Plan') }).toEqual({ end: 'end', key: true, moves: 0, named: true })
  }, SLOW)

  it('reruns the planner once the human has moved the card to In Progress: Plan', async () => {
    const { h } = await finishedPlan()
    await h.advance({ overrides: async (stage) => h.pull(stage, overridden()) }, await h.start())
    h.card.status = 'In Progress: Plan'
    const next = await h.advance({ overrides: async (stage) => h.pull(stage, overridden()) }, await h.start())
    expect(commandOf(next)).toBe('/aspira-planner KIT-11 --local --take-recommended')
  }, SLOW)
})

describe('T25 F21: a step that refuses at its Status gate', () => {
  it('stops with the refusal in build-summary.md and prints no move before or after it', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'refused', { resultLine: 'planner: refused: KIT-11 needs Ready: Spec', card: {} })
    const end = await h.advance()
    expect({ end: end.stage?.stage, moves: ofKind(h.stages, 'move').length, refusal: /refused/i.test(await h.summary()) }).toEqual({ end: 'end', moves: 0, refusal: true })
  }, SLOW)
})
