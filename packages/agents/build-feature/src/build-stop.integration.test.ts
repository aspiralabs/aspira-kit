// KIT-2 P23 follow-ups (F20): the driver's printed `end` stage carries build-feature's own run
// status for the reason it stopped, and the CLI exits by A2 on it (0 ready; 1 incomplete, blocked;
// 3 refused; 5 needs-author, its own code by Decision Q4). While a run is in progress, build-feature marks the ticket with
// `.local/build-feature/active.json` (no `end`), so a step skill's progress note points back at
// `/aspira-build-feature <ID>`; when the run stops, the marker is ended and build-feature writes the
// note itself, its Next action the command that resumes the run.
//
// Every expected status and exit code is copied from F20 and A2 of the reviewed spec, never
// recomputed the way build-status.ts computes it (TEST-006).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseNextAction, writeProgressNote } from '@aspiralabs/agent-common/lib/progress-note'
import { APPROVER, cleanup, ID, project, RESUME, TITLE, writeStepExport, type Project, type Result } from '#src/driver.test-helper.ts'

afterAll(cleanup)

const SLOW = 120_000

const active = async (h: Project) => JSON.parse(await readFile(join(h.stateDir, 'active.json'), 'utf8')) as { runId: string; mode: string; end: string | null }
const note = (h: Project) => readFile(join(h.folder, 'progress.md'), 'utf8')
const endOf = (result: Result) => ({ stage: result.stage?.stage, status: result.stage?.status, code: result.code })

describe('F20: the end stage carries build-feature\'s own run status, and the exit follows A2', () => {
  it('a Dropped card ends refused (exit 3), and Ready: Implementation (nothing to do) too', async () => {
    const outcomes = []
    for (const status of ['Dropped', 'Ready: Implementation']) {
      const h = await project({ status })
      outcomes.push(endOf(await h.advance({}, await h.start())))
    }
    expect(outcomes).toEqual([
      { stage: 'end', status: 'refused', code: 3 },
      { stage: 'end', status: 'refused', code: 3 },
    ])
  }, SLOW)

  it('a missing aspira.json ends blocked (exit 1)', async () => {
    const h = await project({ status: 'Ready: Plan', aspira: null })
    expect(endOf(await h.advance({}, await h.start()))).toEqual({ stage: 'end', status: 'blocked', code: 1 })
  }, SLOW)

  it('a step that stops carries that step\'s own status: a blocked planner ends blocked (exit 1)', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'blocked')
    expect(endOf(await h.advance())).toEqual({ stage: 'end', status: 'blocked', code: 1 })
  }, SLOW)

  it('gh missing at Step 8 ends blocked (exit 1)', async () => {
    const h = await project({ status: 'In Progress: Implementation', gh: false })
    // The helper's step exports keep the old words, which read as ready (F7).
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const analyzer = await h.advance({}, await h.start())
    await h.report(analyzer.stage!, 'clean')
    expect(endOf(await h.advance())).toEqual({ stage: 'end', status: 'blocked', code: 1 })
  }, SLOW)

  it('--finish before a merge-ready PR ends incomplete (exit 1), and a later --finish prints the same status', async () => {
    const h = await project({ status: 'Ready: Plan' })
    await h.advance({}, await h.start())
    const end = await h.stop()
    const again = await h.finish()
    expect({ end: endOf(end), again: endOf(again) }).toEqual({
      end: { stage: 'end', status: 'incomplete', code: 1 },
      again: { stage: 'end', status: 'incomplete', code: 1 },
    })
  }, SLOW)
})

describe('F20: active.json marks a run in progress, and the run\'s end ends it', () => {
  it('is written at run start with no end, and carries the end time once the run stops', async () => {
    const h = await project({ status: 'Ready: Plan' })
    await h.start()
    const running = await active(h)
    const implementor = await h.advance({ approval: async (stage) => h.answer(stage, { ...APPROVER }) })
    const stillRunning = await active(h)
    await h.report(implementor.stage!, 'blocked', { card: { status: 'In Progress: Implementation' } })
    await h.advance()
    const ended = await active(h)
    expect({ running, stillRunning: stillRunning.end, ended: { runId: ended.runId, end: typeof ended.end } }).toEqual({
      running: { runId: h.runId, mode: 'local', end: null },
      stillRunning: null,
      ended: { runId: h.runId, end: 'string' },
    })
  }, SLOW)
})

describe('F20: the progress note while build-feature drives a ticket, and when it stops', () => {
  it('a build interrupted mid-step leaves a note whose Next action resumes build-feature, with the step\'s own command under Open issues', async () => {
    const h = await project({ status: 'Ready: Plan' })
    await h.advance({}, await h.start())
    // The implementor step is running and writes its own note (as every --local driver stage does).
    await writeProgressNote({
      folder: h.folder,
      repo: h.repo,
      note: {
        id: ID, title: TITLE, skill: 'implementor', runId: 'impl-1', runStatus: 'incomplete', status: 'In Progress: Implementation', expectedStatus: null,
        outputs: [], completed: [], decisions: [], openIssues: [],
        nextAction: { step: 'implementor is running, or it stopped: rerun it', do: [], run: ['.claude/skills/aspira-implementor/scripts/implementor.sh local KIT-11'], session: '.claude/skills/aspira-implementor/scripts/implementor.sh local KIT-11' },
      },
    })
    const text = await note(h)
    expect({ run: parseNextAction(text)?.run, demoted: text.slice(text.indexOf('## Open issues'), text.indexOf('## Next action')).includes('implementor.sh local KIT-11') }).toEqual({ run: [RESUME], demoted: true })
  }, SLOW)

  it('a stopped run writes progress.md itself: its run status, the stop reason under Open issues, and Next action the resume command', async () => {
    const h = await project({ status: 'Ready: Spec' })
    const planner = await h.advance({}, await h.start())
    await h.report(planner.stage!, 'blocked')
    await h.advance()
    const text = await note(h)
    expect({
      run: parseNextAction(text)?.run,
      status: /Run status: blocked/.test(text),
      issue: text.slice(text.indexOf('## Open issues'), text.indexOf('## Next action')).includes('planner'),
    }).toEqual({ run: [RESUME], status: true, issue: true })
  }, SLOW)
})
