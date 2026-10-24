// The manual path (BOARD-004): every Ready column is set by a human, never by a skill's gate.
// Pins the behaviour today so the skill-to-run-the-AI-DLC-end-to-end work never adds a gate move
// into a Ready status (F18; KIT-11 plan P2 T6).

import { describe, expect, it } from 'vitest'
import { GATES, SKILLS } from './ticket.ts'

describe('the manual Ready moves (T6)', () => {
  it('moves no card into a Ready: status from any skill gate\'s start or success move', () => {
    for (const skill of SKILLS) {
      const gate = GATES[skill]
      const targets = [gate.inProgress, gate.success].filter((status): status is string => status !== undefined)
      for (const target of targets) expect(target.startsWith('Ready:'), `${skill} moves a card to "${target}"`).toBe(false)
    }
  })
})
