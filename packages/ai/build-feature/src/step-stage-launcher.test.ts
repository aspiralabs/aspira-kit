// T30 (F44): the driver's step stage prompt (driver.ts printStep, read when this ran) still tells
// the subagent to "run this command, exactly as written" naming the Playbook slash command, and
// never mentions the step's own SKILL.md or its launcher script. P23 changes it to tell the
// subagent to read the step's SKILL.md and run the route's launcher command instead. This test
// drives the real driver through its exported stage function (nextStage), seeded with a run
// already past approval/resolve/worktree/overrides (a real RunState on disk, TEST-005: the seam is
// nextStage's one call and the prompt file it writes), so it fails for that reason until P23 lands
// it. Nothing here mocks a module the kit owns (TEST-007): the repository is a real temp directory
// and NOTION_TOKEN is never set, so no Notion call can happen on this path.

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { STEP_SKILLS } from './driver.test-helper.ts'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nextStage, type DriverInput } from '#build-feature/driver.ts'
import { runStateSchema, stateDirOf, writeRunState } from '#build-feature/run-state.ts'

const NOW = '2026-10-15T00:00:00.000Z'
const temps: string[] = []

afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A build-feature run for KIT-2 at Ready: Spec, already past approval/resolve/worktree/overrides: one call goes straight to routing. */
async function seedReadySpecRun(): Promise<{ repo: string; folder: string; runId: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'build-feature-step-stage-launcher-'))
  temps.push(repo)
  await writeFile(join(repo, 'aspira.json'), `${JSON.stringify({ board: 'https://app.notion.com/p/kit-2-board', repository: 'aspiralabs/kit' }, null, 2)}\n`)
  const skillDir = join(repo, '.claude/skills/aspira-planner')
  await mkdir(join(skillDir, 'scripts'), { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '# aspira-planner\n')
  await writeFile(join(skillDir, 'scripts/planner.sh'), '#!/bin/bash\necho planner\n', { mode: 0o755 })
  // KIT-19: the driver refuses a step when any step skill's .kit-version is missing or differs from its own version.
  const kitVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version
  for (const step of STEP_SKILLS) {
    await mkdir(join(repo, '.claude/skills', `aspira-${step}`), { recursive: true })
    await writeFile(join(repo, '.claude/skills', `aspira-${step}`, '.kit-version'), `${kitVersion}\n`)
  }
  const folder = join(repo, '.work', 'kit-2-x')
  await mkdir(folder, { recursive: true })
  const runId = 'run-test'
  const card = { id: 'KIT-2', title: 'X', url: 'https://app.notion.com/p/kit-2-x', status: 'Ready: Spec', pr: null, dev: null, type: 'Feature' }
  const run = { runId, command: '/aspira-build-feature KIT-2', startedAt: NOW, endedAt: null, ended: null, mode: 'local' as const }
  const state = runStateSchema.parse({ runs: [run], inProgress: { runId, startedAt: NOW }, card })
  await writeRunState(folder, state)
  return { repo, folder, runId }
}

describe('T30 F44: the step stage tells the subagent to run the launcher, not the slash command', () => {
  it("names the step's own SKILL.md and runs the launcher form, never the bare slash command, for the planner's Ready: Spec step", async () => {
    const { repo, runId } = await seedReadySpecRun()
    const input: DriverInput = { id: 'KIT-2', repo, run: runId, forceRun: false, finish: false, mode: 'local', autonomous: false, now: NOW, env: {} }
    const stage = await nextStage(input)
    const promptPath = typeof stage.prompt === 'string' ? stage.prompt : ''
    const prompt = promptPath === '' ? '' : await readFile(promptPath, 'utf8')
    expect({
      namesSkillMd: prompt.includes('.claude/skills/aspira-planner/SKILL.md'),
      runsLauncher: prompt.includes('.claude/skills/aspira-planner/scripts/planner.sh local KIT-2 --take-recommended'),
      dropsSlashCommand: !prompt.includes('/aspira-planner KIT-2'),
    }).toEqual({ namesSkillMd: true, runsLauncher: true, dropsSlashCommand: true })
  })

  it('records both the Playbook command and the launcher command on the printed step stage', async () => {
    const { repo, runId } = await seedReadySpecRun()
    const input: DriverInput = { id: 'KIT-2', repo, run: runId, forceRun: false, finish: false, mode: 'local', autonomous: false, now: NOW, env: {} }
    const stage = await nextStage(input)
    // The printed stage carries --parent-run <runId>:<nonce> (KIT-19 F6); the forms themselves are what this test pins.
    const bare = (text: unknown) => String(text).replace(/ --parent-run \S+$/, '')
    expect({ command: bare(stage.command), launcher: (stage.launcher as string[]).map(bare) }).toEqual({
      command: '/aspira-planner KIT-2 --take-recommended',
      launcher: ['.claude/skills/aspira-planner/scripts/planner.sh local KIT-2 --take-recommended'],
    })
  })

  it('persists both forms in the run state, not only in the printed stage', async () => {
    const { repo, folder, runId } = await seedReadySpecRun()
    const input: DriverInput = { id: 'KIT-2', repo, run: runId, forceRun: false, finish: false, mode: 'local', autonomous: false, now: NOW, env: {} }
    await nextStage(input)
    const persisted = JSON.parse(await readFile(join(stateDirOf(folder), 'state.json'), 'utf8')) as { pending: { stage: { command?: string; launcher?: string[] } } | null }
    expect({ command: persisted.pending?.stage.command, launcher: persisted.pending?.stage.launcher }).toEqual({
      command: '/aspira-planner KIT-2 --take-recommended',
      launcher: ['.claude/skills/aspira-planner/scripts/planner.sh local KIT-2 --take-recommended'],
    })
  })
})
