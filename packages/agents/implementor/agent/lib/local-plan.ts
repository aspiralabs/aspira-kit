// --local plan mechanics: the shapes the session's outputs must have and the structural checks
// on them. The judgment (hot files, inferred edges, lane grouping, whether to use workers) stays
// with the procedure the session follows; this file only checks that the result is coherent.

import { z } from 'zod'

const text = z.string().trim().min(1)
const ids = z.array(text)

/** plan.json as the planner writes it, kept loose: real plans carry extra kinds and fields. */
export const PLAN = z.looseObject({
  summary: z.string().optional(),
  tasks: z
    .array(
      z.looseObject({
        id: text,
        kind: text,
        featureIds: ids.default([]),
        dependsOn: ids.default([]),
        testIds: ids.default([]),
        changes: z.array(z.looseObject({ operation: z.enum(['create', 'modify', 'delete']), path: text })).default([]),
        commands: ids.default([]),
      }),
    )
    .min(1),
  tests: z.array(z.looseObject({ id: text, path: text, featureIds: ids.default([]) })).default([]),
  decisions: z.array(z.unknown()).default([]),
  gaps: z.array(z.unknown()).default([]),
})
/** A parsed plan. */
export type Plan = z.infer<typeof PLAN>
type Task = Plan['tasks'][number]

