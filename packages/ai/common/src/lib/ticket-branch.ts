// The ticket branch every run builds on: `<prefix>/<id>-<slug>` (GIT-001), the prefix from the
// card's Type (Feature, Bug or Chore). Shared by build-feature (the worktree it prepares and the
// branch it pushes) and any other skill that needs to name the same branch the same way.

import { slug } from './ticket.ts'

/** The card's Type: the worktree folder's TYPE and the branch prefix. */
export const TICKET_TYPES = {
  Feature: { dir: 'FEATURE', prefix: 'feat' },
  Bug: { dir: 'BUG', prefix: 'fix' },
  Chore: { dir: 'CHORE', prefix: 'chore' },
} as const
export type TicketType = (typeof TICKET_TYPES)[keyof typeof TICKET_TYPES]

/** The Type's naming, or null when the card's Type is empty or not one of Feature, Bug and Chore. */
export function ticketTypeOf(type: string | null | undefined): TicketType | null {
  const wanted = (type ?? '').trim().toLowerCase()
  const key = (Object.keys(TICKET_TYPES) as (keyof typeof TICKET_TYPES)[]).find((name) => name.toLowerCase() === wanted)
  return key === undefined ? null : TICKET_TYPES[key]
}

/** `<prefix>/<id>-<slug>` (GIT-001). A card whose Type is unknown gets feat/, which the worktree gate never lets a run reach. */
export function ticketBranch(id: string, title: string, type: string | null | undefined): string {
  const prefix = ticketTypeOf(type)?.prefix ?? TICKET_TYPES.Feature.prefix
  return `${prefix}/${id.toLowerCase()}${slug(title) === '' ? '' : `-${slug(title)}`}`
}
