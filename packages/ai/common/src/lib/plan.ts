// The planner's implementation-plan shape, moved here from packages/ai/planner/agent/lib/plan.ts
// (unchanged) so the implementor's plan-block recovery (plan-block.ts, F36/F37) can read and render
// a plan without depending on the planner package. The planner re-exports these from here; its own
// research schema, path-safety checks and validatePlan stay in its own plan.ts.

import { z } from 'zod'
import { applyAnswers, decisionSchema, normalizeQuestion, renderDecision, takenDecision, type Answer, type Decision, type DecisionRecord } from './decisions.ts'
import { sortBySeverity, type Severity } from './severity.ts'

const text = z.string().trim().min(1)
const features = z.array(z.string().regex(/^F\d+$/)).min(1)

/**
 * One file action. `move` relocates `from` (a file, or a directory and everything under it) to `path`:
 * one change for a whole directory, and later tasks name files at their new paths.
 */
const changeSchema = z
  .object({ operation: z.enum(['create', 'modify', 'delete', 'move']), path: text, from: text.optional(), symbols: z.array(text).min(1), instructions: text, evidence: z.array(text).min(1) })
  .refine((change) => (change.operation === 'move') === (change.from !== undefined), { message: 'a move names the path it moves "from", and only a move has "from"' })
const taskSchema = z.object({
  id: z.string().regex(/^P\d+$/), title: text, kind: z.enum(['tests', 'implementation', 'verification', 'handoff']),
  featureIds: features, dependsOn: z.array(text), testIds: z.array(text),
  changes: z.array(changeSchema),
  commands: z.array(text), outcome: text,
})
const testSchema = z.object({ id: z.string().regex(/^T\d+$/), kind: z.enum(['unit', 'integration']), path: text, featureIds: features, setup: text, action: text, assertions: z.array(text).min(1) })

export const planSchema = z.object({
  summary: text,
  tasks: z.array(taskSchema).min(1),
  tests: z.array(testSchema).min(1),
  checks: z.array(z.object({ rule: text, evidence: text })),
  decisions: z.array(decisionSchema), gaps: z.array(text),
  /** What the implementer should re-verify (KIT-36): never a readiness problem, unlike a gap. */
  notes: z.array(text).optional(),
})
export type Plan = z.infer<typeof planSchema>

/**
 * A correction pass's answer: only what it changes. A task or test whose id is already in the plan
 * replaces it; a new id is added. `taskOrder`, when given, is the full task order after the pass.
 * `checks`, `gaps` and `notes`, when given, replace those lists. Everything left out stays as it was,
 * so a pass that fixes three tasks writes three tasks, not the whole plan.
 */
export const planPatchSchema = z.object({
  tasks: z.array(taskSchema).default([]),
  tests: z.array(testSchema).default([]),
  removeTaskIds: z.array(text).default([]),
  removeTestIds: z.array(text).default([]),
  taskOrder: z.array(z.string().regex(/^P\d+$/)).optional(),
  checks: planSchema.shape.checks.optional(),
  gaps: planSchema.shape.gaps.optional(),
  notes: planSchema.shape.notes,
})
export type PlanPatch = z.infer<typeof planPatchSchema>

/** The plan with a correction pass applied (planPatchSchema), validated as a whole plan again. */
export function applyPlanPatch(plan: Plan, patch: PlanPatch): Plan {
  const merge = <T extends { id: string }>(rows: readonly T[], changed: readonly T[], removed: readonly string[]): T[] => {
    const byId = new Map(changed.map((row) => [row.id, row]))
    const kept = rows.filter((row) => !removed.includes(row.id)).map((row) => byId.get(row.id) ?? row)
    return [...kept, ...changed.filter((row) => !rows.some((existing) => existing.id === row.id))]
  }
  let tasks = merge(plan.tasks, patch.tasks, patch.removeTaskIds)
  if (patch.taskOrder !== undefined) {
    const order = new Map(patch.taskOrder.map((id, index) => [id, index]))
    tasks = [...tasks].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  return planSchema.parse({
    ...plan,
    tasks,
    tests: merge(plan.tests, patch.tests, patch.removeTestIds),
    ...(patch.checks === undefined ? {} : { checks: patch.checks }),
    ...(patch.gaps === undefined ? {} : { gaps: patch.gaps }),
    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
  })
}

/** True when a plan writes UI code, which needs the Aspira UI kit's component docs. */
export function touchesUi(plan: { tasks: { changes: { path: string }[] }[] }): boolean {
  return plan.tasks.some((task) => task.changes.some((change) => /\.(?:tsx|jsx|css|scss)$/.test(change.path) || /(?:^|\/)components\//.test(change.path)))
}

/**
 * A model's question with the decision id it copied from a decisions file taken off (`D1 — `, `D1: `,
 * even twice over), and that id (KIT-90): the id is how a rerun's decision finds the author's tick.
 */
export function carriedId(question: string): { id: string | null; question: string } {
  let id: string | null = null
  let rest = question.trim()
  for (let match = rest.match(/^(D\d+)\s*(?:—|–|:|-)\s*(\S.*)$/s); match !== null; match = rest.match(/^(D\d+)\s*(?:—|–|:|-)\s*(\S.*)$/s)) {
    id ??= match[1]!
    rest = match[2]!.trim()
  }
  return { id, question: rest }
}

/**
 * Research's and planning's decisions as one list, D1, D2, ..., the same question once, with the
 * author's ticked answers applied. A tick is matched by the decision id the model carried from the
 * previous decisions file, when the ticked option is one of the decision's options, else by the
 * question (KIT-90). With `takeRecommended` (F10), every decision still open after the
 * author's ticks are applied is taken as the agent's recommended option instead of waiting on the
 * author; a tick the agent made itself is ignored by `applyAnswers`, so a rerun never records it as
 * the author's.
 */
export function mergeDecisions(lists: readonly (readonly Decision[])[], answers: readonly Answer[] = [], takeRecommended = false): DecisionRecord[] {
  const seen = new Set<string>()
  const merged: { decision: DecisionRecord; carried: string | null }[] = []
  for (const raw of lists.flat()) {
    const { id: carried, question } = carriedId(raw.question)
    const key = normalizeQuestion(question)
    if (seen.has(key) || (carried !== null && merged.some((entry) => entry.carried === carried))) continue
    seen.add(key)
    merged.push({ decision: { ...raw, question, id: `D${merged.length + 1}`, decidedBy: 'open', answer: null }, carried })
  }
  const option = (decision: Decision, text: string) => decision.options.find((item) => normalizeQuestion(item) === normalizeQuestion(text))
  const applied = merged.map(({ decision, carried }) => {
    const byId = answers.find((answer) => answer.id === carried && option(decision, answer.answer) !== undefined)
    const [after] = applyAnswers([decision], byId === undefined ? answers : [{ ...byId, question: decision.question }])
    // The answer as the option is written, so the rewritten decisions file shows the tick (KIT-90).
    return after!.answer === null ? after! : { ...after!, answer: option(after!, after!.answer) ?? after!.answer }
  })
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
    for (const change of task.changes) lines.push(`  - ${change.operation}${change.from === undefined ? '' : ` \`${change.from}\` to`} \`${change.path}\`; symbols: ${change.symbols.map((symbol) => `\`${symbol}\``).join(', ')}. ${change.instructions}`, `    - Evidence: ${change.evidence.join('; ')}`)
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
