// The implementor's target check walks the plan in order: a file an earlier task creates exists, one
// it deletes does not, and a move puts a file or a whole directory at its new path (KIT-65).
import { describe, expect, it } from 'vitest'
import { targetProblems, type Plan } from './local-plan.ts'

const repo = new Set(['packages/kit/src/skills.ts', 'packages/kit/package.json', 'README.md'])
const exists = (path: string) => repo.has(path) || [...repo].some((file) => file.startsWith(`${path}/`))
const change = (operation: 'create' | 'modify' | 'delete' | 'move', path: string, from?: string) => ({ operation, path, ...(from === undefined ? {} : { from }) })
const planOf = (...changes: ReturnType<typeof change>[][]): Plan => ({ tasks: changes.map((list, i) => ({ id: `P${i + 1}`, changes: list })) }) as unknown as Plan

describe('targetProblems', () => {
  it('accepts edits at a moved directory\'s new path, and a modify of a file an earlier task creates', () => {
    expect(targetProblems(planOf([change('move', 'packages/ai', 'packages/kit')], [change('modify', 'packages/ai/src/skills.ts'), change('create', 'packages/ai/src/version-check.ts')], [change('modify', 'packages/ai/src/version-check.ts')]), exists)).toEqual([])
  })

  it('calls the old path missing after the move, and a target missing when no move puts it there', () => {
    expect(targetProblems(planOf([change('move', 'packages/ai', 'packages/kit')], [change('modify', 'packages/kit/src/skills.ts')]), exists)).toEqual(['P2 modifys packages/kit/src/skills.ts, which does not exist.'])
    expect(targetProblems(planOf([change('modify', 'packages/ai/src/skills.ts')]), exists)).toEqual(['P1 modifys packages/ai/src/skills.ts, which does not exist.'])
  })

  it('refuses a move from nowhere or onto an existing path', () => {
    expect(targetProblems(planOf([change('move', 'README.md', 'docs')]), exists)).toEqual(['P1 moves docs, which does not exist.', 'P1 moves docs to README.md, which already exists.'])
  })
})
