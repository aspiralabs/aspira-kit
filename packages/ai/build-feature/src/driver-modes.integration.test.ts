// The build-feature driver at seam S1: `scripts/local.ts <ID>`, as `build-feature.sh local`
// runs it, observed through the one JSON stage each call prints and the files it writes under
// `.work/<id>-<slug>/` (build-summary.md, .local/build-feature/state.json and pr-body.md). Only the
// boundaries are stood in for (TEST-007): the Notion answers the session would write, git's remote,
// gh, and time. The Playbook and the shared decisions module run for real. KIT-11 plan P5:
// T12, T14-T26, T34-T36, T42-T44. The stage contract is described in driver.test-helper.ts.

import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { PHASES } from '#build-feature/driver.ts'
import { gatePhase } from '#build-feature/gate.ts'
import { visualVerifyPhase } from '#build-feature/visual-verify.ts'
import { mergePhase } from '#build-feature/merge.ts'
import { reviewPhase } from '#build-feature/review-loop.ts'
import { releaseRowPhase, step10Phase } from '#build-feature/step10.ts'
import { step8Phase } from '#build-feature/step8.ts'
import { RESUME, RESUME_CLOUD, cleanup, ofKind, project, taken, type DecisionFixture, type Project } from './driver.test-helper.ts'
import { SLOW, returnOn, lastLine, commandOf, told } from './driver.integration.shared.ts'

afterAll(cleanup)

describe('KIT-24: --autonomous skips the human gates', () => {
  const runOf = async (h: Project) => ((await h.state()).runs ?? []).at(-1) ?? {}

  it('is refused with --cloud, naming the in-session form', async () => {
    const h = await project({ status: 'Ready: Idea', mode: 'cloud' })
    const result = await h.start(['--autonomous'])
    expect({ code: result.code, named: /--autonomous does not apply with --cloud/.test(result.text) && result.text.includes('/aspira-build-feature KIT-11 --autonomous') }).toEqual({ code: 1, named: true })
  }, SLOW)

  it('passes --autonomous to the groomer step only, records it on the run, and carries it in the resume command', async () => {
    const h = await project({ status: 'Idea' })
    const groomer = await h.advance({}, await h.start(['--autonomous']))
    const run = await runOf(h)
    expect({ command: commandOf(groomer), autonomous: run.autonomous, resume: run.command }).toEqual({ command: '/aspira-groomer KIT-11 --take-recommended --autonomous', autonomous: true, resume: '/aspira-build-feature KIT-11 --autonomous' })
    await h.report(groomer.stage!, 'confirmed', { card: { status: 'Shortlist' } })
    const move = await h.advance(returnOn('move'))
    const moveStage = move.stage
    if (moveStage?.stage === 'move') {
      h.card.status = String(moveStage.to)
      await h.answer(moveStage, { done: true })
    }
    const spec = await h.advance()
    expect(commandOf(spec)).toBe('/aspira-spec-writer KIT-11 --take-recommended')
  }, SLOW)

  it('answers an ask that carries a recommended option with it, recorded under asked in chat, and prints no ask stage', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const step = await h.advance({}, await h.start(['--autonomous']))
    await h.report(step.stage!, 'ready', { decisions: [{ ...taken('D1', 'Which cache should the summary use?'), recommended: 'Option C', answer: 'Option C' }] })
    const next = await h.advance(returnOn('move'))
    await h.stop()
    const summary = await h.summary()
    const asked = summary.search(/asked in chat/i)
    expect({ next: next.stage?.stage, asks: ofKind(h.stages, 'ask').length, asked: asked >= 0 && summary.indexOf('Option C (the recommended option, taken under --autonomous)', asked) > asked, mode: summary.includes('--autonomous') }).toEqual({ next: 'move', asks: 0, asked: true, mode: true })
  }, SLOW)
})

