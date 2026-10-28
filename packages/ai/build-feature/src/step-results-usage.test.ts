// KIT-80: a step report's usage written in USAGE_REPORT_SHAPE, with null for each number the Agent
// tool did not report, is read as reported, never as invalid. The NOM-43 pr-reviewer step wrote
// startedAt/endedAt null and the run stored the whole usage as not measured (gap invalid), dropping
// whatever else it held.

import { describe, expect, it } from 'vitest'
import { readStepUsage } from '#build-feature/step-results.ts'

describe('readStepUsage (KIT-80)', () => {
  it('reads null fields as not reported and keeps the rest, the subagents included', () => {
    const usage = readStepUsage({
      tokens: null,
      wallMs: null,
      model: null,
      toolUses: null,
      startedAt: null,
      endedAt: null,
      subagents: [{ label: 'seat a', startedAt: '2026-10-27T20:12:00Z', endedAt: '2026-10-27T20:14:00Z', totalTokens: 90000, toolUses: 12, wallMs: 120000, model: null }],
    })
    expect(usage).toEqual({ tokens: null, wallMs: null, subagents: [{ startedAt: '2026-10-27T20:12:00Z', endedAt: '2026-10-27T20:14:00Z', totalTokens: 90000, toolUses: 12, wallMs: 120000 }] })
  })

  it("keeps the step subagent's own numbers when its times are null", () => {
    expect(readStepUsage({ tokens: 120000, wallMs: 600000, model: 'claude-opus-5-5', toolUses: 30, startedAt: null, endedAt: null, subagents: [] })).toEqual({ tokens: 120000, wallMs: 600000, model: 'claude-opus-5-5', toolUses: 30, subagents: [] })
  })

  it('still reads a wrong type as invalid', () => {
    expect(readStepUsage({ tokens: 'many', subagents: [] })).toEqual({ tokens: null, wallMs: null, gap: 'invalid' })
    expect(readStepUsage({ tokens: 1, wallMs: 1, subagents: [{ totalTokens: -1 }] })).toEqual({ tokens: 1, wallMs: 1, subagents: [{ gap: 'invalid' }] })
  })
})
