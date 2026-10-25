import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { decisionSchema, parseTickedDecisions, renderDecisions, type Answer, type DecisionRecord } from '@aspiralabs/ai/common/lib/decisions'
import { applyPlanPatch, mergeDecisions, planPatchSchema, planSchema, problemSeverity, renderPlan, touchesUi, type Plan, type PlanPatch } from '@aspiralabs/ai/common/lib/plan'
import { allowedPath } from '@aspiralabs/ai/common/lib/repository'
import { countBySeverity, findingsHeader, severityHeading, sortBySeverity } from '@aspiralabs/ai/common/lib/severity'
import { specFeatures } from '@aspiralabs/ai/common/lib/spec'

const text = z.string().trim().min(1)
/** A product question for the spec's author: the question, the options, the recommended one and why it is theirs. */
export { decisionSchema }
// planSchema, Plan, renderPlan, mergeDecisions and problemSeverity now live in
// @aspiralabs/ai/common/lib/plan (the implementor's plan-block recovery needs them without
// depending on this package); re-exported here unchanged so every existing import of './plan.ts' keeps working.
export { applyPlanPatch, planPatchSchema, planSchema, renderPlan, mergeDecisions, problemSeverity, touchesUi, type PlanPatch }
export type { Plan }
/**
 * One file the change will create, modify, delete or move, as research found it: the symbols the plan
 * will touch there and, for an existing file, the line window that holds them. Planning writes its
 * changes from this list instead of opening the files again.
 */
export const touchSchema = z.object({ path: text, operation: z.enum(['create', 'modify', 'delete', 'move']), symbols: z.array(text).min(1), lines: text.optional(), why: text })
export type Touch = z.infer<typeof touchSchema>

export const researchSchema = z.object({ facts: z.array(text), checks: z.array(z.object({ rule: text, evidence: text })), gaps: z.array(text), decisions: z.array(decisionSchema), notes: z.array(text).optional(), touches: z.array(touchSchema).optional() })

/** One parallel explorer's findings for its area: facts with file:line citations, the files the change touches there, and what it could not read. */
export const exploreSchema = z.object({ facts: z.array(text), touches: z.array(touchSchema), gaps: z.array(text) })
export type Exploration = z.infer<typeof exploreSchema>
export type Research = z.infer<typeof researchSchema>

function safePath(path: string) {
  return !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..') && allowedPath(path)
}

/** Paths a plan may change. Lockfiles and .npmrc are not indexed (allowedPath) but features legitimately edit
 * them; secrets, keys, VCS internals, dependencies and build output stay off-limits. */
export function writablePath(path: string) {
  const structural = !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..')
  const managed = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.npmrc)$/.test(path)
  return structural && (allowedPath(path) || (managed && !path.split('/').some((part) => /^(?:\.git|node_modules|\.eve|\.next|dist|\.output|coverage|vendor)$/i.test(part))))
}

/**
 * The file a citation points at when the citation holds, else null. Two forms: `path:line` or
 * `path:start-end` inside the file, and `path#symbol` where the symbol appears in the file as a whole
 * word. A symbol citation lets a plan cite a function or export without opening the file for its line.
 */
