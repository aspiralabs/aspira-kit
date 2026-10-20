// The planner's implementation-plan shape, moved here from packages/agents/planner/agent/lib/plan.ts
// (unchanged) so the implementor's plan-block recovery (plan-block.ts, F36/F37) can read and render
// a plan without depending on the planner package. The planner re-exports these from here; its own
// research schema, path-safety checks and validatePlan stay in its own plan.ts.

import { z } from 'zod'
import { applyAnswers, decisionSchema, normalizeQuestion, renderDecision, takenDecision, type Answer, type Decision, type DecisionRecord } from './decisions.ts'
import { sortBySeverity, type Severity } from './severity.ts'

const text = z.string().trim().min(1)
const features = z.array(z.string().regex(/^F\d+$/)).min(1)

export const planSchema = z.object({
  summary: text,
  tasks: z.array(z.object({
    id: z.string().regex(/^P\d+$/), title: text, kind: z.enum(['tests', 'implementation', 'verification', 'handoff']),
    featureIds: features, dependsOn: z.array(text), testIds: z.array(text),
    changes: z.array(z.object({ operation: z.enum(['create', 'modify', 'delete']), path: text, symbols: z.array(text).min(1), instructions: text, evidence: z.array(text).min(1) })),
    commands: z.array(text), outcome: text,
  })).min(1),
  tests: z.array(z.object({ id: z.string().regex(/^T\d+$/), kind: z.enum(['unit', 'integration']), path: text, featureIds: features, setup: text, action: text, assertions: z.array(text).min(1) })).min(1),
  checks: z.array(z.object({ rule: text, evidence: text })),
  decisions: z.array(decisionSchema), gaps: z.array(text),
  /** What the implementer should re-verify (KIT-36): never a readiness problem, unlike a gap. */
  notes: z.array(text).optional(),
})
export type Plan = z.infer<typeof planSchema>

/**
 * Research's and planning's decisions as one list, D1, D2, ..., the same question once, with the
 * author's ticked answers applied. With `takeRecommended` (F10), every decision still open after the
 * author's ticks are applied is taken as the agent's recommended option instead of waiting on the
 * author; a tick the agent made itself is ignored by `applyAnswers`, so a rerun never records it as
 * the author's.
 */
export function mergeDecisions(lists: readonly (readonly Decision[])[], answers: readonly Answer[] = [], takeRecommended = false): DecisionRecord[] {
  const seen = new Set<string>()
  const merged: DecisionRecord[] = []
  for (const decision of lists.flat()) {
    const key = normalizeQuestion(decision.question)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...decision, id: `D${merged.length + 1}`, decidedBy: 'open', answer: null })
  }
  const applied = applyAnswers(merged, answers)
  return takeRecommended ? applied.map((decision) => (decision.decidedBy === 'open' ? takenDecision(decision.id, decision) : decision)) : applied
}

/**
 * How bad a readiness problem is, for the order a human reads them in. Critical: a phase did not
 * produce its output. High: the plan has a structural fault. Medium: evidence or a rule check is missing.
 */
export function problemSeverity(problem: string): Severity {
  if (/^(?:research|planning|repair-\d+): /.test(problem) || ['Research unavailable', 'No structured plan produced', 'Planning cancelled'].includes(problem)) return 'critical'
  if (/^(?:Uncovered guideline|Research gap|Plan gap): /.test(problem) || problem.startsWith('UI planning requires')) return 'medium'
  return 'high'
}

export function renderPlan(plan: Plan, status: string, source: { specPath: string; commit: string; dirty: boolean }, problems: string[], decisions: readonly DecisionRecord[] = mergeDecisions([plan.decisions])): string {
  const lines = ['# Implementation plan', '', `Status: **${status}**`, '', `Source spec: ${source.specPath}`, `Repository commit: ${source.commit}; uncommitted changes: ${source.dirty ? 'yes' : 'no'}. Recheck this context before implementation.`, '', '## Intent', '', plan.summary, '', '## Ordered tasks', '']
  for (const task of plan.tasks) {
    lines.push(`- [ ] **${task.id}: ${task.title}** (${task.kind}) — ${task.featureIds.map((id) => `[${id}]`).join(' ')}`, `  - Prerequisites: ${task.dependsOn.join(', ') || 'none'}`, `  - Test cases: ${task.testIds.join(', ') || 'none'}`)
    for (const change of task.changes) lines.push(`  - ${change.operation} \`${change.path}\`; symbols: ${change.symbols.map((symbol) => `\`${symbol}\``).join(', ')}. ${change.instructions}`, `    - Evidence: ${change.evidence.join('; ')}`)
    for (const command of task.commands) lines.push(`  - Run: \`${command}\``)
    lines.push(`  - Done when: ${task.outcome}`, '')
  }
  lines.push('## Test checklists', '')
  for (const kind of ['unit', 'integration']) {
    lines.push(`### ${kind === 'unit' ? 'Unit' : 'Integration'} tests`, '')
    for (const test of plan.tests.filter((item) => item.kind === kind)) lines.push(`- [ ] **${test.id}** — \`${test.path}\` ${test.featureIds.map((id) => `[${id}]`).join(' ')}`, `  - Setup: ${test.setup}`, `  - Action: ${test.action}`, ...test.assertions.map((assertion) => `  - Assert: ${assertion}`), '')
  }
  // Notes (KIT-36): what the implementer should re-verify; never a reason the plan is not ready.
  const notes = plan.notes ?? []
  if (notes.length) lines.push('## Notes', '', ...notes.map((note) => `- ${note}`), '')
  const open = decisions.filter((decision) => decision.decidedBy === 'open').length
  lines.push('## Author decisions', '', `${decisions.length} decision${decisions.length === 1 ? '' : 's'}: ${open} open · ${decisions.length - open} answered. Each has a recommended option; answer them in trace/decisions.md.`, '', ...(decisions.length ? decisions.map((decision) => `${renderDecision(decision).replace(/^## /, '### ')}\n`) : ['None.', '']), '## Readiness checks', '', ...(problems.length ? sortBySeverity(problems, problemSeverity).map((item) => `- **${problemSeverity(item)}** · ${item}`) : ['All structural checks passed; tasks and commands are instructions for the build agent and have not been executed.']), '', 'See trace/ for the source spec, guidelines, evidence, model activity and validation details.', '')
  return lines.join('\n')
}
