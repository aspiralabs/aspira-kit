import { describe, expect, it } from 'vitest'
import { renderReport } from './report.ts'
import type { LoopResult } from './loop.ts'

const diag = (tool: string, file: string) => ({ tool, file, line: 1, column: null, message: 'm', rule: null, severity: 'error' as const })
const base = (over: Partial<LoopResult>): LoopResult => ({ status: 'partial', reason: 'round cap (1) reached', rounds: [{ round: 1, autofix: [{ id: 'prettier', exitCode: 0, ms: 10 }], analyzers: [], targets: 2, batches: 1, edits: 1, rejected: 1, unresolved: ['src/b.ts:1 unclear'], ms: 1500 }], initial: [diag('eslint', 'src/a.ts'), diag('tsc', 'src/b.ts')], remaining: [diag('tsc', 'src/b.ts')], problems: [], editedFiles: ['src/a.ts'], rejected: [{ path: 'package.json', reason: 'protected path' }], ms: 2000, ...over })
const detection = { analyzers: [], ecosystems: ['js' as const], setup: [], notes: [], packageManager: 'pnpm' as const }

describe('renderReport', () => {
  it('renders before/after, rounds, rejected edits and unreported cost', () => {
    const md = renderReport({ label: '/repo', where: 'host', result: base({}), detection, unavailable: ['mypy (needs mypy)'], model: 'openai/gpt-6-sol', timing: { prepareMs: 100, loopMs: 2000, publishMs: 100, totalMs: 2200 }, remote: null,
      turns: [{ round: 1, batch: 1, model: 'openai/gpt-6-sol', turn: 1, startedMs: 0, durationMs: 900, status: 'completed', usage: { inputTokens: 1000, outputTokens: 50 } }] })
    expect(md).toContain('Status: **partial**. Stop reason: round cap (1) reached.')
    expect(md).toContain('| eslint | 1 | 0 |')
    expect(md).toContain('| tsc | 1 | 1 |')
    expect(md).toContain('| 1 | prettier | 2 | 1 | 1 | 1 | 1 | 1.5s |')
    expect(md).toContain('Reported model cost: **unreported**')
    expect(md).toContain('Unavailable on this executor: mypy (needs mypy)')
    expect(md).toContain('- package.json — protected path')
    expect(md).toContain('- error tsc src/b.ts:1 [-] m')
    expect(md).toContain('Wall time: **2.2s**')
  })
  it('renders clean, remote and reported cost', () => {
    const md = renderReport({ label: 'o/n', where: 'sandbox', result: base({ status: 'clean', reason: 'analyzers clean', remaining: [], rejected: [] }), detection, unavailable: [], model: 'm', timing: { prepareMs: 0, loopMs: 0, publishMs: 0, totalMs: 0 }, remote: { branch: 'static-analysis/x', commit: 'abcdef1234567', pushed: false, pullRequest: null },
      turns: [{ round: 1, batch: 1, model: 'm', turn: 1, startedMs: 0, status: 'completed', usage: {}, providerMetadata: { gateway: { cost: '0.0123' } } }] })
    expect(md).toContain('Status: **clean**')
    expect(md).toContain('Branch: `static-analysis/x` at abcdef1234; not pushed.')
    expect(md).toContain('**$0.0123**')
    expect(md).not.toContain('## Remaining diagnostics')
  })
})