export function citedPath(citation: string, files: Map<string, string>): string | null {
  const symbol = citation.match(/^([^\s#]+?)#([^\s#]+)(?:\s|$)/)
  if (symbol !== null) {
    const source = files.get(symbol[1]!)
    const name = symbol[2]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return source !== undefined && new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(source) ? symbol[1]! : null
  }
  const line = citation.match(/^(.+?):(\d+)(?:-(\d+))?(?::|\s|$)/)
  if (line === null) return null
  const source = files.get(line[1]!)
  const start = Number(line[2])
  const end = line[3] === undefined ? start : Number(line[3])
  return source !== undefined && start > 0 && end >= start && end <= source.split('\n').length ? line[1]! : null
}

export function validatePlan(plan: Plan, spec: string, files: Map<string, string>, tracked: Set<string> = new Set(files.keys())): string[] {
  const errors: string[] = []
  const features = new Set(specFeatures(spec).items.map((item) => item.id))
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]))
  const tests = new Map(plan.tests.map((test) => [test.id, test]))
  if (tasks.size !== plan.tasks.length) errors.push('Duplicate task IDs')
  if (tests.size !== plan.tests.length) errors.push('Duplicate test IDs')
  for (const row of [...plan.tasks, ...plan.tests]) {
    if (new Set(row.featureIds).size !== row.featureIds.length || row.featureIds.some((id) => !features.has(id))) errors.push(`Invalid feature references: ${row.id}`)
  }
  for (const kind of ['unit', 'integration']) if (!plan.tests.some((test) => test.kind === kind)) errors.push(`Missing ${kind} tests`)
  const seen = new Set<string>()
  const ancestors = new Map<string, Set<string>>()
  const existing = new Set([...files.keys(), ...tracked])
  for (const task of plan.tasks) {
    const prior = new Set<string>()
    for (const id of task.dependsOn) {
      if (!seen.has(id)) errors.push(`Dependency must precede ${task.id}: ${id}`)
      prior.add(id)
      for (const ancestor of ancestors.get(id) ?? []) prior.add(ancestor)
    }
    ancestors.set(task.id, prior)
    if (new Set(task.testIds).size !== task.testIds.length || task.testIds.some((id) => !tests.has(id))) errors.push(`Invalid test references: ${task.id}`)
    // A handoff is work the spec assigns to a named person (a protected file, a page outside the repo): no file actions.
    if ((task.kind === 'tests' || task.kind === 'implementation') && !task.changes.length) errors.push(`No file actions: ${task.id}`)
    if (task.kind === 'handoff' && task.changes.length) errors.push(`A handoff changes no files; the person makes the change: ${task.id}`)
    if (task.kind === 'verification' && !task.commands.length) errors.push(`No verification commands: ${task.id}`)
    if (task.kind === 'tests') {
      if (!task.testIds.length) errors.push(`Test task has no cases: ${task.id}`)
      if (!task.commands.length) errors.push(`Test task has no test command: ${task.id}`)
      for (const change of task.changes) if (change.operation === 'delete' || !task.testIds.some((id) => tests.get(id)?.path === change.path)) errors.push(`Test task changes a non-test target: ${task.id}/${change.path}`)
      for (const id of task.testIds) {
        const test = tests.get(id)
        if (test && !task.changes.some((change) => change.path === test.path && change.operation !== 'delete')) errors.push(`Test file not written by ${task.id}: ${id}`)
        if (test?.featureIds.some((id) => !task.featureIds.includes(id))) errors.push(`Test features absent from writing task: ${task.id}`)
      }
    }
    if (task.kind === 'implementation') for (const id of task.featureIds) {
      const testedFirst = plan.tests.filter((test) => test.featureIds.includes(id)).every((test) => [...prior].some((parent) => {
        const prerequisite = tasks.get(parent)
        return prerequisite?.kind === 'tests' && prerequisite.testIds.includes(test.id)
      })) && plan.tests.some((test) => test.featureIds.includes(id))
      if (!testedFirst) errors.push(`Implementation ${task.id} needs an earlier test dependency for ${id}`)
    }
    for (const change of task.changes) {
      if (!writablePath(change.path)) { errors.push(`Unsafe path: ${change.path}`); continue }
      if (change.operation === 'move') {
        // A move relocates a file or a whole directory: every path under `from` exists at `path` for later tasks.
        const from = change.from ?? ''
        if (!writablePath(from)) { errors.push(`Unsafe path: ${from}`); continue }
        const moved = [...existing].filter((path) => path === from || path.startsWith(`${from}/`))
        if (!moved.length) errors.push(`Missing move source: ${from}`)
        if ([...existing].some((path) => path === change.path || path.startsWith(`${change.path}/`))) errors.push(`Move target already exists: ${change.path}`)
        const cited = change.evidence.some((citation) => {
          const path = citedPath(citation, files)
          return path !== null && (path === from || path.startsWith(`${from}/`))
        })
        if (!cited) errors.push(`No valid source evidence: ${task.id}/${from}`)
        for (const path of moved) {
          existing.delete(path)
          existing.add(`${change.path}${path.slice(from.length)}`)
        }
        continue
      }
      if (change.operation === 'create' && existing.has(change.path)) errors.push(`Create target already exists: ${change.path}`)
      if (change.operation !== 'create' && !existing.has(change.path)) {
        const directory = [...existing].some((path) => path.startsWith(`${change.path}/`))
        errors.push(directory ? `Target is a directory, not a file; name each file to ${change.operation}: ${change.path}` : `Missing ${change.operation} target: ${change.path}`)
      }
      // Citations are `path:line` or `path:start-end`; a range must sit inside the file.
      const valid = change.evidence.map((citation) => citedPath(citation, files)).filter((path) => path !== null)
      if (!valid.length) errors.push(`No valid source evidence: ${task.id}/${change.path}`)
      if (change.operation !== 'create' && files.has(change.path) && !valid.includes(change.path)) errors.push(`Target not cited: ${change.path}`)
      if (change.operation === 'delete') existing.delete(change.path)
      else existing.add(change.path)
    }
    seen.add(task.id)
  }
  for (const test of plan.tests) {
    if (!safePath(test.path)) errors.push(`Unsafe test path: ${test.path}`)
    if (!plan.tasks.some((task) => task.kind === 'tests' && task.testIds.includes(test.id))) errors.push(`Test case has no writing task: ${test.id}`)
  }
  for (const id of features) {
    // A criterion met only by a person's handoff (a Notion page, say) has no code to test.
    const handedOff = plan.tasks.some((task) => task.kind === 'handoff' && task.featureIds.includes(id))
    if (!handedOff && !plan.tasks.some((task) => task.kind === 'implementation' && task.featureIds.includes(id))) errors.push(`No implementation maps to ${id}`)
    if (!handedOff && !plan.tests.some((test) => test.featureIds.includes(id))) errors.push(`No test maps to ${id}`)
  }
  if (!plan.tasks.some((task) => task.kind === 'verification')) errors.push('Missing final verification task')
  // Named in full, so a correction pass knows what to move or wire (SCOOP-7, SCOOP-8: a handoff after the verification survived two repairs).
  const final = plan.tasks.at(-1)
  const verification = plan.tasks.findLast((task) => task.kind === 'verification')
  if (final && verification && final.kind !== 'verification') {
    const after = plan.tasks.slice(plan.tasks.indexOf(verification) + 1).map((task) => `${task.id} (${task.kind})`)
    errors.push(`The last task must be the verification task: ${after.join(', ')} come${after.length === 1 ? 's' : ''} after ${verification.id}. Move ${after.length === 1 ? 'it' : 'them'} before ${verification.id} (taskOrder) and drop any dependency on ${verification.id}`)
  }
  if (final?.kind === 'verification') {
    const missing = plan.tasks.filter((task) => task.kind === 'implementation' && !ancestors.get(final.id)?.has(task.id)).map((task) => task.id)
    if (missing.length) errors.push(`Final verification ${final.id} must depend on every implementation task; add ${missing.join(', ')} to its dependsOn`)
  }
  return errors
}

