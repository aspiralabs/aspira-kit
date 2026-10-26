// T15 (F20): a build-feature run drives several skills in one session. While it is active, a
// progress note written for the step it is currently on must not tell a human or a fresh session to
// rerun that step directly (that would race build-feature's own state); it must point back at
// `/aspira-build-feature <ID> [--cloud]`, the one command that resumes the whole run, and keep the
// step's own continuation visible (for a human reading the ticket) under Open issues instead.
//
// build-feature marks itself active at `.local/build-feature/active.json` (relative to the ticket
// folder) with no `end` field while the run is in progress, and sets `end` once it stops
// (route.ts:30, driver.ts; written by a later task, P23). writeProgressNote reads that file itself,
// so the override needs no extra input from the caller: the Next action it would otherwise write
// for the step still has to be supplied, since it is demoted to Open issues, not discarded.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILD_FEATURE_ACTIVE, parseNextAction, writeProgressNote, type NextAction } from './progress-note'

let repo: string
let folder: string

const PLANNER_CONTINUATION: NextAction = {
  step: 'Step 5 is running, or it stopped: rerun it',
  do: [],
  run: ['/aspira-planner KIT-2'],
  session: '~/.claude/skills/aspira-planner/scripts/planner.sh local KIT-2',
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'progress-note-build-feature-'))
  folder = join(repo, '.work', 'kit-2-x')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'ticket.md'), '# KIT-2: x\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const baseNote = {
  id: 'KIT-2',
  title: 'x',
  skill: 'planner' as const,
  runId: 'r1',
  runStatus: 'needs-author' as const,
  status: 'In Progress: Plan',
  expectedStatus: null,
  outputs: [],
  completed: [],
  decisions: [],
  openIssues: [],
  nextAction: PLANNER_CONTINUATION,
}

describe('T15: a progress note written while build-feature is active', () => {
  it('keeps "Run: /aspira-build-feature KIT-2" as the Next action, and lists the step’s continuation under Open issues', async () => {
    await mkdir(join(folder, '.local', 'build-feature'), { recursive: true })
    await writeFile(join(folder, '.local', 'build-feature', 'active.json'), JSON.stringify({ runId: 'b1', mode: 'local', end: null }))
    await writeProgressNote({ folder, repo, note: baseNote })
    const text = await readFile(join(folder, 'progress.md'), 'utf8')
    const action = parseNextAction(text)
    expect(action?.run).toEqual(['/aspira-build-feature KIT-2'])
    const openIssues = text.slice(text.indexOf('## Open issues'), text.indexOf('## Next action'))
    expect(openIssues).toContain('/aspira-planner KIT-2')
  })

  it('KIT-51: a cloud-mode run resumes with --cloud; the default mode carries no flag', async () => {
    await mkdir(join(folder, '.local', 'build-feature'), { recursive: true })
    await writeFile(join(folder, '.local', 'build-feature', 'active.json'), JSON.stringify({ runId: 'b1', mode: 'cloud', end: null }))
    await writeProgressNote({ folder, repo, note: baseNote })
    const action = parseNextAction(await readFile(join(folder, 'progress.md'), 'utf8'))
    expect(action?.run).toEqual(['/aspira-build-feature KIT-2 --cloud'])
  })

  it('BUILD_FEATURE_ACTIVE names the marker path writeProgressNote checks', () => {
    expect(BUILD_FEATURE_ACTIVE).toBe('.local/build-feature/active.json')
  })
})

describe('T15: once the marker is gone (the build-feature run ended)', () => {
  it('the planner continuation becomes the Next action again', async () => {
    await mkdir(join(folder, '.local', 'build-feature'), { recursive: true })
    const markerFile = join(folder, '.local', 'build-feature', 'active.json')
    await writeFile(markerFile, JSON.stringify({ runId: 'b1', mode: 'local', end: null }))
    await writeProgressNote({ folder, repo, note: baseNote })
    await rm(markerFile, { force: true })
    await writeProgressNote({ folder, repo, note: baseNote })
    const text = await readFile(join(folder, 'progress.md'), 'utf8')
    expect(parseNextAction(text)).toEqual(PLANNER_CONTINUATION)
    expect(parseNextAction(text)?.session).toBe('~/.claude/skills/aspira-planner/scripts/planner.sh local KIT-2')
  })
})
