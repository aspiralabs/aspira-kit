// The build-feature driver at seam S1: `scripts/local.ts <ID>`, as `build-feature.sh local`
// runs it, observed through the one JSON stage each call prints and the files it writes under
// `.work/<id>-<slug>/` (build-summary.md, .local/build-feature/state.json and pr-body.md). Only the
// boundaries are stood in for (TEST-007): the Notion answers the session would write, git's remote,
// gh, and time. The Playbook and the shared decisions module run for real. KIT-11 plan P5:
// T12, T14-T26, T34-T36, T42-T44. The stage contract is described in driver.test-helper.ts.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RESUME, cleanup, ofKind, project, writeStepExport } from './driver.test-helper.ts'
import { SLOW, returnOn, once, lastLine, noStepOrMove, moveOf, commandOf, told } from './driver.integration.shared.ts'

afterAll(cleanup)

describe('T12 F1: the live Status picks the step', () => {
  it('runs the spec-writer from Ready: Idea and the planner from Ready: Spec, each with --take-recommended', async () => {
    const idea = await project({ status: 'Ready: Idea' })
    const spec = await project({ status: 'Ready: Spec' })
    const fromIdea = await idea.advance({}, await idea.start())
    const fromSpec = await spec.advance({}, await spec.start())
    expect([commandOf(fromIdea), commandOf(fromSpec)]).toEqual(['/aspira-spec-writer KIT-11 --take-recommended', '/aspira-planner KIT-11 --take-recommended'])
  }, SLOW)

  it('re-resolves the card with a new nonce after a step report, then follows the re-resolved Status', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const step = await h.advance({}, await h.start())
    const seen = h.stages.map((stage) => stage.nonce)
    await h.report(step.stage!, 'ready')
    const after = await h.next()
    const then = await h.advance(returnOn('move'), after)
    expect({ kind: after.stage?.stage, fresh: !seen.includes(after.stage?.nonce), then: moveOf(then.stage) }).toEqual({ kind: 'resolve', fresh: true, then: { from: 'In Review: Spec', to: 'Ready: Spec' } })
  }, SLOW)
})

describe('T14 F3: the card is resolved live, never from ticket.md', () => {
  it('stops naming the problem, with no step and no move, when the board or the ticket cannot be read', async () => {
    const variants = [
      { name: 'no aspira.json', aspira: null, resolution: null, problem: /aspira\.json[\s\S]*board|board[\s\S]*aspira\.json/i },
      { name: 'no board', aspira: { repository: 'aspiralabs/fixture' }, resolution: null, problem: /board/i },
      { name: 'not found', aspira: undefined, resolution: { found: false, id: 'KIT-11' }, problem: /not found/i },
      { name: 'unreachable', aspira: undefined, resolution: { error: 'Notion 503: service unavailable' }, problem: /could not be reached/i },
    ]
    const outcomes = []
    for (const variant of variants) {
      const h = await project({ status: 'Ready: Plan', aspira: variant.aspira })
      const resolve = variant.resolution
      const result = await h.advance(resolve === null ? {} : { resolve: once(async (stage) => h.answer(stage, resolve)) }, await h.start())
      outcomes.push({ name: variant.name, named: variant.problem.test(await told(h, result)), noStepOrMove: noStepOrMove(h) })
    }
    expect(outcomes).toEqual(variants.map((variant) => ({ name: variant.name, named: true, noStepOrMove: true })))
  }, SLOW)

  it('does not accept a resolution answer carrying a stale nonce', async () => {
    const h = await project({ status: 'Ready: Plan' })
    const result = await h.advance({ resolve: once(async (stage) => h.answer(stage, h.resolution(), 'stale-nonce')) }, await h.start())
    expect({ pending: result.stage?.stage === 'resolve' || result.stage?.stage === 'end', noStepOrMove: noStepOrMove(h) }).toEqual({ pending: true, noStepOrMove: true })
  }, SLOW)

  it('asks for a resolve stage and never starts the implementor when only ticket.md says Ready: Plan', async () => {
    const h = await project({ status: 'Ready: Plan' })
    await writeFile(join(h.folder, 'ticket.md'), '# KIT-11 X\n\nStatus: Ready: Plan\nURL: https://app.notion.com/p/kit-11\n')
    const pending = await h.advance(returnOn('resolve'), await h.start())
    const again = await h.next()
    expect({ first: pending.stage?.stage, again: again.stage?.stage, noStepOrMove: noStepOrMove(h) }).toEqual({ first: 'resolve', again: 'resolve', noStepOrMove: true })
  }, SLOW)
})

