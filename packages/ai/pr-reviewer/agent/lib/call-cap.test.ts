import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_SEAT_CALLS, callsSoFar, capRefusal, forgetSession, maxSeatCalls, recordCalls } from './call-cap.ts'

describe('maxSeatCalls', () => {
  it('defaults to 8 and reads MAX_SEAT_CALLS when it is a whole number of at least 1', () => {
    expect(DEFAULT_MAX_SEAT_CALLS).toBe(8)
    expect(maxSeatCalls({})).toBe(8)
    expect(maxSeatCalls({ MAX_SEAT_CALLS: '12' })).toBe(12)
    expect(maxSeatCalls({ MAX_SEAT_CALLS: '0' })).toBe(8)
    expect(maxSeatCalls({ MAX_SEAT_CALLS: 'lots' })).toBe(8)
  })
})

describe('the per-round counter', () => {
  it('counts tool calls per session and forgets a session when it ends', () => {
    recordCalls('s1', 3)
    recordCalls('s1', 2)
    recordCalls('s2', 1)
    expect(callsSoFar('s1')).toBe(5)
    expect(callsSoFar('s2')).toBe(1)
    forgetSession('s1')
    expect(callsSoFar('s1')).toBe(0)
  })
})

describe('capRefusal', () => {
  it('forces a write with the unread list once the cap is reached', () => {
    const refusal = capRefusal(8, 8, ['a.ts', 'b.ts'])
    expect(refusal).toEqual({
      refused: true,
      unread: ['a.ts', 'b.ts'],
      reason: 'You have made 8 tool calls this round, the cap (MAX_SEAT_CALLS). Write your round file now with what you have, and list under "Not read" every path you wanted and did not get: a.ts, b.ts.',
    })
    expect(capRefusal(3, 8, ['a.ts'])).toBeNull()
  })
})
