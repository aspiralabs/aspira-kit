// Test support (KIT-71 F9, F10): the global harness keeps every step skill under <HOME>/.claude/skills,
// so a driver run finds each skill's .kit-version in the run's temp HOME, never in the repository.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STEP_SKILLS, project, type Project } from './driver.test-helper.ts'
import { VERSION } from './telemetry.integration.shared.ts'

/** Where a skill's .kit-version lives under a HOME. */
export const homeVersionFile = (home: string, step: string): string => join(home, '.claude/skills', `aspira-${step}`, '.kit-version')

/** Write every step skill's .kit-version under the temp HOME (default: this package's version). */
export async function stageKitHome(home: string, version: string = VERSION): Promise<void> {
  for (const step of STEP_SKILLS) {
    await mkdir(join(home, '.claude/skills', `aspira-${step}`), { recursive: true })
    await writeFile(homeVersionFile(home, step), `${version}\n`)
  }
}

/** The driver fixture with no skills in the repository and every step skill staged under its temp HOME. */
export async function homeProject(options: Parameters<typeof project>[0]): Promise<Project> {
  const h = await project({ ...options, kitVersion: null })
  await stageKitHome(h.dir)
  return h
}