describe('F2 (Q10 revised): two modes', () => {
  const open = (id: string, question: string): DecisionFixture => ({ ...taken(id, question), decidedBy: 'open', answer: null })
  const runOf = async (h: Project) => ((await h.state()).runs ?? []).at(-1) ?? {}

  it('runs each step skill in this session with --take-recommended by default, and records the mode', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const step = await h.advance({}, await h.start())
    expect({ command: commandOf(step), mode: (await runOf(h)).mode }).toEqual({ command: '/aspira-planner KIT-11 --take-recommended', mode: 'local' })
  }, SLOW)

  it("runs each step skill with --cloud under --cloud, passing no --take-recommended, and does not refuse", async () => {
    const idea = await project({ status: 'Ready: Idea', mode: 'cloud' })
    const spec = await project({ status: 'Ready: Spec', mode: 'cloud' })
    const fromIdea = await idea.advance({}, await idea.start())
    const fromSpec = await spec.advance({}, await spec.start())
    expect({ codes: [fromIdea.code, fromSpec.code], commands: [commandOf(fromIdea), commandOf(fromSpec)], mode: (await runOf(spec)).mode }).toEqual({
      codes: [0, 0],
      commands: ['/aspira-spec-writer KIT-11 --cloud', '/aspira-planner KIT-11 --cloud'],
      mode: 'cloud',
    })
  }, SLOW)

  it('tells the step subagent to let the skill start the cloud agent and wait until it ends, then report as for a step in this session', async () => {
    const h = await project({ status: 'Ready: Spec', mode: 'cloud' })
    const step = await h.advance({}, await h.start())
    const prompt = await readFile(String(step.stage?.prompt), 'utf8')
    expect({ mode: step.stage?.mode, start: /\bstart\b/.test(prompt), wait: /\bwait\b/.test(prompt), cwd: prompt.includes(h.repo) }).toEqual({ mode: 'cloud', start: true, wait: true, cwd: true })
  }, SLOW)

  it('stops on a cloud needs-author result naming the open decisions, and ends on the cloud resume command', async () => {
    const h = await project({ status: 'Ready: Spec', mode: 'cloud' })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage!, 'needs-author', { decisions: [open('D1', 'Should the plan split the driver?')], card: { status: 'In Progress: Plan' } })
    const end = await h.advance()
    const text = await told(h, end)
    expect({ end: end.stage?.stage, stopped: end.stage?.stopped, named: text.includes('D1') && text.includes('Should the plan split the driver?'), moves: ofKind(h.stages, 'move').length, last: lastLine(end.stage?.message) }).toEqual({
      end: 'end',
      stopped: true,
      named: true,
      moves: 0,
      last: RESUME_CLOUD,
    })
  }, SLOW)

  it('stops before the cloud implementor when .work/ is gitignored, naming the limit and the in-session command', async () => {
    const h = await project({ status: 'Ready: Plan', mode: 'cloud', files: { '.gitignore': '.work/\n' } })
    const end = await h.advance({}, await h.start())
    const text = await told(h, end)
    expect({ end: end.stage?.stage, steps: ofKind(h.stages, 'step').length, limit: /gitignored/i.test(text) && text.includes('.work/'), local: text.includes(RESUME), moves: ofKind(h.stages, 'move').length }).toEqual({
      end: 'end',
      steps: 0,
      limit: true,
      local: true,
      moves: 0,
    })
  }, SLOW)

  it('runs the cloud implementor when .work/ is not gitignored', async () => {
    const h = await project({ status: 'Ready: Plan', mode: 'cloud' })
    expect(commandOf(await h.advance({}, await h.start()))).toBe('/aspira-implementor KIT-11 --cloud')
  }, SLOW)

  it('records the mode in the Build Summary', async () => {
    const outcomes = []
    for (const mode of ['local', 'cloud'] as const) {
      const h = await project({ status: 'Ready: Spec', mode })
      await h.advance({}, await h.start())
      await h.stop()
      outcomes.push((await h.summary()).split('\n').find((line) => /^Mode:/.test(line)) ?? '')
    }
    expect(outcomes.map((line) => [/in this session/.test(line), /--cloud/.test(line)])).toEqual([
      [true, false],
      [false, true],
    ])
  }, SLOW)
})

describe('NOVA1.2: the later phases are bound statically, never found by a runtime import', () => {
  it('binds every phase name to the module export that ships with the package', () => {
    expect(PHASES).toStrictEqual({ 'visual-verify': visualVerifyPhase, gate: gatePhase, step8: step8Phase, step10: step10Phase, review: reviewPhase, 'release-row': releaseRowPhase, merge: mergePhase })
  })
})
