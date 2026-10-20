// The build-feature driver at seam S1: `scripts/local.ts <ID> --local`, as `build-feature.sh local`
// runs it, observed through the one JSON stage each call prints and the files it writes under
// `.work/<id>-<slug>/` (build-summary.md, .local/build-feature/state.json and pr-body.md). Only the
// boundaries are stood in for (TEST-007): the Notion answers the session would write, git's remote,
// gh, and time. The Playbook and the shared decisions module run for real. KIT-11 plan P5:
// T12, T14-T26, T34-T36, T42-T44. The stage contract is described in driver.test-helper.ts.

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOARD_RULES_WITH_SUMMARY,
  BOARD_RULES_WITHOUT_SUMMARY,
  NOW,
  RESUME,
  cleanup,
  ofKind,
  project,
  writeStepExport,
  type Stage,
} from './driver.test-helper.ts'
import { SLOW, returnOn, lastLine, firstLine, commandOf, pipeline } from './driver.integration.shared.ts'

afterAll(cleanup)

describe('T34 F32 F33: a failed step or action stops the run with a resume command', () => {
  it('stops after a blocked implementor without a retry, writes build-summary.md and prints the resume command', async () => {
    const h = await project({ status: 'Ready: Plan' })
    const implementor = await h.advance({}, await h.start())
    await h.report(implementor.stage!, 'blocked', { card: { status: 'In Progress: Implementation' } })
    const end = await h.advance()
    expect({ end: end.stage?.stage, steps: ofKind(h.stages, 'step').length, summary: existsSync(join(h.folder, 'build-summary.md')), last: lastLine(end.stage?.message) }).toEqual({ end: 'end', steps: 1, summary: true, last: RESUME })
  }, SLOW)

  it('records the failed gh command and its error and prints no set-pr or move stage when gh is missing', async () => {
    const h = await project({ status: 'In Progress: Implementation', gh: false })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const analyzer = await h.advance({}, await h.start())
    await h.report(analyzer.stage!, 'clean')
    const end = await h.advance()
    const summary = await h.summary()
    expect({
      end: end.stage?.stage,
      command: /\bgh\b/.test(summary),
      error: /ENOENT|not found|not installed/i.test(summary),
      setPrOrMove: ofKind(h.stages, 'set-pr').length + ofKind(h.stages, 'move').length,
      last: lastLine(end.stage?.message),
    }).toEqual({ end: 'end', command: true, error: true, setPrOrMove: 0, last: RESUME })
  }, SLOW)
})

describe('T35 F34 F35: a restarted run resumes from the recorded results', () => {
  it('goes to the gate, not the implementor, when the last build was complete', async () => {
    const h = await project({ status: 'Ready: Plan', files: { 'AGENTS.md': '# Project\n\nRun `pnpm check`.\n' } })
    const implementor = await h.advance({}, await h.start())
    await h.report(implementor.stage!, 'complete')
    await h.advance()
    await h.stop()
    const next = await h.advance({}, await h.start())
    expect({ next: next.stage?.stage, implementorSteps: ofKind(h.stages, 'step').filter((stage) => stage.step === 'implementor').length }).toEqual({ next: 'gate', implementorSteps: 1 })
  }, SLOW)

  it('runs the implementor again when the last build was incomplete', async () => {
    const h = await project({ status: 'Ready: Plan' })
    const implementor = await h.advance({}, await h.start())
    await h.report(implementor.stage!, 'incomplete', { card: { status: 'In Progress: Implementation' } })
    await h.advance()
    const next = await h.advance({}, await h.start())
    expect(commandOf(next)).toBe('/aspira-implementor KIT-11 --local')
  }, SLOW)
})

