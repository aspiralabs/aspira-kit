// The planner's parallel explorers split the spec's source packet by area; later phases get the packet's index only.
import { describe, expect, it } from 'vitest'
import { exploreAreas, packetIndex } from './repository.ts'

const files = new Map([
  ['packages/kit/src/skills.ts', 'export const a = 1\n'],
  ['packages/kit/src/doctor.ts', 'export const b = 1\n'],
  ['packages/agents/planner/agent/lib/local.ts', 'export const c = 1\n'],
  ['packages/agents/groomer/agent/lib/local.ts', 'export const d = 1\n'],
  ['README.md', '# Kit\n\nLine three.\n'],
])
const spec = 'Touch `packages/kit/src/skills.ts`, `packages/kit/src/doctor.ts`, `packages/agents/planner/agent/lib/local.ts`, `packages/agents/groomer/agent/lib/local.ts` and `README.md`.'

describe('exploreAreas', () => {
  it('groups the packet by area, an agent folder by its own name, largest first', () => {
    expect(exploreAreas(spec, files)).toEqual([
      { name: 'packages/kit', files: ['packages/kit/src/skills.ts', 'packages/kit/src/doctor.ts'] },
      { name: '.', files: ['README.md'] },
      { name: 'packages/agents/groomer', files: ['packages/agents/groomer/agent/lib/local.ts'] },
      { name: 'packages/agents/planner', files: ['packages/agents/planner/agent/lib/local.ts'] },
    ])
  })

  it('folds the smallest areas into the last one past the limit, and returns none for a single area', () => {
    const areas = exploreAreas(spec, files, 2)
    expect(areas.map((area) => [area.name, area.files.length])).toEqual([['packages/kit', 2], ['., packages/agents/groomer, packages/agents/planner', 3]])
    expect(exploreAreas('Touch `packages/kit/src/skills.ts`.', files)).toEqual([])
  })
})

describe('packetIndex', () => {
  it('lists the packet files with their line counts and none of their content', () => {
    const index = packetIndex('Touch `README.md`.', files)
    expect([index.includes('- README.md (4 lines)'), index.includes('Line three.')]).toEqual([true, false])
    expect(packetIndex('Nothing named.', files)).toBe('')
  })
})
