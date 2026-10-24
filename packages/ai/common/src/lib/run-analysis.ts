export type PhaseTiming = { phase: string; ms: number; error: string | null }

export type UsageEntry = {
  phase: string
  model: string
  turn: number
  startedMs: number
  durationMs?: number
  status: 'running' | 'completed' | 'failed'
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  providerMetadata?: unknown
  finishReason?: string
  messages?: unknown
  text?: string
  toolCalls?: unknown
  toolResults?: unknown
}
export type RunTiming = { prepareMs: number; reviewMs: number; exportMs: number; totalMs: number; status: string }

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`
function reportedCost(entry: UsageEntry): number | null {
  const value = (entry.providerMetadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost
  if ((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value)
  return null
}

export function runAnalysis(ledger: UsageEntry[], phases: PhaseTiming[], timing: RunTiming) {
  const groups = new Map<string, { phase: string; model: string; turns: number; input: number; output: number; usd: number; reported: number }>()
  for (const entry of ledger) {
    const key = `${entry.phase}/${entry.model}`
    const group = groups.get(key) ?? { phase: entry.phase, model: entry.model, turns: 0, input: 0, output: 0, usd: 0, reported: 0 }
    group.turns++
    group.input += entry.usage.inputTokens ?? 0
    group.output += entry.usage.outputTokens ?? 0
    const value = reportedCost(entry)
    if (value !== null) { group.usd += value; group.reported++ }
    groups.set(key, group)
  }
  for (const phase of phases) if (![...groups.values()].some((group) => group.phase === phase.phase)) {
    groups.set(phase.phase, { phase: phase.phase, model: '—', turns: 0, input: 0, output: 0, usd: 0, reported: 0 })
  }
  const rows = [...groups.values()]
  const totals = rows.reduce((sum, row) => ({ usd: sum.usd + row.usd, input: sum.input + row.input, output: sum.output + row.output, reported: sum.reported + row.reported }), { usd: 0, input: 0, output: 0, reported: 0 })
  const costTotal = totals.reported ? `$${totals.usd.toFixed(4)}` : 'unreported'
  const markdown = [
    '# Run analysis', '', `Status: **${timing.status}**`, '',
    `Total reported cost: **${costTotal} USD**. Total wall time: **${seconds(timing.totalMs)}**.`, '',
    `Preparation: ${seconds(timing.prepareMs)}; review: ${seconds(timing.reviewMs)}; trace export: ${seconds(timing.exportMs)}.`, '',
    '## By agent', '',
    '| Agent | Model | Wall time | Turns | Input tokens | Output tokens | Reported cost | Cost reports | Status |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...rows.map((row) => {
      const phase = phases.find((item) => item.phase === row.phase)
      return `| ${row.phase} | ${row.model} | ${phase ? seconds(phase.ms) : '—'} | ${row.turns} | ${row.input} | ${row.output} | ${row.reported ? `$${row.usd.toFixed(4)}` : 'unreported'} | ${row.reported}/${row.turns} | ${phase?.error ? 'failed / cancelled' : phase ? 'completed' : 'unreported'} |`
    }),
    `| **TOTAL (run wall time)** | | **${seconds(timing.totalMs)}** | **${ledger.length}** | **${totals.input}** | **${totals.output}** | **${costTotal}** | ${totals.reported}/${ledger.length} | ${timing.status} |`, '',
    '## By turn', '',
    'A turn is one model invocation, including its tool execution. Start times are offsets from the start of the review runner.', '',
    '| Agent | Turn | Model | Started at | Wall time | Input tokens | Output tokens | Reported cost | Status |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...[...ledger].sort((a, b) => a.startedMs - b.startedMs).map((entry) => {
      const cost = reportedCost(entry)
      return `| ${entry.phase} | ${entry.turn} | ${entry.model} | ${seconds(entry.startedMs)} | ${entry.durationMs === undefined ? 'unreported' : seconds(entry.durationMs)} | ${entry.usage.inputTokens ?? 'unreported'} | ${entry.usage.outputTokens ?? 'unreported'} | ${cost === null ? 'unreported' : `$${cost.toFixed(4)}`} | ${entry.status} |`
    }),
    `| **TOTAL** | **${ledger.length}** | | | **${seconds(timing.totalMs)} run wall time** | **${totals.input}** | **${totals.output}** | **${costTotal}** | ${timing.status} |`, '',
    'Parallel agent/turn durations overlap. Total wall time is measured from runner entry through trace export, not summed; final summary writes and atomic publication follow this measurement. Token totals include reported usage only. Partial cost reports are subtotals, not estimates of missing charges.', '',
    'Scope: direct review runner only. Excludes eve routing and guideline loading before runner entry, MCP infrastructure charges, and provider usage not reported after cancellation. Unreported cost is not zero. See trace/usage.json for turn records, trace/calls.json for prompts and outputs, and trace/review.json for decisions, timings and errors.', '',
  ].join('\n')
  return { markdown, reportedCostUsd: totals.usd }
}
