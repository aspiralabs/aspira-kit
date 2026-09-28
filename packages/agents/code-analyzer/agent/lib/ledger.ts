export type Turn = {
  round: number
  batch: number
  model: string
  turn: number
  startedMs: number
  durationMs?: number
  status: 'running' | 'completed' | 'failed'
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  providerMetadata?: unknown
  finishReason?: string
  text?: string
  toolCalls?: unknown
  toolResults?: unknown
}

export function reportedCost(turn: Turn): number | null {
  const value = (turn.providerMetadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost
  if ((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value)
  return null
}

export class Ledger {
  readonly turns: Turn[] = []
  private readonly started: number
  constructor(started: number) { this.started = started }
  start(round: number, batch: number, model: string, turn: number): Turn {
    const entry: Turn = { round, batch, model, turn, startedMs: Date.now() - this.started, status: 'running', usage: {} }
    this.turns.push(entry)
    return entry
  }
  end(entry: Turn, patch: Partial<Turn>): void {
    Object.assign(entry, patch, { durationMs: Date.now() - this.started - entry.startedMs, status: patch.status ?? 'completed' })
  }
  failRunning(): void {
    for (const turn of this.turns) if (turn.status === 'running') { turn.status = 'failed'; turn.durationMs = Date.now() - this.started - turn.startedMs }
  }
  totals(): { usd: number; reported: number; input: number; output: number } {
    return this.turns.reduce((sum, turn) => {
      const cost = reportedCost(turn)
      return { usd: sum.usd + (cost ?? 0), reported: sum.reported + (cost === null ? 0 : 1), input: sum.input + (turn.usage.inputTokens ?? 0), output: sum.output + (turn.usage.outputTokens ?? 0) }
    }, { usd: 0, reported: 0, input: 0, output: 0 })
  }
  costUsd(): number { return this.totals().usd }
}
