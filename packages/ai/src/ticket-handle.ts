// A ticket worktree's handle and branch prefix, from the board's Type (BOARD-011 / GIT-001):
// Feature -> FEATURE / feat, Bug -> BUG / fix, Chore -> CHORE / chore. A ticket worktree lives at
// `<main checkout>/.worktrees/<HANDLE>-<ID>` on a branch `<prefix>/<folder>`. Cleanup and worktree
// both read this one table.
import { isNotionUrl } from './aspira.js'

export const TICKET_TYPES = [
  { type: 'Feature', handle: 'FEATURE', prefix: 'feat' },
  { type: 'Bug', handle: 'BUG', prefix: 'fix' },
  { type: 'Chore', handle: 'CHORE', prefix: 'chore' },
] as const

export type TicketTypeRow = (typeof TICKET_TYPES)[number]
export type TicketType = TicketTypeRow['type']
export type TicketHandle = TicketTypeRow['handle']

/** A ticket reference: an ID such as NOM-4, a bare number, or a Notion page URL. */
export function isTicketRef(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value) || /^\d+$/.test(value) || isNotionUrl(value)
}

/** The table row for a board Type, matched trimmed and case-insensitively; undefined for no Type or any other Type. */
export function ticketTypeOf(type: string | null | undefined): TicketTypeRow | undefined {
  if (typeof type !== 'string') return undefined
  const wanted = type.trim().toLowerCase()
  if (wanted === '') return undefined
  return TICKET_TYPES.find((row) => row.type.toLowerCase() === wanted)
}

/** A `.worktrees` folder name split into its handle and ticket ID: `FEATURE-KIT-13` -> FEATURE, KIT-13. Upper-case handles only; undefined for anything else. */
export function parseHandle(folderName: string): { handle: TicketHandle; type: TicketType; id: string } | undefined {
  const match = /^(FEATURE|BUG|CHORE)-(.+)$/.exec(folderName)
  if (match === null) return undefined
  const [, handle, id] = match
  if (handle === undefined || id === undefined || !isTicketRef(id)) return undefined
  const row = TICKET_TYPES.find((candidate) => candidate.handle === handle)
  return row === undefined ? undefined : { handle: row.handle, type: row.type, id }
}

/** The `.worktrees` folder name for a ticket of this Type: `FEATURE-KIT-13`; undefined when the Type has no handle. */
export function handleFor(type: string | null | undefined, id: string): string | undefined {
  const row = ticketTypeOf(type)
  return row === undefined ? undefined : `${row.handle}-${id}`
}

/** The branch prefix for a ticket of this Type: feat, fix or chore; undefined when the Type has none. */
export function branchPrefixFor(type: string | null | undefined): string | undefined {
  return ticketTypeOf(type)?.prefix
}
