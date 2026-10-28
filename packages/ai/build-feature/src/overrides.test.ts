// The overrides a run start finds on a pulled decisions page (F19): a tick moved off the agent's
// option is one, and a tick still on it is not, whichever form the recommended note comes back in
// (KIT-79: NOM-43's Build Summary listed every groomer answer as "changed from X to X (recommended)").

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findOverrides } from '#build-feature/overrides.ts'
import type { RunState } from '#build-feature/run-state.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const decision = { id: 'Q2', question: 'Should a hidden meal come back with a stub recipe?', options: ['Return the meal with a stub recipe', 'Leave the meal out'], recommended: 'Return the meal with a stub recipe', reasoning: 'the planner keeps its slot', whyYours: 'it is visible to members', decidedBy: 'agent' as const, answer: 'Return the meal with a stub recipe' }
const state = { takenKeys: [{ key: 'groomer:run-1:Q2', step: 'groomer', runId: 'run-1', decision }] } as unknown as RunState

async function overridesOf(page: string) {
  const dir = await mkdtemp(join(tmpdir(), 'build-feature-overrides-'))
  temps.push(dir)
  await writeFile(join(dir, 'groomer.md'), page)
  return findOverrides(state, { groomer: join(dir, 'groomer.md') }, 'run-2')
}

const pageTicking = (ticked: string, other: string) => `# Grooming Decisions\n\n## Q2 — ${decision.question}\n\n- [x] ${ticked}\n- [ ] ${other}\n`

describe('findOverrides: a tick still on the agent\'s option is no override (KIT-79)', () => {
  it.each([' (recommended)', ' (recommended: the planner keeps its slot)', ' *(recommended: the planner keeps its slot)*', ' _(recommended, taken by the agent: the planner keeps its slot)_'])('with the note "%s"', async (note) => {
    expect(await overridesOf(pageTicking(`Return the meal with a stub recipe${note}`, 'Leave the meal out'))).toEqual([])
  })

  it('still finds a tick moved to another option', async () => {
    const found = await overridesOf(pageTicking('Leave the meal out', 'Return the meal with a stub recipe (recommended)'))
    expect(found).toEqual([{ key: 'groomer:run-1:Q2', step: 'groomer', runId: 'run-1', from: 'Return the meal with a stub recipe', to: 'Leave the meal out', foundIn: 'run-2', page: 'Grooming Decisions' }])
  })
})
