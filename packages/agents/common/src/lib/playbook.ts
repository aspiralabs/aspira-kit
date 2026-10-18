// The Playbook's Status table: which step comes next for a ticket, from its Feature Board Status.
// The rows live in playbook.json, the one source of the table, so both this package (the progress
// note's Next action) and @aspiralabs/kit (`kit next`, `kit playbook`, which reads the JSON from
// this package and never its TypeScript, PATTERN-012) read the same data, and agent-common never
// depends on the kit CLI that installs it (NOVA1.1).
import { z } from 'zod'
import table from './playbook.json' with { type: 'json' }

/** One row of the Status table. `command` has `<ID>` where the ticket ID goes; null when the step
 * is done by hand or has no single command (its `manual` text, when given, replaces "by hand" in
 * the Command cell). */
export type PlaybookRow = { statuses: string[]; step: string; command: string | null; who: string; manual?: string }

const rowSchema = z.object({ statuses: z.array(z.string().min(1)).min(1), step: z.string().min(1), command: z.string().min(1).nullable(), who: z.string().min(1), manual: z.string().min(1).optional() })

/** The rows, validated once at load (PATTERN-012): a malformed playbook.json fails loudly here. */
export const PLAYBOOK: PlaybookRow[] = z.object({ rows: z.array(rowSchema).min(1) }).parse(table).rows

/** The row for a Status, or null when the board has a Status this table does not know. */
export function nextStep(status: string): PlaybookRow | null {
  const wanted = status.trim().toLowerCase()
  return PLAYBOOK.find((row) => row.statuses.some((candidate) => candidate.toLowerCase() === wanted)) ?? null
}

/** The row's command with the ticket ID filled in. */
export function commandFor(row: PlaybookRow, id: string): string | null {
  return row.command === null ? null : row.command.replaceAll('<ID>', id)
}
