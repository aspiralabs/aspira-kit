// The files a blocking finding cites decide what the fix may edit. The PR reviewer writes the
// location as its own line, `Location: \`path:12-20\``, with no list bullet; a bulleted
// `- **Location:**` line is read the same way.
import { describe, expect, it } from 'vitest'
import { blockingFindings } from './review-loop.ts'

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
})
