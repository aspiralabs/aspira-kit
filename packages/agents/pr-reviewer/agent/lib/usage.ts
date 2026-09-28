// Pure usage accounting. The hook in usage-hook.ts writes the lines; export-review
// reads them back and renders cost.md.

export const USAGE_LEDGER = '/workspace/usage.jsonl'

export type UsageLine = {
  agent: string
  sessionId: string
  turnId: string
  stepIndex: number
  /** When the step finished. */
  at: string
  /** When the model call started. Absent in ledgers written before timing was recorded. */
  startedAt?: string
  /** Wall clock for the model call itself, excluding the tool work between calls. */
  durationMs?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
}

export type UsageTotals = {
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  /** Steps whose provider reported no cost; the costUsd column is a lower bound when > 0. */
  unpriced: number
  /** Summed duration of this agent's model calls. Less than its wall clock: tool work sits between calls. */
  modelMs: number
  /** Steps with no recorded duration, from an older ledger. modelMs is a lower bound when > 0. */
  untimed: number
  /** Epoch ms of the first step start and the last step end, for the wall-clock span. Both 0 when steps is 0. */
  firstMs: number
  lastMs: number
}

const empty = (): UsageTotals => ({
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpriced: 0,
  modelMs: 0,
  untimed: 0,
  firstMs: 0,
  lastMs: 0,
})

/** One child agent invocation: eve gives every `ctx.agent()` call its own session id. */
export type TurnTotals = UsageTotals & {
  agent: string
  sessionId: string
  /** Largest single-call input, i.e. how big the context grew by the end of the turn. */
  peakContextTokens: number
}

const endMs = (l: UsageLine) => Date.parse(l.at)
const startMs = (l: UsageLine) => (l.startedAt === undefined ? Date.parse(l.at) : Date.parse(l.startedAt))

function add(target: UsageTotals, l: UsageLine): void {
  target.steps += 1
  target.inputTokens += l.inputTokens
  target.outputTokens += l.outputTokens
  target.cacheReadTokens += l.cacheReadTokens
  target.cacheWriteTokens += l.cacheWriteTokens
  if (l.costUsd === null) target.unpriced += 1
  else target.costUsd += l.costUsd
  if (l.durationMs === undefined) target.untimed += 1
  else target.modelMs += l.durationMs
  // No Infinity sentinel: this object is returned from a tool, and eve rejects a
  // non-JSON-serializable result. The first line seeds the span instead.
  target.firstMs = target.steps === 1 ? startMs(l) : Math.min(target.firstMs, startMs(l))
  target.lastMs = Math.max(target.lastMs, endMs(l))
}

export function parseLedger(text: string): UsageLine[] {
  const lines: UsageLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      lines.push(JSON.parse(line) as UsageLine)
    } catch {
      // A torn line from a concurrent append. Skip it rather than lose the report.
    }
  }
  return lines
}

export function summarizeUsage(lines: UsageLine[]): {
  byAgent: Record<string, UsageTotals>
  byTurn: TurnTotals[]
  total: UsageTotals
} {
  const byAgent: Record<string, UsageTotals> = {}
  const turns = new Map<string, TurnTotals>()
  const total = empty()
  for (const l of lines) {
    add((byAgent[l.agent] ??= empty()), l)
    add(total, l)
    let turn = turns.get(l.sessionId)
    if (turn === undefined) {
      turn = { ...empty(), agent: l.agent, sessionId: l.sessionId, peakContextTokens: 0 }
      turns.set(l.sessionId, turn)
    }
    add(turn, l)
    turn.peakContextTokens = Math.max(turn.peakContextTokens, l.inputTokens)
  }
  return { byAgent, byTurn: [...turns.values()].sort((a, b) => a.firstMs - b.firstMs), total }
}

const usd = (n: number) => `$${n.toFixed(4)}`
const num = (n: number) => n.toLocaleString('en-US')

/** `6m 27s`, `47s`. Durations here run from seconds to tens of minutes; hours would be a runaway. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`
}

/** `+6:27` from the start of the run, so turns line up against the wall clock. */
const offset = (ms: number): string => {
  const total = Math.round(ms / 1000)
  return `+${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const pct = (part: number, whole: number) => (whole === 0 ? '—' : `${Math.round((100 * part) / whole)}%`)

export function renderCostMarkdown(
  title: string,
  summary: ReturnType<typeof summarizeUsage>,
  models: Record<string, string>,
): string {
  const t = summary.total
  const wallMs = t.lastMs - t.firstMs
  const rows = Object.entries(summary.byAgent)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([agent, a]) =>
        `| ${agent} | ${models[agent] ?? ''} | ${a.steps} | ${num(a.inputTokens)} | ${num(a.outputTokens)} | ${num(a.cacheReadTokens)} | ${num(a.cacheWriteTokens)} | ${usd(a.costUsd)} |`,
    )
  const timingRows = Object.entries(summary.byAgent)
    .sort(([, a], [, b]) => b.modelMs - a.modelMs)
    .map(([agent, a]) => {
      // An older ledger has no durations at all; an em dash beats a confident 0s.
      const timed = a.untimed < a.steps
      return `| ${agent} | ${a.steps} | ${timed ? duration(a.modelMs) : '—'} | ${timed ? pct(a.modelMs, wallMs) : '—'} | ${duration(a.lastMs - a.firstMs)} |`
    })
  const turnRows = summary.byTurn.map(
    (turn, i) =>
      `| ${i + 1} | ${turn.agent} | ${turn.steps} | ${offset(turn.firstMs - t.firstMs)} | ${duration(turn.lastMs - turn.firstMs)} | ${num(turn.peakContextTokens)} | ${usd(turn.costUsd)} |`,
  )
  const costCaveat =
    t.unpriced > 0 ? `\n${t.unpriced} of ${t.steps} model calls reported no cost, so the totals are a lower bound.\n` : ''
  const timeCaveat =
    t.untimed > 0 ? `\n${t.untimed} of ${t.steps} model calls have no recorded duration, so model time is a lower bound.\n` : ''

  return `# Cost: ${title}

| Agent | Model | Calls | Input | Output | Cache read | Cache write | Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}
| **Total** | | ${t.steps} | ${num(t.inputTokens)} | ${num(t.outputTokens)} | ${num(t.cacheReadTokens)} | ${num(t.cacheWriteTokens)} | **${usd(t.costUsd)}** |
${costCaveat}
Model token cost as reported by the Vercel AI Gateway per call. Excludes sandbox compute.
Input counts every token sent on every call, so a turn's context is billed again each step; \`cache read\` is the part that was served from cache.

## Timing

Wall clock: **${duration(wallMs)}**.

| Agent | Calls | Model time | Share of wall clock | First call to last |
| --- | ---: | ---: | ---: | ---: |
${timingRows.join('\n')}
${timeCaveat}
Model time is the sum of the agent's own model calls. It falls short of "first call to last" by the time spent running tools between calls, and the shares can exceed 100% because the six review seats run in parallel.

### By turn

One row per child invocation: the six seats run together, then the verifier rules on the round. At the end two seats write a document each and two check the other's.

| # | Agent | Calls | Start | Duration | Peak context | Cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
${turnRows.join('\n')}
`
}