/** The session's parallelization: waves of lanes, each lane's tasks in order and its write scope. */
export const PARALLELIZATION = z.object({
  waves: z
    .array(
      z.object({
        lanes: z
          .array(
            z.object({
              id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'a lane id is letters, digits, - or _'),
              tasks: ids.min(1),
              /** True: a worker subagent builds it. False: the orchestrator (the session) does. */
              worker: z.boolean(),
              writeScope: ids,
              /** The rules this lane's brief carries, with their ids. */
              rules: ids.default([]),
              /** For UI lanes: the components and their docs. */
              ui: z.string().default(''),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  inferredEdges: z.array(z.string()).default([]),
  notes: z.string().default(''),
})
/** A parsed parallelization. */
export type Parallelization = z.infer<typeof PARALLELIZATION>
/** One lane of a wave. */
export type Lane = Parallelization['waves'][number]['lanes'][number]

/** A worker's report, in the shape the procedure's worker brief asks for. */
export const WORKER_REPORT = z.object({
  tasks: z.array(z.object({ id: text, status: z.enum(['done', 'blocked']) })).min(1),
  filesChanged: z.array(z.string()),
  red: z.string(),
  green: z.array(z.object({ command: text, exitCode: z.number().int() })),
  deviations: z.array(z.string()),
  blockers: z.array(z.string()),
})

/** The orchestrator's record of a verified wave. */
export const WAVE_RESULT = z.object({
  status: z.enum(['committed', 'partial', 'blocked']),
  /** The wave's commit; null only when nothing could be committed. */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  tasks: z.array(z.object({ id: text, status: z.enum(['done', 'blocked', 'skipped']) })),
  notes: z.string().default(''),
})

/** The final verification: the feature table and what is left open. */
export const VERIFICATION = z.object({
  status: z.enum(['done', 'partial', 'blocked']),
  features: z.array(z.object({ id: text, tasks: ids, tests: ids, passing: z.boolean() })),
  deviations: z.array(z.string()),
  blockers: z.array(z.string()),
  assumptions: z.array(z.string()),
})

/** The schemas by the name the driver prints. */
export const SCHEMAS = { PLAN, PARALLELIZATION, WORKER_REPORT, WAVE_RESULT, VERIFICATION } as const
/** A schema name. */
export type SchemaName = keyof typeof SCHEMAS

/** The paths a task writes: its changes, plus its test files for a tests task. */
export function writeSet(task: Task, plan: Plan): string[] {
  const tests = task.kind === 'tests' ? plan.tests.filter((t) => task.testIds.includes(t.id)).map((t) => t.path) : []
  return [...new Set([...task.changes.map((c) => c.path), ...tests])]
}

/** Structural problems: duplicate ids, unknown references, cycles. */
export function planProblems(plan: Plan): string[] {
  const problems: string[] = []
  const taskIds = new Set<string>()
  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) problems.push(`Task ${task.id} appears twice.`)
    taskIds.add(task.id)
  }
  const testIds = new Set(plan.tests.map((t) => t.id))
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) if (!taskIds.has(dep)) problems.push(`${task.id} depends on unknown task ${dep}.`)
    for (const test of task.testIds) if (!testIds.has(test)) problems.push(`${task.id} names unknown test ${test}.`)
  }
  if (problems.length === 0 && baselineWaves(plan) === null) problems.push('dependsOn has a cycle.')
  return problems
}

/**
 * The dependency levels from dependsOn and overlapping write sets alone (an earlier task in plan
 * order goes first). A starting point for the session, not the answer. Null on a cycle.
 */
export function baselineWaves(plan: Plan): string[][] | null {
  const order = plan.tasks.map((t) => t.id)
  const edges = new Map<string, Set<string>>(order.map((id) => [id, new Set()]))
  const sets = new Map(plan.tasks.map((t) => [t.id, writeSet(t, plan)]))
  plan.tasks.forEach((task, i) => {
    for (const dep of task.dependsOn) edges.get(task.id)?.add(dep)
    for (const earlier of plan.tasks.slice(0, i)) {
      if ((sets.get(task.id) ?? []).some((path) => (sets.get(earlier.id) ?? []).includes(path))) edges.get(task.id)?.add(earlier.id)
    }
  })
  const level = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number | null => {
    const known = level.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return null
    visiting.add(id)
    let max = -1
    for (const dep of edges.get(id) ?? []) {
      const d = depth(dep)
      if (d === null) return null
      max = Math.max(max, d)
    }
    visiting.delete(id)
    level.set(id, max + 1)
    return max + 1
  }
  const waves: string[][] = []
  for (const id of order) {
    const d = depth(id)
    if (d === null) return null
    ;(waves[d] ??= []).push(id)
  }
  return waves
}

/** Paths a create must not find, and a modify or delete must find, checked by the caller's exists. */
export function targetProblems(plan: Plan, exists: (path: string) => boolean): string[] {
  const problems: string[] = []
  for (const task of plan.tasks) {
    for (const change of task.changes) {
      const there = exists(change.path)
      if (change.operation === 'create' && there) problems.push(`${task.id} creates ${change.path}, which already exists.`)
      if (change.operation !== 'create' && !there) problems.push(`${task.id} ${change.operation}s ${change.path}, which does not exist.`)
    }
  }
  return problems
}

/** Coherence of the session's parallelization against the plan. Empty means usable. */
export function parallelizationProblems(plan: Plan, par: Parallelization, options: { serial: boolean }): string[] {
  const problems: string[] = []
  const tasks = new Map(plan.tasks.map((t) => [t.id, t]))
  const placed = new Map<string, { wave: number; lane: string; position: number }>()
  par.waves.forEach((wave, w) => {
    const laneIds = new Set<string>()
    for (const lane of wave.lanes) {
      if (laneIds.has(lane.id)) problems.push(`Wave ${w + 1} has two lanes named ${lane.id}.`)
      laneIds.add(lane.id)
      if (options.serial && lane.worker) problems.push(`--serial was given, but lane ${lane.id} in wave ${w + 1} is a worker lane.`)
      lane.tasks.forEach((id, position) => {
        if (!tasks.has(id)) problems.push(`Lane ${lane.id} names unknown task ${id}.`)
        else if (placed.has(id)) problems.push(`Task ${id} is placed twice.`)
        else placed.set(id, { wave: w, lane: lane.id, position })
      })
    }
  })
  for (const id of tasks.keys()) if (!placed.has(id)) problems.push(`Task ${id} is in no lane.`)
  for (const [id, where] of placed) {
    for (const dep of tasks.get(id)?.dependsOn ?? []) {
      const before = placed.get(dep)
      if (before === undefined) continue
      const ok = before.wave < where.wave || (before.wave === where.wave && before.lane === where.lane && before.position < where.position)
      if (!ok) problems.push(`${id} depends on ${dep}, which does not run before it (wave ${before.wave + 1} lane ${before.lane}).`)
    }
  }
  par.waves.forEach((wave, w) => {
    for (const lane of wave.lanes) {
      for (const id of lane.tasks) {
        const task = tasks.get(id)
        if (task === undefined) continue
        const outside = writeSet(task, plan).filter((path) => !lane.writeScope.includes(path))
        if (outside.length > 0) problems.push(`Lane ${lane.id} (wave ${w + 1}) runs ${id}, which writes ${outside.join(', ')} outside the lane's write scope.`)
      }
    }
    wave.lanes.forEach((lane, i) => {
      for (const other of wave.lanes.slice(i + 1)) {
        const shared = lane.writeScope.filter((path) => other.writeScope.includes(path))
        if (shared.length > 0) problems.push(`Lanes ${lane.id} and ${other.id} in wave ${w + 1} both write ${shared.join(', ')}.`)
      }
    })
  })
  return problems
}
