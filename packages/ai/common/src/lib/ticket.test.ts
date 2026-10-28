import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import boardTool from '../tools/board'
import { readRunStatus } from './run-status.ts'
import {
  GATES,
  RUN_STATUSES,
  SKILLS,
  TOOL_SKILLS,
  TicketArgumentError,
  checkGate,
  endMove,
  parseTicketMd,
  pullDecision,
  pushesFor,
  renderTicketMd,
  reportHeader,
  slug,
  ticketArgument,
  ticketMdFormat,
  whoMoves,
  workFolderName,
  type BoardTrace,
  type TicketRecord,
} from './ticket'

const ticket: TicketRecord = {
  id: 'NOM-4',
  title: 'Explore pagination',
  url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1',
  status: 'Ready: Spec',
  type: 'Feature',
  priority: 'P0 - Critical',
  area: ['Discover', 'Search'],
  dev: 'Claude',
  pr: undefined,
  version: undefined,
  pulledAt: '2026-10-06T05:00:00.000Z',
  idea: 'Every list stops at 10 | twenty.\n\n- Unblocks search.\n',
  pages: {
    Spec: { id: '3ec3e59b-2258-8100-0000-00000000000a', title: 'Spec', url: 'https://www.notion.so/3ec3e59b22588100000000000000000a', lastEditedAt: '2026-10-01T02:10:00.000Z' },
    'Spec Reviewed': { id: '3ec3e59b-2258-8123-961c-ce4ccd8e662a', title: 'Spec Reviewed', url: 'https://www.notion.so/3ec3e59b22588123961cce4ccd8e662a', lastEditedAt: '2026-10-05T04:48:12.063Z' },
  },
}

