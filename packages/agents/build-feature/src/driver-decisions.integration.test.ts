// The build-feature driver at seam S1: `scripts/local.ts <ID> --local`, as `build-feature.sh local`
// runs it, observed through the one JSON stage each call prints and the files it writes under
// `.work/<id>-<slug>/` (build-summary.md, .local/build-feature/state.json and pr-body.md). Only the
// boundaries are stood in for (TEST-007): the Notion answers the session would write, git's remote,
// gh, and time. The Playbook and the shared decisions module run for real. KIT-11 plan P5:
// T12, T14-T26, T34-T36, T42-T44. The stage contract is described in driver.test-helper.ts.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, count, ofKind, project, taken } from './driver.test-helper.ts'
import { SLOW, told, plannedAndBuilt, pipeline } from './driver.integration.shared.ts'

afterAll(cleanup)

describe('T19 F11 F12: taken decisions, keyed by step and run, listed once', () => {
  it('lists the implementor assumption before the planner decisions in build-summary.md', async () => {
    const h = await project({ status: 'Ready: Spec' })
    await plannedAndBuilt(h)
    const run = h.runId
    await h.stop()
    const summary = await h.summary()
    const at = [`implementor:${run}:A1`, `planner:${run}:D1`, `planner:${run}:D2`].map((key) => summary.indexOf(key))
    expect({ all: at.every((index) => index >= 0), ordered: at[0]! < at[1]! && at[1]! < at[2]! }).toEqual({ all: true, ordered: true })
  }, SLOW)

  it('lists each key once in build-summary.md and pr-body.md after a restart that reads the same exports', async () => {
    const h = await project({ status: 'Ready: Spec' })
    await plannedAndBuilt(h)
    const run = h.runId
    await h.stop()
    await h.advance({}, await h.start())
    await h.stop()
    const summary = await h.summary()
    const body = await h.prBody()
    expect({
      summary: [`implementor:${run}:A1`, `planner:${run}:D1`, `planner:${run}:D2`].map((key) => count(summary, key)),
      body: count(body, `implementor:${run}:A1`),
    }).toEqual({ summary: [1, 1, 1], body: 1 })
  }, SLOW)

  it('stops naming the step and the file when the planner decisions output is invalid', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'ready', { rawDecisions: 'not a list of decisions' })
    const end = await h.advance()
    const text = await told(h, end)
    expect({ end: end.stage?.stage, step: text.includes('planner'), file: text.includes('plan.json') }).toEqual({ end: 'end', step: true, file: true })
  }, SLOW)
})

describe('T20 F13: a decision that fails the schema is asked, not taken', () => {
  const question = 'Which cache should the summary use?'
  const invalid = { ...taken('D1', question), recommended: 'Option C', answer: 'Option C' }

  it('prints an ask stage quoting the question as text', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage!, 'ready', { decisions: [invalid] })
    const ask = await h.advance()
    expect({ stage: ask.stage?.stage, quoted: String(ask.stage?.question ?? '').includes(question) }).toEqual({ stage: 'ask', quoted: true })
  }, SLOW)

  it('records the question and the chat answer under asked in chat, and never as a taken decision', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage!, 'ready', { decisions: [invalid] })
    const ask = await h.advance()
    await h.answer(ask.stage!, { answer: 'Option B, keyed by run' })
    await h.advance()
    await h.stop()
    const summary = await h.summary()
    const asked = summary.search(/asked in chat/i)
    expect({ asked: asked >= 0, question: summary.indexOf(question, asked) > asked, answer: summary.indexOf('Option B, keyed by run', asked) > asked, taken: summary.includes(`spec-writer:${h.runId}:D1`) }).toEqual({ asked: true, question: true, answer: true, taken: false })
  }, SLOW)
})

describe('T21 F14 F20: the driver never writes a step decisions file and never pauses at a Ready move', () => {
  it('leaves every step trace/decisions.md byte-identical from Ready: Idea to Step 8', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const { result, written } = await pipeline(h, 'set-pr')
    const unchanged = await Promise.all([...written].map(async ([file, bytes]) => ({ file, same: (await readFile(join(h.folder, file))).equals(bytes) })))
    expect({ reached: result.stage?.stage, files: written.size >= 2, unchanged: unchanged.filter((entry) => !entry.same) }).toEqual({ reached: 'set-pr', files: true, unchanged: [] })
  }, SLOW)

  it('prints no ask stage and no question at any Ready move when every decision is valid', async () => {
    const h = await project({ status: 'Ready: Idea' })
    await pipeline(h, 'set-pr')
    const moves = ofKind(h.stages, 'move')
    expect({ asks: ofKind(h.stages, 'ask').length, readyMoves: moves.filter((move) => String(move.to).startsWith('Ready:')).length, questions: moves.filter((move) => 'question' in move).length }).toEqual({ asks: 0, readyMoves: 2, questions: 0 })
  }, SLOW)
})
