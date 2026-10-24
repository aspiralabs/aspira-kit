import { describe, expect, it } from 'vitest'
import { SEVERITIES, countBySeverity, findingsHeader, sentencesOf, severitySchema, sortBySeverity, totalFindings, whatThisMeansProblems, whatThisMeansSchema } from './severity.ts'

describe('severity order', () => {
  it('is critical, high, medium, low, info, and the schema accepts nothing else', () => {
    expect(SEVERITIES).toEqual(['critical', 'high', 'medium', 'low', 'info'])
    expect(severitySchema.safeParse('blocker').success).toBe(false)
  })

  it('sorts mixed severities into the fixed order and keeps the input order within a severity', () => {
    const items = [
      { id: 'a', severity: 'low' as const },
      { id: 'b', severity: 'critical' as const },
      { id: 'c', severity: 'info' as const },
      { id: 'd', severity: 'low' as const },
      { id: 'e', severity: 'high' as const },
      { id: 'f', severity: 'critical' as const },
    ]
    expect(sortBySeverity(items, (item) => item.severity).map((item) => item.id)).toEqual(['b', 'f', 'e', 'a', 'd', 'c'])
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('counts every item once, so the header total equals the body', () => {
    const items = [{ severity: 'low' as const }, { severity: 'critical' as const }, { severity: 'low' as const }]
    const counts = countBySeverity(items, (item) => item.severity)
    expect(counts).toEqual({ critical: 1, high: 0, medium: 0, low: 2, info: 0 })
    expect(totalFindings(counts)).toBe(3)
    expect(findingsHeader(counts)).toBe('3 findings: 1 critical · 0 high · 0 medium · 2 low · 0 info')
  })
})

describe('what this means', () => {
  it('counts sentences without splitting inside backticks', () => {
    expect(sentencesOf('Saved recipes vanish after a reload. The list in `lib/api/recipes.ts` (the code that fetches them) asks for page one every time.')).toHaveLength(2)
    expect(sentencesOf('')).toEqual([])
  })

  it('accepts one to three sentences and rejects more', () => {
    expect(whatThisMeansProblems('Members lose their saved items when they log out.')).toEqual([])
    expect(whatThisMeansProblems('One. Two. Three. Four.')).toEqual(['whatThisMeans has 4 sentences; the limit is 3'])
    expect(whatThisMeansProblems('   ')).toEqual(['whatThisMeans is empty'])
  })

  it('lets a one-word identifier pass, but a longer backticked token needs a definition in its sentence', () => {
    expect(whatThisMeansProblems('The `publicRecipeWhere` filter hides private recipes.')).toEqual([])
    expect(whatThisMeansProblems('The check lives in `lib/moderation/public-recipe.ts`, which is the one file that decides what the public sees.')).toEqual([])
    expect(whatThisMeansProblems('Run `pnpm test` (the unit tests) before shipping.')).toEqual([])
    expect(whatThisMeansProblems('Run `pnpm test` before shipping.')).toEqual(['whatThisMeans uses `pnpm test` without defining it in the same sentence'])
    // The definition has to be in the same sentence, not the next one.
    expect(whatThisMeansProblems('Open `apps/web/lib/x.ts`. It is the file that lists recipes.')).toHaveLength(1)
  })

  it('is the schema every finding carries', () => {
    expect(whatThisMeansSchema.safeParse('Members see an empty list.').success).toBe(true)
    expect(whatThisMeansSchema.safeParse('A. B. C. D.').success).toBe(false)
    expect(whatThisMeansSchema.safeParse('').success).toBe(false)
  })
})
