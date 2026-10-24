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

/** The share of every input token that was served from cache: the number the packet is meant to raise. */
export function cacheReadShare(totals: Pick<UsageTotals, 'inputTokens' | 'cacheReadTokens'>): number | null {
  return totals.inputTokens === 0 ? null : totals.cacheReadTokens / totals.inputTokens
}

/** One child invocation attributed to a round: a seat's or Quinn's k-th session is round k; the rest are the documents. */
export type RoundCall = { agent: string; round: number | null }

/**
 * Model calls per agent per round. For the agent's ledger, where a session is one child turn,
 * a seat's k-th session (in start order) is its round-k turn while k is within the rounds, and
 * anything after is the document work. For --local, the driver knows the round of every call.
 */
export function callsPerRound(calls: RoundCall[], rounds: number): Record<string, { rounds: number[]; documents: number }> {
  const table: Record<string, { rounds: number[]; documents: number }> = {}
  for (const call of calls) {
    const row = (table[call.agent] ??= { rounds: Array.from({ length: rounds }, () => 0), documents: 0 })
    if (call.round === null || call.round < 1 || call.round > rounds) row.documents += 1
    else row.rounds[call.round - 1] = (row.rounds[call.round - 1] ?? 0) + 1
  }
  return table
}

/** The sessions of the ledger as round calls, by the k-th-session rule above. Each session counts its steps. */
export function roundCallsFromTurns(turns: TurnTotals[], rounds: number): RoundCall[] {
  const seen = new Map<string, number>()
  return turns.map((turn) => {
    const k = (seen.get(turn.agent) ?? 0) + 1
    seen.set(turn.agent, k)
    return { agent: turn.agent, round: k <= rounds ? k : null, steps: turn.steps }
  }).flatMap((call) => Array.from({ length: call.steps }, () => ({ agent: call.agent, round: call.round })))
}

/**
 * Cache-write tokens of each agent's first session: round one, where the shared prefix is
 * written. Six copies of the packet show as six writes of about the packet size; one shared
 * prefix shows as one write (the warm-up or the first seat) and small writes for the rest.
 */
export function roundOneCacheWrites(turns: TurnTotals[]): { agent: string; cacheWriteTokens: number }[] {
  const seen = new Set<string>()
  const rows: { agent: string; cacheWriteTokens: number }[] = []
  for (const turn of turns) {
    if (seen.has(turn.agent)) continue
    seen.add(turn.agent)
    rows.push({ agent: turn.agent, cacheWriteTokens: turn.cacheWriteTokens })
  }
  return rows.toSorted((a, b) => a.agent.localeCompare(b.agent))
}

export function renderRoundOneCacheWrites(rows: { agent: string; cacheWriteTokens: number }[], packetTokens: number | null): string {
  if (rows.length === 0) return 'Round-one cache writes: none recorded.'
  const total = rows.reduce((sum, row) => sum + row.cacheWriteTokens, 0)
  const copies = packetTokens === null || packetTokens === 0 ? '' : `; the packet is about ${num(packetTokens)} tokens, so that is roughly ${(total / packetTokens).toFixed(1)} copies of it`
  return `Round-one cache writes (each agent's first session): ${rows.map((row) => `${row.agent} ${num(row.cacheWriteTokens)}`).join(' · ')}; total ${num(total)}${copies}. One shared prefix shows as one write of about the packet size and small ones elsewhere.`
}

export function renderCallsPerRound(table: Record<string, { rounds: number[]; documents: number }>, rounds: number): string {
  const header = `| Agent | ${Array.from({ length: rounds }, (_, i) => `Round ${i + 1}`).join(' | ')} | Documents | Total |`
  const divider = `| --- | ${Array.from({ length: rounds }, () => '---:').join(' | ')} | ---: | ---: |`
  const rows = Object.entries(table)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, row]) => `| ${agent} | ${row.rounds.map((n) => String(n)).join(' | ')} | ${row.documents} | ${row.rounds.reduce((sum, n) => sum + n, 0) + row.documents} |`)
  return `## Calls per seat per round

One row per agent: model calls in each round, then in the document stage (writing and checking findings.md and review.md).

${header}
${divider}
${rows.join('\n')}
`
}

export type CostExtras = {
  rounds: number
  /** Added plus deleted lines of the diff reviewed; what the estimate scales by. */
  changedLines?: number
  /** The packet every prompt started with; null when none was built. */
  packet: { chars: number; tokens: number } | null
  /** The --max-cost budget, and whether the run stopped at it. */
  budget: { maxCostUsd: number; stopped: boolean } | null
  /** The loop ended by the stopping rule rather than at the cap. */
  settled?: boolean
}

export function renderCostMarkdown(
  title: string,
  summary: ReturnType<typeof summarizeUsage>,
  models: Record<string, string>,
  extras: CostExtras = { rounds: 0, packet: null, budget: null },
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
  const share = cacheReadShare(t)
  const budget =
    extras.budget === null
      ? 'Budget: none.'
      : extras.budget.stopped
        ? `Budget: $${extras.budget.maxCostUsd.toFixed(2)} (--max-cost). **The run stopped after the call that crossed it, at ${usd(t.costUsd)}; the review is incomplete.**`
        : `Budget: $${extras.budget.maxCostUsd.toFixed(2)} (--max-cost); the run stayed under it.`
  const packet =
    extras.packet === null
      ? 'Packet: none (the seats read the changed files themselves).'
      : `Packet: ${num(extras.packet.chars)} characters, about ${num(extras.packet.tokens)} tokens, at the start of every prompt.`
  const roundsLine = extras.rounds > 0 ? `Rounds: ${extras.rounds}${extras.settled === true ? ', ended by the stopping rule (a round with no dispute and no new finding)' : ''}. ` : ''
  const linesLine = extras.changedLines === undefined ? '' : `Changed lines: ${num(extras.changedLines)}. `
  const perRound = extras.rounds > 0 ? `\n${renderCallsPerRound(callsPerRound(roundCallsFromTurns(summary.byTurn, extras.rounds), extras.rounds), extras.rounds)}` : ''
  const writes = renderRoundOneCacheWrites(roundOneCacheWrites(summary.byTurn), extras.packet?.tokens ?? null)
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

${roundsLine}${linesLine}Cache-read share: ${share === null ? '—' : `${Math.round(100 * share)}%`} of input tokens. ${packet}
${budget}
${writes}
${perRound}
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
