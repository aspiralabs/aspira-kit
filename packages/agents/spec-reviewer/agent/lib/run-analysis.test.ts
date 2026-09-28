import { expect, it } from 'vitest'
import { runAnalysis } from './run-analysis.ts'

it('reports turns and agents while keeping concurrent durations separate from wall time', () => {
  const report = runAnalysis([
    { phase: 'research', model: 'frontier', turn: 1, startedMs: 100, durationMs: 1200, status: 'completed', usage: { inputTokens: 100, outputTokens: 10 }, providerMetadata: { gateway: { cost: '0.25' } } },
    { phase: 'security', model: 'specialist', turn: 1, startedMs: 1300, durationMs: 500, status: 'completed', usage: { inputTokens: 20, outputTokens: 5 }, providerMetadata: { gateway: { cost: 0 } } },
    { phase: 'security', model: 'specialist', turn: 2, startedMs: 1800, durationMs: 700, status: 'failed', usage: { inputTokens: 30, outputTokens: 7 } },
    { phase: 'ui', model: 'specialist', turn: 1, startedMs: 1300, durationMs: 600, status: 'completed', usage: {}, providerMetadata: { gateway: { cost: null } } },
  ], [
    { phase: 'research', ms: 1200, error: null },
    { phase: 'security', ms: 1200, error: 'Cancelled' },
    { phase: 'ui', ms: 600, error: null },
    { phase: 'synthesis', ms: 1000, error: 'Cancelled before first turn' },
  ], { prepareMs: 100, reviewMs: 3400, exportMs: 100, totalMs: 3600, status: 'incomplete' })
  expect(report.reportedCostUsd).toBe(0.25)
  expect(report.markdown).toContain('Total wall time: **3.60s**')
  expect(report.markdown).toContain('| research | frontier | 1.20s | 1 | 100 | 10 | $0.2500 | 1/1 | completed |')
  expect(report.markdown).toContain('| security | specialist | 1.20s | 2 | 50 | 12 | $0.0000 | 1/2 | failed / cancelled |')
  expect(report.markdown).toContain('| security | 2 | specialist | 1.80s | 0.70s | 30 | 7 | unreported | failed |')
  expect(report.markdown).toContain('| synthesis | — | 1.00s | 0 | 0 | 0 | unreported | 0/0 | failed / cancelled |')
  expect(report.markdown).toContain('| **TOTAL (run wall time)** | | **3.60s** | **4** | **150** | **22** | **$0.2500** | 2/4 | incomplete |')
})