/** The ticks the author made in the previous plan's trace/decisions.md, or none when there is no previous plan. */
export async function readAnswers(outputDir: string): Promise<Answer[]> {
  const text = await readFile(join(outputDir, 'trace', 'decisions.md'), 'utf8').catch(() => null)
  return text === null ? [] : parseTickedDecisions(text)
}

/** trace/decisions.md: every decision as checkboxes the author ticks, recommended option first. */
export function renderDecisionsFile(status: string, decisions: readonly DecisionRecord[]): string {
  return renderDecisions(decisions, { title: 'Author decisions', status, intro: 'Tick one option per decision to answer it. The next plan of this spec reads the tick and records the decision as yours in trace/review.json.' })
}

/** trace/checks.md: the readiness problems in severity order under a header whose count equals the list. */
export function renderChecks(status: string, problems: readonly string[]): string {
  const ordered = sortBySeverity(problems, problemSeverity)
  const lines = ['# Planning checks', '', `Status: ${status}`, '', findingsHeader(countBySeverity(ordered, problemSeverity), 'problems'), '']
  if (!ordered.length) lines.push('None: every structural check passed.', '')
  for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
    const group = ordered.filter((problem) => problemSeverity(problem) === severity)
    if (!group.length) continue
    lines.push(`## ${severityHeading(severity)}`, '', ...group.map((problem) => `- ${problem}`), '')
  }
  return lines.join('\n')
}
