// checkGate under a client harness (KIT-68, F5 and F8): with `statusFlow: false` no skill looks at the card's
// Status and none makes a start move, while the groomer's Type gate and the duplicate-page check stay; with
// `pullRequest: false` the reviewer does not need the card's PR. With the defaults the results are today's.
//
// Contract these tests pin for the implementation:
//   checkGate(skill, ticket, options?)  options: { statusFlow?: boolean; pullRequest?: boolean }, both default true
import { describe, expect, it } from 'vitest'
import { checkGate, TYPE_OTHER_MESSAGE, type Skill } from './ticket.ts'

const base = { id: 'NOM-4', title: 'Explore pagination', pr: undefined as string | undefined }
const feature = (status: string) => ({ ...base, status, type: 'Feature' })
const chore = (status: string) => ({ ...base, status, type: 'Chore' })

const OFF = { statusFlow: false, pullRequest: false } as const
/** A Status no skill accepts, and the Status the reviewer's own row accepts (with no PR set). */
const STATUSES = ['Backlog', 'In Review: Implementation'] as const
const SKILLS: Skill[] = ['groomer', 'spec-writer', 'planner', 'pr-reviewer']

describe('checkGate with statusFlow false', () => {
  for (const skill of SKILLS) {
    for (const status of STATUSES) {
      it(`T23 passes a Feature card at "${status}" for the ${skill} with no start move`, () => {
        const gate = checkGate(skill, feature(status), OFF)
        expect([gate.ok, gate.ok && gate.startMove]).toEqual([true, null])
      })
    }
  }

  it('T23 passes the reviewer without a PR when pullRequest is false too', () => {
    expect(checkGate('pr-reviewer', feature('In Review: Implementation'), OFF)).toMatchObject({ ok: true, startMove: null })
  })

  it('T23 makes no start move from a Status the skill would claim from today', () => {
    expect(checkGate('groomer', feature('Idea'), OFF)).toMatchObject({ ok: true, startMove: null })
    expect(checkGate('spec-writer', feature('Ready: Idea'), OFF)).toMatchObject({ ok: true, startMove: null })
    expect(checkGate('planner', feature('Ready: Spec'), OFF)).toMatchObject({ ok: true, startMove: null })
  })

  it('T23 still refuses a Chore card at the groomer, and a card with no Type', () => {
    expect(checkGate('groomer', chore('Backlog'), OFF)).toEqual({ ok: false, message: TYPE_OTHER_MESSAGE('NOM-4 Explore pagination', 'groomer', 'Chore', ['Feature', 'Bug']) })
    expect(checkGate('groomer', { ...feature('Backlog'), type: '' }, OFF)).toMatchObject({ ok: false, message: expect.stringContaining('has no Type') })
  })

  it('T23 still refuses a ticket with two child pages of one title', () => {
    const duplicate = { ...feature('Backlog'), duplicatePages: [{ title: 'Grooming Decisions', pages: [{ id: 'a', title: 'Grooming Decisions', url: 'https://www.notion.so/a', lastEditedAt: '2026-10-05T00:00:00.000Z' }, { id: 'b', title: 'Grooming Decisions', url: 'https://www.notion.so/b', lastEditedAt: '2026-10-05T00:00:00.000Z' }] }] }
    expect(checkGate('groomer', duplicate, OFF)).toMatchObject({ ok: false, message: expect.stringContaining('2 child pages titled "Grooming Decisions"') })
  })
})

describe('checkGate with the defaults', () => {
  it('T23 refuses a Status the skill does not accept, as it does today', () => {
    expect(checkGate('spec-writer', feature('Backlog'))).toEqual({
      ok: false,
      message: 'NOM-4 Explore pagination is "Backlog"; spec-writer needs "Ready: Idea" or "In Review: Spec". "Ready: Idea" is set by a human, after grooming the idea. No model call was made.',
    })
    expect(checkGate('planner', feature('Backlog'))).toMatchObject({ ok: false, message: expect.stringContaining('planner needs "Ready: Spec"') })
  })

  it('T23 refuses the reviewer without a PR, as it does today', () => {
    expect(checkGate('pr-reviewer', feature('In Review: Implementation'))).toEqual({
      ok: false,
      message: 'NOM-4 Explore pagination is "In Review: Implementation" but its PR property is not set; pr-reviewer needs the PR. Set it (the implementor does, when it opens the PR). No model call was made.',
    })
  })

  it('T23 makes the start moves it makes today', () => {
    expect(checkGate('groomer', feature('Idea'))).toEqual({ ok: true, retry: false, startMove: { from: 'Idea', to: 'Grooming' } })
    expect(checkGate('spec-writer', feature('Ready: Idea'))).toEqual({ ok: true, retry: false, startMove: { from: 'Ready: Idea', to: 'In Progress: Spec' } })
  })

  it('T23 gives the same result for no options, empty options and both keys true', () => {
    for (const skill of SKILLS) {
      for (const status of [...STATUSES, 'Idea', 'Ready: Idea', 'Ready: Spec']) {
        const plain = checkGate(skill, feature(status))
        expect([checkGate(skill, feature(status), {}), checkGate(skill, feature(status), { statusFlow: true, pullRequest: true })]).toEqual([plain, plain])
      }
    }
  })
})
