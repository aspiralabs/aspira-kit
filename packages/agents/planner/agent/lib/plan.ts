import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { allowedPath } from '@aspiralabs/agent-common/lib/repository'
import { specFeatures } from '@aspiralabs/agent-common/lib/spec'

const text = z.string().trim().min(1)
const features = z.array(z.string().regex(/^F\d+$/)).min(1)
export const researchSchema = z.object({ facts: z.array(text), checks: z.array(z.object({ rule: text, evidence: text })), gaps: z.array(text), decisions: z.array(text) })
export const planSchema = z.object({
  summary: text,
  tasks: z.array(z.object({
    id: z.string().regex(/^P\d+$/), title: text, kind: z.enum(['tests', 'implementation', 'verification']),
    featureIds: features, dependsOn: z.array(text), testIds: z.array(text),
    changes: z.array(z.object({ operation: z.enum(['create', 'modify', 'delete']), path: text, symbols: z.array(text).min(1), instructions: text, evidence: z.array(text).min(1) })),
    commands: z.array(text), outcome: text,
  })).min(1),
  tests: z.array(z.object({ id: z.string().regex(/^T\d+$/), kind: z.enum(['unit', 'integration']), path: text, featureIds: features, setup: text, action: text, assertions: z.array(text).min(1) })).min(1),
  checks: z.array(z.object({ rule: text, evidence: text })),
  decisions: z.array(text), gaps: z.array(text),
})
export type Plan = z.infer<typeof planSchema>
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
    if (task.kind !== 'verification' && !task.changes.length) errors.push(`No file actions: ${task.id}`)
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
      if (change.operation === 'create' && existing.has(change.path)) errors.push(`Create target already exists: ${change.path}`)
      if (change.operation !== 'create' && !existing.has(change.path)) {
        const directory = [...existing].some((path) => path.startsWith(`${change.path}/`))
        errors.push(directory ? `Target is a directory, not a file; name each file to ${change.operation}: ${change.path}` : `Missing ${change.operation} target: ${change.path}`)
      }
      // Citations are `path:line` or `path:start-end`; a range must sit inside the file.
      const sources = change.evidence.map((citation) => citation.match(/^(.+?):(\d+)(?:-(\d+))?(?::|\s|$)/)).filter((match) => match !== null)
      const valid = sources.filter((match) => {
        const source = files.get(match[1]!)
        const start = Number(match[2])
        const end = match[3] === undefined ? start : Number(match[3])
        return source !== undefined && start > 0 && end >= start && end <= source.split('\n').length
      })
      if (!valid.length) errors.push(`No valid source evidence: ${task.id}/${change.path}`)
      if (change.operation !== 'create' && files.has(change.path) && !valid.some((match) => match[1] === change.path)) errors.push(`Target not cited: ${change.path}`)
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
    if (!plan.tasks.some((task) => task.kind === 'implementation' && task.featureIds.includes(id))) errors.push(`No implementation maps to ${id}`)
    if (!plan.tests.some((test) => test.featureIds.includes(id))) errors.push(`No test maps to ${id}`)
  }
  if (!plan.tasks.some((task) => task.kind === 'verification')) errors.push('Missing final verification task')
  const final = plan.tasks.at(-1)
  if (final?.kind !== 'verification' || plan.tasks.some((task) => task.kind === 'implementation' && !ancestors.get(final.id)?.has(task.id))) errors.push('Final verification must depend on every implementation task')
  return errors
}

export function renderPlan(plan: Plan, status: string, source: { specPath: string; commit: string; dirty: boolean }, problems: string[]): string {
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
  lines.push('## Author decisions', '', ...(plan.decisions.length ? plan.decisions.map((item) => `- ${item}`) : ['None.']), '', '## Readiness checks', '', ...(problems.length ? problems.map((item) => `- ${item}`) : ['All structural checks passed; tasks and commands are instructions for the build agent and have not been executed.']), '', 'See trace/ for the source spec, guidelines, evidence, model activity and validation details.', '')
  return lines.join('\n')
}
