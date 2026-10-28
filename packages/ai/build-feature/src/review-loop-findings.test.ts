// The files a blocking finding cites decide what the fix may edit. The PR reviewer writes the
// location as its own line, `Location: \`path:12-20\``, with no list bullet; a bulleted
// `- **Location:**` line is read the same way.
import { describe, expect, it } from 'vitest'
import { blockingFindings, outsideFindings } from './review-loop.ts'

const findings = (location: string) => ['# Findings', '', '## Medium', '', '### [REBA1.1] The fallback cuts off silently', '**What this means:** it stops at the limit.', '', location, '', '## Low', '', '### [L1] Nit', '', 'Location: `src/other.ts:3`', ''].join('\n')

describe('the files a blocking finding cites', () => {
  it('reads a Location line written without a list bullet, with a line range', () => {
    expect(blockingFindings(findings('Location: `packages/ai/pr-reviewer/agent/lib/local-source.ts:186-212`'))).toEqual({
      ok: true,
      findings: [{ id: 'REBA1.1', severity: 'medium', title: 'The fallback cuts off silently', files: ['packages/ai/pr-reviewer/agent/lib/local-source.ts'] }],
    })
  })

  it('still reads a bulleted, bold Location line', () => {
    const result = blockingFindings(findings('- **Location:** `src/a.ts:4`, `src/b.ts`'))
    expect(result.ok && result.findings[0]?.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('KIT-73: reads a cited path with a comma list of lines', () => {
    const result = blockingFindings(findings('Location: `codebase-map/src/map-root.ts:27,31`'))
    expect(result.ok && result.findings[0]?.files).toEqual(['codebase-map/src/map-root.ts'])
  })
})

describe('KIT-73: the files a fix may change', () => {
  const cite = (...files: string[]) => [{ id: 'H1', severity: 'high' as const, title: 'x', files }]

  it('lets a.ts and a.test.ts change when the finding cites a.ts:27,31 or a.ts:10-20, and still refuses an unrelated file', () => {
    expect(outsideFindings(['src/a.ts', 'src/a.test.ts', 'src/b.ts'], cite('src/a.ts:27,31'))).toEqual(['src/b.ts'])
    expect(outsideFindings(['src/a.ts', 'src/a.test.ts'], cite('src/a.ts:10-20'))).toEqual([])
  })

  it('accepts a test file the branch already changed, refuses a new unrelated test and a non-test file even when the branch changed it', () => {
    const route = 'apps/web/app/api/v1/cookbooks/[id]/route.ts'
    const suite = 'apps/web/tests/integration/meal-plan-cookbook-visibility.test.ts'
    const changed = [route, suite, 'apps/web/tests/integration/other.test.ts', 'apps/web/lib/db.ts']
    expect(outsideFindings(changed, cite(route), [suite, 'apps/web/lib/db.ts'])).toEqual(['apps/web/tests/integration/other.test.ts', 'apps/web/lib/db.ts'])
  })
})