describe('T15 F4: Statuses with nothing to run end the run', () => {
  it('ends with nothing to do, ticket is dropped or unknown Status, and prints no move or step', async () => {
    const variants = [
      { status: 'Ready: Implementation', said: /nothing to do[\s\S]*Ready: Implementation|Ready: Implementation[\s\S]*nothing to do/i },
      { status: 'Released', said: /nothing to do[\s\S]*Released|Released[\s\S]*nothing to do/i },
      { status: 'Dropped', said: /ticket is dropped/i },
      { status: 'Parked', said: /unknown[\s\S]*Parked|Parked[\s\S]*unknown/i },
    ]
    const outcomes = []
    for (const variant of variants) {
      const h = await project({ status: variant.status })
      const result = await h.advance({}, await h.start())
      outcomes.push({ status: variant.status, end: result.stage?.stage, said: variant.said.test(await told(h, result)), noStepOrMove: noStepOrMove(h) })
    }
    expect(outcomes).toEqual(variants.map((variant) => ({ status: variant.status, end: 'end', said: true, noStepOrMove: true })))
  }, SLOW)
})

describe('T16 F5: In Review: Spec and the rows with no command', () => {
  it('moves to Ready: Spec without a step when spec.reviewed/ is a ready export of the current spec.md', async () => {
    const h = await project({ status: 'In Review: Spec' })
    await writeStepExport(h.folder, h.repo, 'spec-writer', 'ready')
    const result = await h.advance(returnOn('move'), await h.start())
    expect({ move: moveOf(result.stage), steps: ofKind(h.stages, 'step').length }).toEqual({ move: { from: 'In Review: Spec', to: 'Ready: Spec' }, steps: 0 })
  }, SLOW)

  it('reruns the spec writer when no ready export covers spec.md, and moves only after its ready report (KIT-48)', async () => {
    const h = await project({ status: 'In Review: Spec' })
    await writeFile(join(h.folder, 'spec.md'), '# X\n\n- [ ] F1: it works.\n')
    const step = await h.advance({}, await h.start())
    const movesBefore = ofKind(h.stages, 'move').length
    await h.report(step.stage!, 'ready')
    const after = await h.advance(returnOn('move'))
    expect({ command: commandOf(step), movesBefore, move: moveOf(after.stage) }).toEqual({ command: '/aspira-spec-writer KIT-11 --take-recommended', movesBefore: 0, move: { from: 'In Review: Spec', to: 'Ready: Spec' } })
  }, SLOW)

  it('prints a Ready move, not a step, in Shortlist and In Review: Plan', async () => {
    const outcomes = []
    for (const status of ['Shortlist', 'In Review: Plan']) {
      const h = await project({ status })
      const result = await h.advance(returnOn('move'), await h.start())
      outcomes.push({ status, move: moveOf(result.stage), steps: ofKind(h.stages, 'step').length })
    }
    expect(outcomes).toEqual([
      { status: 'Shortlist', move: { from: 'Shortlist', to: 'Ready: Idea' }, steps: 0 },
      { status: 'In Review: Plan', move: { from: 'In Review: Plan', to: 'Ready: Plan' }, steps: 0 },
    ])
  }, SLOW)
})

describe('T17 F6 F7: one step at a time, one result per step', () => {
  it('re-prints the same pending step stage when called again without a report', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const first = await h.advance({}, await h.start())
    const again = await h.next()
    expect({ stage: again.stage?.stage, nonce: again.stage?.nonce, command: again.stage?.command, steps: ofKind(h.stages, 'step').length }).toEqual({ stage: 'step', nonce: first.stage?.nonce, command: first.stage?.command, steps: 2 })
  }, SLOW)

  it('refuses a second report for a step it already recorded, naming the step, and keeps one result', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage!, 'ready')
    await h.next()
    await h.report(step.stage!, 'ready')
    const refused = await h.next()
    const steps = ((await h.state()).steps ?? []).filter((recorded) => recorded.step === 'spec-writer' && recorded.runId === h.runId)
    expect({ refused: refused.code !== 0 && refused.text.includes('spec-writer'), results: steps.length }).toEqual({ refused: true, results: 1 })
  }, SLOW)
})

describe('T18 F8: the groomer runs from Idea and a needs-author result stops the run', () => {
  it('runs the groomer with --take-recommended from Idea', async () => {
    const h = await project({ status: 'Idea' })
    expect(commandOf(await h.advance({}, await h.start()))).toBe('/aspira-groomer KIT-11 --take-recommended')
  }, SLOW)

  it('stops after a needs-author groom with no move, writes build-summary.md and ends on the resume command', async () => {
    const h = await project({ status: 'Idea' })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage!, 'needs-author', { card: { status: 'Grooming' } })
    const end = await h.advance()
    expect({ end: end.stage?.stage, moves: ofKind(h.stages, 'move').length, summary: (await h.summary()).length > 0, last: lastLine(end.stage?.message) }).toEqual({ end: 'end', moves: 0, summary: true, last: RESUME })
  }, SLOW)
})
