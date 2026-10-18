// NOVA1.1: the Playbook's Status table lives in agent-common (playbook.json, read through
// playbook.ts), so agent-common never depends on the kit CLI; kit imports the same JSON. Expected
// rows are copied from the Playbook itself (TEST-006), never recomputed from the module.
import { describe, expect, it } from 'vitest'
import { commandFor, nextStep, PLAYBOOK } from './playbook.ts'

describe('the Playbook Status table in agent-common (NOVA1.1)', () => {
  it('has the fifteen rows, from Idea to Dropped, in order', () => {
    expect(PLAYBOOK).toHaveLength(15)
    expect(PLAYBOOK[0]!.statuses).toEqual(['Idea', 'Grooming'])
    expect(PLAYBOOK.at(-1)!.statuses).toEqual(['Dropped'])
  })

  it('nextStep finds a Status case-insensitively, and null for a Status the table does not know', () => {
    expect(nextStep('ready: idea')?.command).toBe('/aspira-spec-writer <ID> --local')
    expect(nextStep(' In Review: Implementation ')?.command).toBe('/aspira-pr-reviewer <ID> --local')
    expect(nextStep('Not a status')).toBeNull()
  })

  it('commandFor fills in the ticket ID, and is null for a by-hand row', () => {
    expect(commandFor(nextStep('Ready: Plan')!, 'KIT-2')).toBe('/aspira-implementor KIT-2 --local')
    expect(commandFor(nextStep('Shortlist')!, 'KIT-2')).toBeNull()
  })

  it('keeps the Step 8 row\'s manual text', () => {
    expect(nextStep('In Progress: Implementation, after Step 7')?.manual).toBe('by hand (the progress note gives the commands)')
  })
})
