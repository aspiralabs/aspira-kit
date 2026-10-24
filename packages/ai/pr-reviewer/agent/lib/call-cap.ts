// The per-round tool-call cap. Every child turn (one seat, one round) is its own eve session,
// so a counter keyed by session id is a counter per round. The usage hook counts every action
// the model requests; read_files and search check the count and refuse past the cap, telling
// the seat to write with what it has. The built-in tools cannot be refused from here, so the
// prompt states the cap too. Module state: the hook and the tools run in one app process.

export const DEFAULT_MAX_SEAT_CALLS = 8
export const MAX_SEAT_CALLS_ENV = 'MAX_SEAT_CALLS'

/** The cap: MAX_SEAT_CALLS when it is a whole number of at least 1, else the default. */
export function maxSeatCalls(env: Record<string, string | undefined> = process.env): number {
  const value = Number.parseInt(env[MAX_SEAT_CALLS_ENV] ?? '', 10)
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_SEAT_CALLS
}

const calls = new Map<string, number>()

export function recordCalls(sessionId: string, count: number): void {
  calls.set(sessionId, (calls.get(sessionId) ?? 0) + count)
}

export function callsSoFar(sessionId: string): number {
  return calls.get(sessionId) ?? 0
}

export function forgetSession(sessionId: string): void {
  calls.delete(sessionId)
}

export type CapRefusal = { refused: true; unread: string[]; reason: string }

/** The tool result at the cap, or null while the seat still has calls left. */
export function capRefusal(made: number, cap: number, unread: string[]): CapRefusal | null {
  if (made < cap) return null
  return {
    refused: true,
    unread,
    reason: `You have made ${made} tool calls this round, the cap (${MAX_SEAT_CALLS_ENV}). Write your round file now with what you have, and list under "Not read" every path you wanted and did not get: ${unread.join(', ')}.`,
  }
}
