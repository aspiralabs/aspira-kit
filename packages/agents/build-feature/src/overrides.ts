// Overrides (F19): a human may tick a different option for a decision an agent took, on the step's
// own decisions page in Notion, after the run moved on. On each run start the driver has the
// session pull the owning steps' decisions pages into the working folder, parses the ticks with
// the shared parser and reports every taken decision the tick turned into the author's. When the
// override belongs to the stage the card is in now, that stage has to run again: the backward move
// (BOARD-007) is the human's unless it is listed below, and From Idea to Release says a skill never
// moves a card backwards, so the list is empty and the run stops naming the move.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyAnswers, parseTickedDecisions, type DecisionRecord } from '@aspiralabs/agent-common/lib/decisions'
import type { OverrideRecord, RunState } from '#src/run-state.ts'

/** Backward moves a skill may make itself. Empty: Board rules allow none today. */
export const BACKWARD_MOVES_SKILL_MAY_MAKE: readonly { from: string; to: string }[] = []

/** Per step: the ticket child page its decisions live on, the Status the card waits in after it, and the Status it reruns from. */
export const DECISION_OWNERS: Readonly<Record<string, { page: string; review: string; rerun: string }>> = {
  groomer: { page: 'Grooming Decisions', review: 'Shortlist', rerun: 'Grooming' },
  'spec-writer': { page: 'Spec Review Decisions', review: 'In Review: Spec', rerun: 'In Progress: Spec' },
  planner: { page: 'Plan', review: 'In Review: Plan', rerun: 'In Progress: Plan' },
  implementor: { page: 'Implementation', review: 'In Review: Implementation', rerun: 'In Progress: Implementation' },
}

/** The steps with taken decisions on record, each with the file the session pulls its page into. */
export function overridesPages(state: RunState, dir: string): Record<string, string> {
  const steps = [...new Set(state.takenKeys.map((entry) => entry.step))].filter((step) => DECISION_OWNERS[step] !== undefined)
  return Object.fromEntries(steps.map((step) => [step, join(dir, `${step}.md`)]))
}

/** The stage body for pulling the pages, or null when no taken decision is on record. */
export function overridesStage(state: RunState, dir: string): Record<string, unknown> | null {
  const pages = overridesPages(state, dir)
  if (Object.keys(pages).length === 0) return null
  return {
    pages,
    notion: Object.keys(pages).map((step) => ({ op: 'read', target: 'child-page', page: DECISION_OWNERS[step]!.page })),
    instructions: `For each step in "pages", fetch the ticket's child page named as listed (read-only) and write its decisions, as markdown with the checkboxes as they are ticked now, to the path given. Then write {"nonce"} to the output file.`,
  }
}

export type Override = OverrideRecord & { page: string }

/** Every taken decision a pulled page now ticks differently: it became the author's. */
export async function findOverrides(state: RunState, pages: Record<string, string>, runId: string): Promise<Override[]> {
  const found: Override[] = []
  for (const [step, file] of Object.entries(pages)) {
    const markdown = await readFile(file, 'utf8').catch(() => null)
    if (markdown === null) continue
    const answers = parseTickedDecisions(markdown)
    const taken = state.takenKeys.filter((entry) => entry.step === step)
    const decisions: DecisionRecord[] = taken.map((entry) => ({ ...entry.decision }))
    applyAnswers(decisions, answers).forEach((after, index) => {
      const before = taken[index]!
      if (before.decision.decidedBy === 'agent' && after.decidedBy === 'author' && after.answer !== null) {
        found.push({ key: before.key, step, runId: before.runId, from: before.decision.answer, to: after.answer, foundIn: runId, page: DECISION_OWNERS[step]!.page })
      }
    })
  }
  return found
}

export type OverrideDecision = { kind: 'continue' } | { kind: 'move'; from: string; to: string } | { kind: 'stop'; message: string }

/** What an override means for the card where it is now. */
export function decideOverrides(overrides: readonly Override[], status: string, context: { id: string; resume: string }): OverrideDecision {
  for (const override of overrides) {
    const owner = DECISION_OWNERS[override.step]!
    if (status !== owner.review) continue
    const move = { from: owner.review, to: owner.rerun }
    const allowed = BACKWARD_MOVES_SKILL_MAY_MAKE.some((candidate) => candidate.from === move.from && candidate.to === move.to)
    if (allowed) return { kind: 'move', ...move }
    return {
      kind: 'stop',
      message: `${override.key} was overridden on the ${override.page} page (${override.from ?? 'no answer'} -> ${override.to}), so the ${override.step} has to run again. Move ${context.id} ${move.from} -> ${move.to} yourself (BOARD-007: a skill never moves a card backwards), then run ${context.resume}.`,
    }
  }
  return { kind: 'continue' }
}

/** The state with the overrides recorded once per key and run. */
export function recordOverrides(state: RunState, overrides: readonly Override[]): RunState {
  const known = new Set(state.overrides.map((entry) => `${entry.key}@${entry.foundIn}`))
  const fresh = overrides.filter((entry) => !known.has(`${entry.key}@${entry.foundIn}`)).map(({ page: _page, ...record }) => record)
  return fresh.length === 0 ? state : { ...state, overrides: [...state.overrides, ...fresh] }
}