describe('T36 F36: the Build Summary is pushed only once BOARD-003 lists it', () => {
  /** Stop a groomer run on needs-author and return the summary stage printed after the rules were fetched. */
  async function summaryStage(rules: string) {
    const h = await project({ status: 'Idea' })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage!, 'needs-author', { card: { status: 'Grooming' } })
    const fetch = await h.advance(returnOn('summary'))
    if (typeof fetch.stage?.rules === 'string') {
      await writeFile(fetch.stage.rules, rules)
      await h.answer(fetch.stage, {})
    }
    return { h, stage: (await h.next()).stage }
  }
  const writes = (stage: Stage | null) => ((stage?.notion ?? []) as { op: string }[]).filter((action) => action.op === 'write').length

  it('prints only the local path of build-summary.md and no Notion push without the title', async () => {
    const { stage } = await summaryStage(BOARD_RULES_WITHOUT_SUMMARY)
    expect({ stage: stage?.stage, path: String(stage?.path).endsWith('build-summary.md'), push: stage?.push ?? null, writes: writes(stage) }).toEqual({ stage: 'summary', path: true, push: null, writes: 0 })
  }, SLOW)

  it('prints a create-or-replace action for the child page Build Summary with the title', async () => {
    const { stage } = await summaryStage(BOARD_RULES_WITH_SUMMARY)
    expect({ stage: stage?.stage, push: stage?.push }).toEqual({ stage: 'summary', push: { action: 'create-or-replace', page: 'Build Summary' } })
  }, SLOW)

  it('keeps build-summary.md and names the push failure on the first line of the final report', async () => {
    const { h, stage } = await summaryStage(BOARD_RULES_WITH_SUMMARY)
    await h.answer(stage!, { error: 'Notion 502 Bad Gateway' })
    const end = await h.next()
    const first = firstLine(end.stage?.message)
    expect({ end: end.stage?.stage, kept: existsSync(join(h.folder, 'build-summary.md')), first: /Build Summary/.test(String(first)) && /push|fail/i.test(String(first)) }).toEqual({ end: 'end', kept: true, first: true })
  }, SLOW)
})

describe('T42 F48: one run at a time per ticket', () => {
  it('refuses a second start before any stage, naming when the first run started', async () => {
    const h = await project({ status: 'Ready: Plan' })
    await h.advance(returnOn('resolve'), await h.start())
    const stagesBefore = h.stages.length
    h.setNow('2026-10-12T10:00:00.000Z')
    const second = await h.start()
    expect({ refused: second.code !== 0, named: second.text.includes(NOW), stages: h.stages.slice(stagesBefore).filter((stage) => stage.stage !== 'end').length }).toEqual({ refused: true, named: true, stages: 0 })
  }, SLOW)

  it('starts a new run id with --force-run and records that it replaced the run in progress', async () => {
    const h = await project({ status: 'Ready: Plan' })
    await h.advance(returnOn('resolve'), await h.start())
    const first = h.runId
    h.setNow('2026-10-12T10:00:00.000Z')
    const forced = await h.start(['--force-run'])
    const second = forced.stage?.runId
    const record = ((await h.state()).runs ?? []).find((run) => run.runId === second)
    expect({ fresh: typeof second === 'string' && second !== first, replaced: JSON.stringify(record ?? {}).includes(String(first)) }).toEqual({ fresh: true, replaced: true })
  }, SLOW)
})

describe('T43 F49: the card is re-resolved before every move', () => {
  it('makes no move and stops naming what changed when Dev or Status changed before the Ready: Spec move', async () => {
    const outcomes = []
    for (const change of [{ dev: 'user-2' }, { status: 'Dropped' }]) {
      const h = await project({ status: 'Ready: Idea' })
      const step = await h.advance({}, await h.start())
      await h.report(step.stage!, 'ready')
      const end = await h.advance({ resolve: async (stage) => h.answer(stage, stage.move === undefined ? h.resolution() : { ...h.resolution(), ...change }) })
      const summary = await h.summary()
      outcomes.push({ change, end: end.stage?.stage, moves: ofKind(h.stages, 'move').length, named: Object.values(change).every((value) => summary.includes(value)) })
    }
    expect(outcomes).toEqual([
      { change: { dev: 'user-2' }, end: 'end', moves: 0, named: true },
      { change: { status: 'Dropped' }, end: 'end', moves: 0, named: true },
    ])
  }, SLOW)
})

describe('T44 F46: the run touches only the ticket, its pages, the board rules (read) and the release page', () => {
  it('prints Notion actions that write only to the ticket, its child pages or the release page', async () => {
    const h = await project({ status: 'Ready: Idea' })
    const { result } = await pipeline(h)
    const actions = h.stages.flatMap((stage) => ((stage.notion ?? []) as { op: string; target: string }[]).map((action) => ({ stage: stage.stage, ...action })))
    const allowed = ['ticket', 'child-page', 'release-page']
    expect({
      end: result.stage?.stage,
      writes: actions.filter((action) => action.op === 'write').length > 0,
      outside: actions.filter((action) => (action.op === 'write' && !allowed.includes(action.target)) || (action.target === 'board-rules' && action.op !== 'read')),
    }).toEqual({ end: 'end', writes: true, outside: [] })
  }, SLOW)
})
