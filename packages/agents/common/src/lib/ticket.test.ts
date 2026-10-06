import { describe, expect, it } from 'vitest'
import { GATES, SKILLS, checkGate, endMove, parseTicketMd, pullDecision, pushesFor, renderTicketMd, reportHeader, slug, ticketArgument, ticketMdFormat, whoMoves, workFolderName, type BoardTrace, type TicketRecord } from './ticket'

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
    expect(GATES['spec-writer']).toMatchObject({ accepts: ['Ready: Idea'], inProgress: 'In Progress: Spec', success: 'In Review: Spec' })
    expect(GATES['spec-reviewer']).toMatchObject({ accepts: ['In Review: Spec'] })
    expect(GATES.planner).toMatchObject({ accepts: ['Ready: Spec'], inProgress: 'In Progress: Plan', success: 'In Review: Plan' })
    expect(GATES.implementor).toMatchObject({ accepts: ['Ready: Plan'], inProgress: 'In Progress: Implementation', success: 'In Review: Implementation' })
    expect(GATES['code-analyzer']).toMatchObject({ accepts: ['In Progress: Implementation', 'In Review: Implementation'], pushes: [] })
    expect(GATES['pr-reviewer']).toMatchObject({ accepts: ['In Review: Implementation'], requires: 'PR' })
  })

  it('every row refuses on the wrong Status with the ticket, its Status, the Status needed and who moves it', () => {
    for (const skill of SKILLS) {
      const refused = checkGate(skill, { ...ticket, status: 'Grooming' })
      expect(refused.ok).toBe(false)
      if (refused.ok) continue
      expect(refused.message).toContain('NOM-4 Explore pagination is "Grooming"')
      expect(refused.message).toContain(`${skill} needs "${GATES[skill].accepts[0]}"`)
      expect(refused.message).toContain(whoMoves(GATES[skill].accepts[0]!))
      expect(refused.message).toContain('No model call was made.')
    }
    const planner = checkGate('planner', { ...ticket, status: 'In Review: Spec' })
    expect(planner).toEqual({ ok: false, message: 'NOM-4 Explore pagination is "In Review: Spec"; planner needs "Ready: Spec". "Ready: Spec" is set by a human, after approving the spec. No model call was made.' })
  })

  it('proceeds on the right Status with the start move, and a retry in its own In Progress status makes none', () => {
    expect(checkGate('planner', { ...ticket, status: 'Ready: Spec' })).toEqual({ ok: true, retry: false, startMove: { from: 'Ready: Spec', to: 'In Progress: Plan' } })
    expect(checkGate('planner', { ...ticket, status: 'In Progress: Plan' })).toEqual({ ok: true, retry: true, startMove: null })
    expect(checkGate('spec-writer', { ...ticket, status: 'Ready: Idea' })).toEqual({ ok: true, retry: false, startMove: { from: 'Ready: Idea', to: 'In Progress: Spec' } })
    expect(checkGate('implementor', { ...ticket, status: 'In Progress: Implementation' })).toEqual({ ok: true, retry: true, startMove: null })
    expect(checkGate('spec-reviewer', { ...ticket, status: 'In Review: Spec' })).toEqual({ ok: true, retry: false, startMove: null })
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
    expect(endMove('planner', true, 'In Progress: Plan')).toEqual({ from: 'In Progress: Plan', to: 'In Review: Plan' })
    expect(endMove('planner', false, 'In Progress: Plan')).toBeNull()
    expect(endMove('planner', true, 'Ready: Spec')).toBeNull()
    expect(endMove('spec-reviewer', true, 'In Review: Spec')).toBeNull()
    expect(endMove('implementor', true, 'In Progress: Implementation')).toBeNull()
    expect(endMove('implementor', true, 'In Progress: Implementation', true)).toEqual({ from: 'In Progress: Implementation', to: 'In Review: Implementation' })
    expect(endMove('pr-reviewer', true, 'In Review: Implementation')).toBeNull()
  })

  it('pushes the fixed titles, and the decisions page only for needs-author', () => {
    expect(pushesFor('spec-writer', 'ready').map((push) => push.title)).toEqual(['Spec'])
    expect(pushesFor('spec-reviewer', 'ready').map((push) => push.title)).toEqual(['Spec Reviewed'])
    expect(pushesFor('spec-reviewer', 'needs-author').map((push) => [push.title, push.file])).toEqual([['Spec Reviewed', 'spec.reviewed/spec.reviewed.md'], ['Spec Review Decisions', 'spec.reviewed/trace/decisions.md']])
    expect(pushesFor('planner', 'ready').map((push) => [push.title, push.file])).toEqual([['Plan', 'plan.review/plan.reviewed.md']])
    expect(pushesFor('implementor', 'complete').map((push) => [push.title, push.file])).toEqual([['Implementation', 'plan.review/implementation.md']])
    expect(pushesFor('pr-reviewer', 'complete').map((push) => [push.title, push.file])).toEqual([['PR Review', 'pr-review/review.md']])
    expect(pushesFor('code-analyzer', 'clean')).toEqual([])
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
