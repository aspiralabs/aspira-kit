// Research with the parallel explorers' findings folded in (runner.ts withExplorations).
import { describe, expect, it } from 'vitest'
import { withExplorations } from './runner.ts'

const touch = (path: string, why: string) => ({ path, operation: 'modify' as const, symbols: ['x'], why })

describe('withExplorations', () => {
  it('puts the explorers\' facts first, keeps one touch per path, and lets research\'s own entry win', () => {
    const research = { facts: ['research fact'], checks: [], gaps: [], decisions: [], touches: [touch('a.ts', 'research')] }
    const merged = withExplorations(research, [
      { result: { facts: ['explorer fact', 'research fact'], touches: [touch('a.ts', 'explorer'), touch('b.ts', 'explorer')], gaps: [] } },
    ])
    expect({ facts: merged.facts, touches: merged.touches?.map((t) => `${t.path}:${t.why}`) }).toEqual({ facts: ['explorer fact', 'research fact'], touches: ['a.ts:research', 'b.ts:explorer'] })
  })

  it('leaves research untouched when there were no explorers', () => {
    const research = { facts: ['f'], checks: [], gaps: [], decisions: [] }
    expect(withExplorations(research, [])).toBe(research)
  })
})
