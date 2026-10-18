// T28 (F7, F10): step-results.ts and route.ts do not yet speak the five-word run-status vocabulary
// (spec.reviewed.md Decision Q3.1): readStepResult recognizes only each step's own old word
// (complete, clean) and the pr-reviewer reads no trace file at all; routeStatus's
// In Progress: Implementation check is still hardcoded to the old word 'complete'. This file pins
// the upgrade's contract against the fixtures a real ticket folder carries across it (a 'ready'
// export written after the upgrade, a 'complete' export written before it, and a pr-reviewer
// trace/review.json the step does not write today), so it fails for that reason until P23 lands
// it. Nothing here mocks a module the kit owns (TEST-007): the fixtures are real files under a
// temp ticket folder, read by the exported functions under test.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routeStatus, type RouteFacts } from '#src/route.ts'
import { emptyRunState, type RunState } from '#src/run-state.ts'
import { readStepResult, type ResultPaths, type StepReport } from '#src/step-results.ts'

const NOW = '2026-10-15T00:00:00.000Z'

let dir: string
let paths: ResultPaths

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'build-feature-step-results-status-'))
  paths = { folder: join(dir, 'folder'), repo: dir, app: '.' }
  await mkdir(paths.folder, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A step report with NOTION_TOKEN unset, as the session would write one (run with env -u NOTION_TOKEN -u NOTION_API_KEY). */
const report = (step: string, status: string): StepReport => ({ nonce: 'n1', step, status, resultLine: `${step}: ${status}`, usage: null })

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

describe("T28 F7: readStepResult continues on the new word ready, keeping each step's stop words", () => {
  it('the implementor continues on ready and on the pre-upgrade complete, and stops on refused', async () => {
    const file = join(paths.folder, 'plan.review/trace/implementation-local.json')
    await writeJson(file, { status: 'ready' })
    const ready = await readStepResult('implementor', report('implementor', 'ready'), paths)
    await writeJson(file, { status: 'complete' })
    const complete = await readStepResult('implementor', report('implementor', 'complete'), paths)
    const refused = await readStepResult('implementor', report('implementor', 'refused'), paths)
    expect({ ready: ready.verdict, complete: complete.verdict, refused: refused.verdict }).toEqual({ ready: 'continue', complete: 'continue', refused: 'stop' })
  })

  it('the code-analyzer continues on ready, as it already does on the pre-upgrade clean', async () => {
    const file = join(paths.repo, paths.app, '.static-analysis/rounds.json')
    await writeJson(file, { status: 'ready' })
    const ready = await readStepResult('code-analyzer', report('code-analyzer', 'ready'), paths)
    await writeJson(file, { status: 'clean' })
    const clean = await readStepResult('code-analyzer', report('code-analyzer', 'clean'), paths)
    expect({ ready: ready.verdict, clean: clean.verdict }).toEqual({ ready: 'continue', clean: 'continue' })
  })

  it('the pr-reviewer is read from pr-review/trace/review.json: ready continues, needs-author stops', async () => {
    const file = join(paths.folder, 'pr-review/trace/review.json')
    await writeJson(file, { status: 'ready' })
    const ready = await readStepResult('pr-reviewer', report('pr-reviewer', 'complete'), paths)
    await writeJson(file, { status: 'needs-author' })
    const needsAuthor = await readStepResult('pr-reviewer', report('pr-reviewer', 'complete'), paths)
    expect({ ready: { verdict: ready.verdict, file: ready.file }, needsAuthor: { verdict: needsAuthor.verdict, file: needsAuthor.file } }).toEqual({
      ready: { verdict: 'continue', file },
      needsAuthor: { verdict: 'stop', file },
    })
  })
})

describe('T28 F20: a pre-upgrade complete implementor still routes past itself', () => {
  it('In Progress: Implementation sends the persisted ready (mapped from the pre-upgrade complete) to the gate/Step 7 sequence, not back to the implementor', () => {
    // The ticket's last implementor step was recorded before the F7 word upgrade, as 'complete'.
    // Per Decision Q3.1 (readRunStatus, agent-common, not yet built: P14) a pre-upgrade 'complete'
    // reads as the new word 'ready'; there is no helper yet to do that mapping, so it is written
    // out by hand here (TEST-006: an independent, literal source of truth), the way the upgraded
    // facts-building in driver.ts's route() will have to compute it.
    const state: RunState = { ...emptyRunState(), steps: [{ step: 'implementor', runId: 'run-0', command: '/aspira-implementor KIT-2 --local', status: 'complete', startedAt: NOW, endedAt: NOW, usage: null }] }
    const implementor = state.steps.at(-1)?.status === 'complete' ? 'ready' : null
    const facts: RouteFacts = { id: 'KIT-2', app: '.', specCovered: true, implementor, analyzerReady: true, mode: 'local' }
    expect(routeStatus('In Progress: Implementation', facts).kind).toBe('sequence')
  })
})
