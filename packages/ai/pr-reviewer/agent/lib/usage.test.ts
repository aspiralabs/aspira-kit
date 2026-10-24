import { describe, expect, it } from 'vitest'
import { cacheReadShare, callsPerRound, parseLedger, renderCallsPerRound, renderCostMarkdown, renderRoundOneCacheWrites, roundCallsFromTurns, roundOneCacheWrites, summarizeUsage, type UsageLine } from './usage.ts'

const line = (agent: string, sessionId: string, i: number, over: Partial<UsageLine> = {}): UsageLine => ({
  agent,
  sessionId,
  turnId: 't',
  stepIndex: i,
  at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  startedAt: new Date(1_700_000_000_000 + i * 1000 - 500).toISOString(),
  durationMs: 500,
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  costUsd: 0.5,
  ...over,
})

// Two rounds: six seats then Quinn, twice; then Nova and Dex write, Quinn and Nova check.
const ledger = (): UsageLine[] => {
  const lines: UsageLine[] = []
  let i = 0
  for (const round of [1, 2]) {
    for (const seat of ['ava', 'cole', 'nova', 'reba', 'dex', 'iris']) {
      lines.push(line(seat, `${seat}-r${round}`, i++), line(seat, `${seat}-r${round}`, i++))
    }
    lines.push(line('quinn', `quinn-r${round}`, i++))
  }
  lines.push(line('nova', 'nova-findings', i++), line('dex', 'dex-review', i++), line('quinn', 'quinn-check', i++), line('nova', 'nova-check', i++))
  return lines
}

describe('calls per seat per round', () => {
  it('attributes a seat\'s k-th session to round k and the rest to the documents', () => {
    const summary = summarizeUsage(ledger())
    const table = callsPerRound(roundCallsFromTurns(summary.byTurn, 2), 2)
    expect(table.ava).toEqual({ rounds: [2, 2], documents: 0 })
    expect(table.quinn).toEqual({ rounds: [1, 1], documents: 1 })
    expect(table.nova).toEqual({ rounds: [2, 2], documents: 2 })
    expect(table.dex).toEqual({ rounds: [2, 2], documents: 1 })
    const rendered = renderCallsPerRound(table, 2)
    expect(rendered).toContain('| Agent | Round 1 | Round 2 | Documents | Total |')
    expect(rendered).toContain('| nova | 2 | 2 | 2 | 6 |')
  })

  it('takes the driver\'s own round attribution for --local', () => {
    expect(callsPerRound([{ agent: 'ava', round: 1 }, { agent: 'ava', round: null }, { agent: 'quinn', round: 1 }], 1)).toEqual({
      ava: { rounds: [1], documents: 1 },
      quinn: { rounds: [1], documents: 0 },
    })
  })
})

describe('cost.md', () => {
  it('records the cache-read share, the packet size, the rounds and the budget', () => {
    const summary = summarizeUsage(parseLedger(ledger().map((l) => JSON.stringify(l)).join('\n')))
    expect(cacheReadShare(summary.total)).toBeCloseTo(0.8)
    const md = renderCostMarkdown('o/n#1', summary, { ava: 'm' }, { rounds: 2, changedLines: 1234, packet: { chars: 120_000, tokens: 30_000 }, budget: { maxCostUsd: 5, stopped: false }, settled: true })
    expect(md).toContain('Rounds: 2, ended by the stopping rule (a round with no dispute and no new finding). Changed lines: 1,234. Cache-read share: 80% of input tokens. Packet: 120,000 characters, about 30,000 tokens, at the start of every prompt.')
    expect(md).toContain('Budget: $5.00 (--max-cost); the run stayed under it.')
    expect(md).toContain('## Calls per seat per round')
    // Each agent's first session wrote 0 cache tokens in this fixture; the line still names every agent.
    expect(md).toContain('Round-one cache writes (each agent\'s first session): ava 0 · cole 0 · dex 0 · iris 0 · nova 0 · quinn 0 · reba 0; total 0')
    expect(md).toContain('| ava | 2 | 2 | 0 | 4 |')
    // The per-agent table is still there.
    expect(md).toContain('| Agent | Model | Calls | Input | Output | Cache read | Cache write | Cost |')
  })

  it('says when the budget stopped the run, and when there was none', () => {
    const summary = summarizeUsage(ledger().slice(0, 3))
    const stopped = renderCostMarkdown('x', summary, {}, { rounds: 1, packet: null, budget: { maxCostUsd: 1, stopped: true } })
    expect(stopped).toContain('Budget: $1.00 (--max-cost). **The run stopped after the call that crossed it, at $1.5000; the review is incomplete.**')
    expect(stopped).toContain('Packet: none')
    expect(renderCostMarkdown('x', summary, {})).toContain('Budget: none.')
    expect(cacheReadShare({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull()
  })
})

describe('round-one cache writes', () => {
  it('reports each agent\'s first-session cache writes and how many packet copies they add up to', () => {
    const summary = summarizeUsage([
      line('ava', 'ava-r1', 0, { cacheWriteTokens: 190_000 }),
      line('ava', 'ava-r1', 1, { cacheWriteTokens: 2_000 }),
      line('cole', 'cole-r1', 2, { cacheWriteTokens: 3_000 }),
      line('ava', 'ava-r2', 3, { cacheWriteTokens: 50_000 }),
    ])
    const rows = roundOneCacheWrites(summary.byTurn)
    expect(rows).toEqual([
      { agent: 'ava', cacheWriteTokens: 192_000 },
      { agent: 'cole', cacheWriteTokens: 3_000 },
    ])
    expect(renderRoundOneCacheWrites(rows, 185_000)).toBe('Round-one cache writes (each agent\'s first session): ava 192,000 · cole 3,000; total 195,000; the packet is about 185,000 tokens, so that is roughly 1.1 copies of it. One shared prefix shows as one write of about the packet size and small ones elsewhere.')
    expect(renderRoundOneCacheWrites([], null)).toBe('Round-one cache writes: none recorded.')
  })
})
