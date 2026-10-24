// aspira.json `models`: which model, and how much reasoning, each part of a run gets. Two kinds of key:
//
//   "<role>"          a build-feature role (driver/models.ts ROLES): the step's own subagent, the review
//                     seats, the fix subagent, the Notion pushes.
//   "<step>.<phase>"  one kind of task a step's `local` stage prints (planner.research, planner.planning,
//                     planner.repair, spec-writer.explore, groomer.round, implementor.worker, …).
//
// A value is a model name ("opus") or { "model"?: name, "effort"?: level }. `effort` is the Agent tool's
// reasoning effort; "low" is the closest to reasoning off. A key left out keeps the kit's default, so
// an empty map changes nothing. Meant for experiments: compare models and effort per phase on real
// tickets, then promote what wins into the defaults.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const MODEL_NAMES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type ModelName = (typeof MODEL_NAMES)[number]

/** The Agent tool's reasoning effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** The steps whose `local` tasks can be overridden per phase, by `<step>.<phase>`. */
export const TASK_STEPS = ['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'] as const

export type ModelChoice = { model?: ModelName; effort?: Effort }

const entrySchema = z.union([z.enum(MODEL_NAMES), z.strictObject({ model: z.enum(MODEL_NAMES).optional(), effort: z.enum(EFFORTS).optional() })])

/** A `<step>.<phase>` key, or null for a plain role key. */
export function phaseKey(key: string): { step: string; phase: string } | null {
  const at = key.indexOf('.')
  return at === -1 ? null : { step: key.slice(0, at), phase: key.slice(at + 1) }
}

/**
 * aspira.json `models`, every entry validated: a value is a known model or { model, effort } with known
 * names, and a phase key names a step that has tasks. Role keys are checked by the driver, which knows
 * its roles. Throws one message naming every bad entry.
 */
export function parseModelChoices(models: unknown): Record<string, ModelChoice> {
  if (models === undefined) return {}
  if (typeof models !== 'object' || models === null || Array.isArray(models)) throw new Error('aspira.json models is not an object of key → model')
  const out: Record<string, ModelChoice> = {}
  const problems: string[] = []
  for (const [key, value] of Object.entries(models)) {
    const phase = phaseKey(key)
    if (phase !== null && !(TASK_STEPS as readonly string[]).includes(phase.step)) problems.push(`unknown step "${phase.step}" in aspira.json models key "${key}"; the steps with tasks are ${TASK_STEPS.join(', ')}`)
    const parsed = entrySchema.safeParse(value)
    if (!parsed.success) {
      problems.push(`aspira.json models "${key}": ${JSON.stringify(value)} is not a model (${MODEL_NAMES.join(', ')}) or { "model", "effort" } with effort one of ${EFFORTS.join(', ')}`)
      continue
    }
    out[key] = typeof parsed.data === 'string' ? { model: parsed.data } : parsed.data
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return out
}

/** The nearest aspira.json at or above `from`, or null. */
function findAspira(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const file = join(dir, 'aspira.json')
    if (existsSync(file)) return file
    if (dirname(dir) === dir) return null
  }
}

/**
 * The model and effort for one kind of task: the `<step>.<phase>` entry of the nearest aspira.json
 * when there is one, else `fallback` with no effort (the Agent tool's default). A missing or unreadable
 * aspira.json is the defaults, never an error: the driver refuses a bad `models` before any step runs.
 */
export function taskModel<M extends string>(key: `${(typeof TASK_STEPS)[number]}.${string}`, fallback: M, from: string = process.cwd()): { model: M | ModelName; effort?: Effort } {
  const file = findAspira(from)
  if (file === null) return { model: fallback }
  let choice: ModelChoice | undefined
  try {
    choice = parseModelChoices((JSON.parse(readFileSync(file, 'utf8')) as { models?: unknown }).models)[key]
  } catch {
    return { model: fallback }
  }
  return { model: choice?.model ?? fallback, ...(choice?.effort === undefined ? {} : { effort: choice.effort }) }
}