describe('the gate table', () => {
  it('names every skill, and the spec rows', () => {
    expect(Object.keys(GATES)).toEqual([...SKILLS])
    expect(GATES['spec-writer']).toMatchObject({ accepts: ['Ready: Idea', 'In Review: Spec'], inProgress: 'In Progress: Spec', success: 'In Review: Spec', startFrom: ['Ready: Idea'] })
    expect(GATES.planner).toMatchObject({ accepts: ['Ready: Spec', 'In Review: Plan'], inProgress: 'In Progress: Plan', success: 'In Review: Plan' })
    expect(GATES.implementor).toMatchObject({ accepts: ['Ready: Plan'], inProgress: 'In Progress: Implementation', success: 'In Review: Implementation' })
    expect(GATES['code-analyzer']).toMatchObject({ accepts: ['In Progress: Implementation', 'In Review: Implementation'], pushes: [] })
    expect(GATES['pr-reviewer']).toMatchObject({ accepts: ['In Review: Implementation'], requires: 'PR' })
  })

  it('every row refuses on the wrong Status with the ticket, its Status, the Status needed and who moves it', () => {
    for (const skill of SKILLS) {
      const refused = checkGate(skill, { ...ticket, status: 'Dropped' })
      expect(refused.ok).toBe(false)
      if (refused.ok) continue
      expect(refused.message).toContain('NOM-4 Explore pagination is "Dropped"')
      expect(refused.message).toContain(`${skill} needs "${GATES[skill].accepts[0]}"`)
      expect(refused.message).toContain(whoMoves(GATES[skill].accepts[0]!))
      expect(refused.message).toContain('No model call was made.')
    }
    const planner = checkGate('planner', { ...ticket, status: 'In Review: Spec' })
    expect(planner).toEqual({ ok: false, message: 'NOM-4 Explore pagination is "In Review: Spec"; planner needs "Ready: Spec" or "In Review: Plan". "Ready: Spec" is set by a human, after approving the spec. No model call was made.' })
  })

  it('proceeds on the right Status with the start move, and a retry in its own In Progress status makes none', () => {
    expect(checkGate('planner', { ...ticket, status: 'Ready: Spec' })).toEqual({ ok: true, retry: false, startMove: { from: 'Ready: Spec', to: 'In Progress: Plan' } })
    expect(checkGate('planner', { ...ticket, status: 'In Progress: Plan' })).toEqual({ ok: true, retry: true, startMove: null })
    // KIT-87: the planner reruns from In Review: Plan on the answered decisions, with no move.
    expect(checkGate('planner', { ...ticket, status: 'In Review: Plan' })).toEqual({ ok: true, retry: false, startMove: null })
    expect(checkGate('spec-writer', { ...ticket, status: 'Ready: Idea' })).toEqual({ ok: true, retry: false, startMove: { from: 'Ready: Idea', to: 'In Progress: Spec' } })
    expect(checkGate('implementor', { ...ticket, status: 'In Progress: Implementation' })).toEqual({ ok: true, retry: true, startMove: null })
    // The one spec step reruns from In Review: Spec with no move (KIT-48).
    expect(checkGate('spec-writer', { ...ticket, status: 'In Review: Spec' })).toEqual({ ok: true, retry: false, startMove: null })
    expect(checkGate('code-analyzer', { ...ticket, status: 'In Review: Implementation' })).toEqual({ ok: true, retry: false, startMove: null })
  })

  it('the pr-reviewer also needs the PR property', () => {
    expect(checkGate('pr-reviewer', { ...ticket, status: 'In Review: Implementation' })).toMatchObject({ ok: false, message: expect.stringContaining('PR property is not set') })
    expect(checkGate('pr-reviewer', { ...ticket, status: 'In Review: Implementation', pr: 'https://github.com/aspiralabs/nomnomzz/pull/2' })).toEqual({ ok: true, retry: false, startMove: null })
  })

  it('never moves to a Ready column, to Released, or backwards', () => {
    for (const skill of SKILLS) {
      const gate = GATES[skill]
      for (const target of [gate.inProgress, gate.success]) {
        if (target === undefined) continue
        expect(target.startsWith('Ready')).toBe(false)
        expect(target).not.toBe('Released')
      }
    }
  })

  it('makes the success move only from its own In Progress status, and the implementor only once the PR is open', () => {
    expect(endMove('planner', 'ready', 'In Progress: Plan')).toEqual({ from: 'In Progress: Plan', to: 'In Review: Plan' })
    expect(endMove('planner', 'incomplete', 'In Progress: Plan')).toBeNull()
    expect(endMove('planner', 'ready', 'Ready: Spec')).toBeNull()
    expect(endMove('spec-writer', 'ready', 'In Review: Spec')).toBeNull()
    expect(endMove('implementor', 'ready', 'In Progress: Implementation')).toBeNull()
    expect(endMove('implementor', 'ready', 'In Progress: Implementation', true)).toEqual({ from: 'In Progress: Implementation', to: 'In Review: Implementation' })
    expect(endMove('pr-reviewer', 'ready', 'In Review: Implementation')).toBeNull()
  })

  it('pushes the fixed titles, and the decisions page only for needs-author', () => {
    expect(pushesFor('spec-writer', 'ready').map((push) => push.title)).toEqual(['Spec', 'Spec Reviewed'])
    expect(pushesFor('spec-writer', 'needs-author').map((push) => [push.title, push.file])).toEqual([['Spec', 'spec.md'], ['Spec Reviewed', 'spec.reviewed/spec.reviewed.md'], ['Spec Review Decisions', 'spec.reviewed/trace/decisions.md']])
    expect(pushesFor('planner', 'ready').map((push) => [push.title, push.file])).toEqual([['Plan', 'plan.review/plan.reviewed.md']])
    expect(pushesFor('implementor', 'ready').map((push) => [push.title, push.file])).toEqual([['Implementation', 'plan.review/implementation.md']])
    expect(pushesFor('pr-reviewer', 'ready').map((push) => [push.title, push.file])).toEqual([['PR Review', 'pr-review/review.md']])
    expect(pushesFor('code-analyzer', 'ready')).toEqual([])
    for (const skill of SKILLS) for (const push of GATES[skill].pushes) expect(push.file).not.toMatch(/^trace\//)
  })
})

describe('the working folder', () => {
  it('is the lower-case ID and the title as a slug', () => {
    expect(workFolderName(ticket)).toBe('nom-4-explore-pagination')
    expect(slug('  Agent: file format (v2)! ')).toBe('agent-file-format-v2')
    expect(slug('')).toBe('ticket')
  })
})

describe('ticket.md', () => {
  it('round-trips the ticket, its pages and the Idea', () => {
    const text = renderTicketMd(ticket)
    expect(text).toContain('# NOM-4: Explore pagination')
    expect(text).toContain('| Status | Ready: Spec |')
    expect(text).toContain('| Area | Discover, Search |')
    expect(text).toContain('| Spec Reviewed | https://www.notion.so/3ec3e59b22588123961cce4ccd8e662a | 2026-10-05T04:48:12.063Z |')
    expect(text).toContain('## Idea\n\nEvery list stops at 10 | twenty.')
    expect(parseTicketMd(text)).toEqual(ticket)
  })

  it('reads a Status someone edited by hand, and returns null for another file', () => {
    const edited = renderTicketMd(ticket).replace('| Status | Ready: Spec |', '| Status | In Progress: Plan |')
    expect(parseTicketMd(edited)?.status).toBe('In Progress: Plan')
    expect(parseTicketMd('# Not a ticket\n')).toBeNull()
    expect(parseTicketMd('')).toBeNull()
  })

  it('has a placeholder form the session writes from', () => {
    const format = ticketMdFormat()
    expect(format).toContain('| Status | <Status, exactly as the board shows it> |')
    expect(parseTicketMd(format)?.pages['<child page title>']?.lastEditedAt).toBe('<its last edited time, ISO>')
  })
})

describe('pullDecision', () => {
  const page = '2026-10-05T04:48:12.063Z'
  it('writes a missing file', () => {
    expect(pullDecision({ exists: false, pageEditedAt: page })).toBe('write')
  })
  it('keeps a file whose page has not changed since the recorded pull', () => {
    expect(pullDecision({ exists: true, recordedAt: page, localModifiedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page })).toBe('keep')
    expect(pullDecision({ exists: true, recordedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page })).toBe('keep')
  })
  it('KIT-72: writes a local file newer than its changed page when it holds only the last pull', () => {
    expect(pullDecision({ exists: true, recordedAt: '2026-10-01T00:00:00.000Z', localModifiedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page, unchanged: true })).toBe('write')
  })
  it('refuses a local file newer than its changed page unless forced', () => {
    expect(pullDecision({ exists: true, recordedAt: '2026-10-01T00:00:00.000Z', localModifiedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page })).toBe('conflict')
    expect(pullDecision({ exists: true, localModifiedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page })).toBe('conflict')
    expect(pullDecision({ exists: true, localModifiedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page, force: true })).toBe('write')
  })
  it('writes an older local file whose page changed', () => {
    expect(pullDecision({ exists: true, recordedAt: '2026-10-01T00:00:00.000Z', localModifiedAt: '2026-10-02T00:00:00.000Z', pageEditedAt: page })).toBe('write')
  })
})

describe('ticketArgument', () => {
  const one = [{ folder: '/repo/.work/nom-4-explore-pagination', id: 'NOM-4', url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1' }]
  const two = [...one, { folder: '/repo/.work/nom-5-find-cooks', id: 'NOM-5', url: 'https://www.notion.so/3ec3e59b22588102becfce78d66142e2' }]

  it('takes an ID in any case or a page URL, and finds the folder it already has', () => {
    expect(ticketArgument({ positional: 'nom-4', workFolders: [], skill: 'planner' })).toEqual({ kind: 'ticket', ref: 'nom-4' })
    expect(ticketArgument({ positional: 'NOM-4', workFolders: two, skill: 'planner' })).toEqual({ kind: 'ticket', ref: 'NOM-4', folder: '/repo/.work/nom-4-explore-pagination' })
    expect(ticketArgument({ positional: 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', workFolders: two, skill: 'planner' })).toEqual({ kind: 'ticket', ref: 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', folder: '/repo/.work/nom-4-explore-pagination' })
  })

  it('takes the one working folder when nothing is given, and names two', () => {
    expect(ticketArgument({ workFolders: one, skill: 'planner' })).toEqual({ kind: 'folder', ref: 'NOM-4', folder: '/repo/.work/nom-4-explore-pagination' })
    expect(() => ticketArgument({ workFolders: two, skill: 'planner' })).toThrow('2 folders under .work/ hold a ticket.md: /repo/.work/nom-4-explore-pagination, /repo/.work/nom-5-find-cooks')
    expect(() => ticketArgument({ workFolders: [], skill: 'planner' })).toThrow('No ticket given and no folder under .work/ holds a ticket.md')
  })

  it('refuses a path without --no-ticket, naming the flag, and records one with it', () => {
    expect(() => ticketArgument({ positional: 'docs/spec.md', workFolders: one, skill: 'planner' })).toThrow('"docs/spec.md" is a file path, not a ticket. A ticket is a board ID such as NOM-4 or a Notion page URL. To run planner on a path with no board, pass --no-ticket.')
    expect(ticketArgument({ positional: 'docs/spec.md', noTicket: true, workFolders: one, skill: 'planner' })).toEqual({ kind: 'path', path: 'docs/spec.md' })
    expect(() => ticketArgument({ noTicket: true, workFolders: one, skill: 'planner' })).toThrow('give the path')
  })
})

describe('reportHeader', () => {
  it('starts with the ticket, the moves, the pages pushed and the working folder', () => {
    const trace: BoardTrace = {
      skill: 'planner',
      ticket: { id: 'NOM-4', title: 'Explore pagination', url: ticket.url },
      folder: '/repo/.work/nom-4-explore-pagination',
      statusBefore: 'Ready: Spec',
      statusAfter: 'In Review: Plan',
      pushed: [{ title: 'Plan', url: 'https://www.notion.so/plan' }],
      actions: [
        { at: 't', action: 'move', detail: 'Ready: Spec -> In Progress: Plan', statusBefore: 'Ready: Spec', statusAfter: 'In Progress: Plan', ok: true },
        { at: 't', action: 'move', detail: 'In Progress: Plan -> In Review: Plan', statusBefore: 'In Progress: Plan', statusAfter: 'In Review: Plan', ok: true },
      ],
    }
    expect(reportHeader(trace)).toEqual([
      `Ticket: NOM-4 Explore pagination (${ticket.url})`,
      'Status: Ready: Spec -> In Review: Plan',
      'Pages pushed: Plan (https://www.notion.so/plan)',
      'Working folder: /repo/.work/nom-4-explore-pagination',
    ])
    expect(reportHeader({ ...trace, ticket: null })).toEqual(['Ticket: none (--no-ticket)'])
  })
})

// The groomer row (KIT-8). Every expected message is a literal from the spec, so the six existing
// rows are pinned byte for byte and the groomer's wording is pinned where the spec gives it.

const STATUSES = [
  'Idea',
  'Grooming',
  'Shortlist',
  'Ready: Idea',
  'In Progress: Spec',
  'In Review: Spec',
  'Ready: Spec',
  'In Progress: Plan',
  'In Review: Plan',
  'Ready: Plan',
  'In Progress: Implementation',
  'In Review: Implementation',
  'Ready: Implementation',
  'Released',
  'Dropped',
]
const GROOMER_ACCEPTS = ['Idea', 'Grooming', 'Shortlist']
const SIBLINGS = ['spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const

describe('the gate table, groomer row', () => {
  it('the five existing rows refuse Dropped with the messages they give today', () => {
    const dropped = SIBLINGS.map((skill) => checkGate(skill, { ...ticket, status: 'Dropped' }))
    expect(dropped).toEqual([
      { ok: false, message: 'NOM-4 Explore pagination is "Dropped"; spec-writer needs "Ready: Idea" or "In Review: Spec". "Ready: Idea" is set by a human, after grooming the idea. No model call was made.' },
      { ok: false, message: 'NOM-4 Explore pagination is "Dropped"; planner needs "Ready: Spec" or "In Review: Plan". "Ready: Spec" is set by a human, after approving the spec. No model call was made.' },
      { ok: false, message: 'NOM-4 Explore pagination is "Dropped"; implementor needs "Ready: Plan". "Ready: Plan" is set by a human, after approving the plan. No model call was made.' },
      {
        ok: false,
        message: 'NOM-4 Explore pagination is "Dropped"; code-analyzer needs "In Progress: Implementation" or "In Review: Implementation". "In Progress: Implementation" is set by the implementor, when it claims the ticket. No model call was made.',
      },
      { ok: false, message: 'NOM-4 Explore pagination is "Dropped"; pr-reviewer needs "In Review: Implementation". "In Review: Implementation" is set by the implementor, when the PR is open and set on the ticket. No model call was made.' },
    ])
  })

  it('the groomer accepts a Feature card in Idea, Grooming and Shortlist', () => {
    const accepted = STATUSES.filter((status) => checkGate('groomer', { ...ticket, status }).ok)
    expect(accepted).toEqual(GROOMER_ACCEPTS)
  })

  it('the groomer refuses the other twelve Statuses naming the Status, the three it accepts and the move that reopens grooming', () => {
    const refused = STATUSES.filter((status) => !GROOMER_ACCEPTS.includes(status))
    expect(refused).toHaveLength(12)
    for (const status of refused) {
      const result = checkGate('groomer', { ...ticket, status })
      if (result.ok) throw new Error(`groomer accepted "${status}"`)
      expect(result.message).toContain(`NOM-4 Explore pagination is "${status}"`)
      expect(result.message).toContain('groomer needs "Idea" or "Grooming" or "Shortlist"')
      expect(result.message).toMatch(/grooming is finished; a human moves the card back to Grooming to reopen it \(for Dropped, a human decides whether to revive it\)\.?$/)
    }
  })

  it('a Feature card in Idea is moved to Grooming on start', () => {
    expect(checkGate('groomer', { ...ticket, status: 'Idea' })).toEqual({ ok: true, retry: false, startMove: { from: 'Idea', to: 'Grooming' } })
  })

  it('a Feature card already in Grooming or Shortlist gets no start move', () => {
    expect(checkGate('groomer', { ...ticket, status: 'Grooming' })).toMatchObject({ ok: true, startMove: null })
    expect(checkGate('groomer', { ...ticket, status: 'Shortlist' })).toMatchObject({ ok: true, startMove: null })
  })

  it('the groomer row starts in Grooming and ends in Shortlist, never a Ready column or Released', () => {
    const { inProgress, success } = GATES.groomer
    expect([inProgress, success]).toEqual(['Grooming', 'Shortlist'])
  })
})

describe('the gate table, Type gate', () => {
  const NO_TYPE = 'NOM-4 Explore pagination has no Type; set it to Feature or Bug to groom it. No model call was made.'

  it('refuses a card with an empty Type, a blank one or the unfilled ticket.md placeholder', () => {
    for (const type of ['', '  ', '<Type>']) expect(checkGate('groomer', { ...ticket, status: 'Idea', type })).toEqual({ ok: false, message: NO_TYPE })
  })

  it('grooms a Bug card as it grooms a Feature, in Idea, Grooming and Shortlist (KIT-22: the same path until the Diagnoser exists)', () => {
    for (const status of GROOMER_ACCEPTS) expect(checkGate('groomer', { ...ticket, status, type: 'Bug' })).toEqual(checkGate('groomer', { ...ticket, status, type: 'Feature' }))
  })

  it('refuses a card of any other Type, naming it', () => {
    expect(checkGate('groomer', { ...ticket, status: 'Idea', type: 'Chore' })).toEqual({ ok: false, message: 'NOM-4 Explore pagination is a Chore card; groomer grooms Feature and Bug cards only. No model call was made.' })
  })
})

describe('the groomer end move', () => {
  it('moves Grooming to Shortlist only when the run ended ready', () => {
    expect(endMove('groomer', 'ready', 'Grooming')).toEqual({ from: 'Grooming', to: 'Shortlist' })
  })

  it('makes no move for needs-author or incomplete', () => {
    expect([endMove('groomer', 'needs-author', 'Grooming'), endMove('groomer', 'incomplete', 'Grooming')]).toEqual([null, null])
  })

  it('leaves the implementor move as it is today', () => {
    expect(endMove('implementor', 'ready', 'In Progress: Implementation', true)).toEqual({ from: 'In Progress: Implementation', to: 'In Review: Implementation' })
  })
})

describe('ticketArgument for the groomer', () => {
  const one = [{ folder: '/repo/.work/nom-4-explore-pagination', id: 'NOM-4', url: 'https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1' }]
  const refusal = (args: Parameters<typeof ticketArgument>[0]): string | null => {
    try {
      ticketArgument(args)
      return null
    } catch (error) {
      if (!(error instanceof TicketArgumentError)) throw error
      return error.message
    }
  }

  it('refuses --no-ticket: the groomer writes to the card', () => {
    expect(refusal({ positional: 'idea.md', noTicket: true, workFolders: one, skill: 'groomer' })).toBe('the groomer writes to the card; it needs a Feature Board ticket')
  })

  it('never offers --no-ticket when no ticket is given', () => {
    const message = refusal({ workFolders: [], skill: 'groomer' })
    expect(message).toEqual(expect.any(String))
    expect(message).not.toContain('--no-ticket')
  })

  it('never offers --no-ticket for an argument that is not a ticket', () => {
    const message = refusal({ positional: 'docs/idea.md', workFolders: one, skill: 'groomer' })
    expect(message).toEqual(expect.any(String))
    expect(message).not.toContain('--no-ticket')
  })

  it('leaves the spec-writer messages as they are today', () => {
    expect([
      refusal({ positional: 'idea.md', workFolders: one, skill: 'spec-writer' }),
      refusal({ workFolders: [], skill: 'spec-writer' }),
      refusal({ noTicket: true, workFolders: one, skill: 'spec-writer' }),
    ]).toEqual([
      '"idea.md" is a file path, not a ticket. A ticket is a board ID such as NOM-4 or a Notion page URL. To run spec-writer on a path with no board, pass --no-ticket.',
      'No ticket given and no folder under .work/ holds a ticket.md. Name the ticket (an ID such as NOM-4, or its Notion URL), or pass --no-ticket with a file path.',
      '--no-ticket runs spec-writer on a file path; give the path',
    ])
    expect(ticketArgument({ positional: 'idea.md', noTicket: true, workFolders: one, skill: 'spec-writer' })).toEqual({ kind: 'path', path: 'idea.md' })
  })
})

describe('ticket.md with two child pages of one title', () => {
  const U1 = 'https://www.notion.so/3ec3e59b22588100000000000000000b'
  const U2 = 'https://www.notion.so/3ec3e59b22588100000000000000000c'
  const first = { id: '3ec3e59b-2258-8100-0000-00000000000b', title: 'Grooming Decisions', url: U1, lastEditedAt: '2026-10-11T10:00:00.000Z' }
  const second = { id: '3ec3e59b-2258-8100-0000-00000000000c', title: 'Grooming Decisions', url: U2, lastEditedAt: '2026-10-11T10:05:00.000Z' }
  const duplicated: TicketRecord = {
    ...ticket,
    status: 'Grooming',
    pages: { ...ticket.pages, 'Grooming Decisions': first },
    duplicatePages: [{ title: 'Grooming Decisions', pages: [first, second] }],
  }

  it('round-trips both rows, the first one winning in pages', () => {
    expect(parseTicketMd(renderTicketMd(duplicated))).toEqual(duplicated)
  })

  it('reads a ticket.md written before this change with no duplicatePages key', () => {
    const today = [
      '# NOM-4: Explore pagination',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| ID | NOM-4 |',
      '| URL | https://www.notion.so/Explore-pagination-3ec3e59b22588102becfce78d66142e1 |',
      '| Status | Grooming |',
      '| Type | Feature |',
      '| Priority | P0 - Critical |',
      '| Area | Discover, Search |',
      '| Dev | Claude |',
      '| PR |  |',
      '| Version |  |',
      '| Pulled | 2026-10-06T05:00:00.000Z |',
      '',
      '## Pages',
      '',
      '| Title | URL | Last edited |',
      '| --- | --- | --- |',
      '| Spec | https://www.notion.so/3ec3e59b22588100000000000000000a | 2026-10-01T02:10:00.000Z |',
      '',
      '## Idea',
      '',
      'Every list stops at 10.',
      '',
    ].join('\n')
    expect(parseTicketMd(today)).not.toHaveProperty('duplicatePages')
  })

  it('the groomer gate refuses a card with two Grooming Decisions pages, naming both, and picks neither', () => {
    expect(checkGate('groomer', duplicated)).toEqual({ ok: false, message: `NOM-4 has 2 child pages titled "Grooming Decisions" (${U1}, ${U2}); delete or rename all but one and rerun` })
  })
})

describe('the ticket.md format the session writes from', () => {
  const format = ticketMdFormat()

  it('says to list every child page, one row each, even when two share a title', () => {
    expect(format).toContain('every child page, one row each, even when two share a title')
  })

  it('says the Type cell is the card\'s Type select value or blank', () => {
    expect(format).toContain('Type cell is the card\'s Type select value or is left blank')
  })

  it('states the Idea boundary: to the next heading of level 2 or shallower, keeping ### subsections, or the whole body', () => {
    expect(format).toContain('from the `## Idea` heading to the next heading of level 2 or shallower, keeping `###` subsections')
    expect(format).toContain('the whole body with its heading levels unchanged when there is no Idea heading')
  })

  it('says to stop and say so when the page fetch is truncated', () => {
    expect(format).toContain('stop and say so when the page fetch is truncated')
  })
})

describe('run status words', () => {
  // The words each sibling launcher can pass as --run-status: its literal `status=` assignments,
  // the words of its `case $status in` line, and the fallback it echoes.
  const launcherWords = (): string[] => {
    const words = new Set<string>()
    for (const skill of SIBLINGS) {
      const script = readFileSync(new URL(`../../../${skill}/skill/aspira-${skill}/scripts/${skill}.sh`, import.meta.url), 'utf8')
      for (const match of script.matchAll(/\bstatus=([a-z][a-z-]*)\b/g)) words.add(match[1]!)
      for (const match of script.matchAll(/case \$status in ([a-z|-]+)\)/g)) for (const word of match[1]!.split('|')) words.add(word)
      for (const match of script.matchAll(/\?\? '([a-z-]+)'|^\s*status=\$\(.*\|\| echo ([a-z-]+)\)/gm)) words.add((match[1] ?? match[2])!)
    }
    return [...words].sort()
  }

  it('every sibling launcher passes its trace\'s own status, falling back only to incomplete, and that reads as a run status (F5, F6)', () => {
    // Since KIT-2 a launcher no longer derives a word in shell: it hands ticket-cli finish the
    // trace's top-level status, and the only literal it can add is the incomplete fallback for a
    // missing or unreadable trace (F6).
    const words = launcherWords()
    expect(words).toEqual(['incomplete'])
    expect(words.filter((word) => readRunStatus(word) === null)).toEqual([])
    for (const skill of SIBLINGS) {
      const script = readFileSync(new URL(`../../../${skill}/skill/aspira-${skill}/scripts/${skill}.sh`, import.meta.url), 'utf8')
      expect(script, skill).toMatch(/\.status \?\? 'incomplete'/)
      expect(script, skill).toContain('--run-status "$status"')
    }
  })

  it('every word an older installed launcher passed, partial included, still reads as one of the five new run statuses (F7, A1)', () => {
    const before = ['clean', 'complete', 'incomplete', 'needs-author', 'partial', 'ready']
    expect(before.map((word) => readRunStatus(word)?.status)).toEqual(['ready', 'ready', 'incomplete', 'needs-author', 'incomplete', 'ready'])
  })

  it('the five new run statuses are ready, needs-author, incomplete, refused and blocked', () => {
    expect([...RUN_STATUSES]).toEqual(['ready', 'needs-author', 'incomplete', 'refused', 'blocked'])
  })
})

describe('the board tool', () => {
  const accepts = (skill: string): boolean => {
    const schema = boardTool.inputSchema
    if (!(schema instanceof z.ZodType)) throw new Error('the board tool input schema is not a Zod schema')
    return schema.safeParse({ action: 'resolve', skill, repo: '/repo' }).success
  }

  it('names the six sibling skills as the ones a model may run through it', () => {
    expect([...TOOL_SKILLS]).toEqual([...SIBLINGS])
  })

  it('refuses the groomer and accepts the five siblings', () => {
    expect(accepts('groomer')).toBe(false)
    expect(TOOL_SKILLS.map(accepts)).toEqual([true, true, true, true, true])
  })
})

describe('pullDecision with overwrite', () => {
  const page = '2026-10-05T04:48:12.063Z'
  const newer = { exists: true, recordedAt: '2026-10-01T00:00:00.000Z', localModifiedAt: '2026-10-06T00:00:00.000Z', pageEditedAt: page }

  it('writes over a local file newer than its page', () => {
    expect(pullDecision({ ...newer, overwrite: true })).toBe('write')
  })

  it('without the flag refuses it as today', () => {
    expect(pullDecision(newer)).toBe('conflict')
  })
})
