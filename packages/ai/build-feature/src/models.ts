// The model each subagent of a build-feature run uses, in one table (spec A15, revised). The
// orchestrating session runs on Fable; the steps that write or decide run on Opus; the workers that
// edit code and the review seats run on Sonnet; fetches, pushes and the analyzer run on Haiku. A
// project can override a role in aspira.json `models`; the override is validated at the boundary
// (PATTERN-012) and an unknown role or model name is refused, naming it.

import { parseModelChoices, phaseKey, type Effort, type ModelChoice, type ModelName } from '@aspiralabs/ai/common/lib/model-config'

export { MODEL_NAMES, EFFORTS, type ModelName, type Effort } from '@aspiralabs/ai/common/lib/model-config'

export const ROLES = [
  'orchestrator',
  'groomer',
  'spec-writer',
  'planner',
  'implementor',
  'pr-reviewer',
  'pr-reviewer-verifier',
  'fix',
  'knowledge',
  'notion-push',
  'code-analyzer',
] as const
export type Role = (typeof ROLES)[number]

/** The model each role runs on unless aspira.json `models` overrides it. */
export const MODELS: Readonly<Record<Role, ModelName>> = {
  orchestrator: 'fable',
  groomer: 'opus',
  'spec-writer': 'opus',
  planner: 'opus',
  // The implementor's lane workers.
  implementor: 'sonnet',
  // The PR-review seats.
  'pr-reviewer': 'sonnet',
  'pr-reviewer-verifier': 'opus',
  // The Step 9 fix subagent.
  fix: 'sonnet',
  knowledge: 'haiku',
  'notion-push': 'haiku',
  'code-analyzer': 'haiku',
}

const RETIRED_ROLES = ['spec-reviewer'] as const
const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

export type ModelOverrides = Partial<Record<Role, ModelChoice>>

/**
 * The role entries of aspira.json `models` (common/lib/model-config.ts), every value and phase key
 * validated there and every role key here: an unknown role is refused, naming it; a role an earlier kit
 * knew (spec-reviewer, folded into spec-writer by KIT-48) is ignored. `<step>.<phase>` keys are the
 * step's own tasks and are not roles.
 */
export function parseModels(models: unknown): ModelOverrides {
  const keys = typeof models === 'object' && models !== null && !Array.isArray(models) ? Object.keys(models) : []
  const problems = keys
    .filter((key) => phaseKey(key) === null && !(RETIRED_ROLES as readonly string[]).includes(key) && !isRole(key))
    .map((key) => `unknown role "${key}" in aspira.json models; the roles are ${ROLES.join(', ')}, or <step>.<phase> for a step's tasks`)
  let choices: ReturnType<typeof parseModelChoices> = {}
  try {
    choices = parseModelChoices(models)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  const out: ModelOverrides = {}
  for (const [key, choice] of Object.entries(choices)) if (isRole(key)) out[key] = choice
  return out
}

/** The model a role runs on: the aspira.json override when there is one, else the table. */
export function modelFor(role: Role, aspira: { models?: unknown } | null = null): ModelName {
  return parseModels(aspira?.models)[role]?.model ?? MODELS[role]
}

/** The reasoning effort a role runs at when aspira.json sets one; undefined keeps the Agent tool's default. */
export function effortFor(role: Role, aspira: { models?: unknown } | null = null): Effort | undefined {
  return parseModels(aspira?.models)[role]?.effort
}

/** The line a step prompt carries about the models the step's own subagents use. */
export function subagentModels(step: string, aspira: { models?: unknown } | null = null): string {
  const fetches = `knowledge fetches ${modelFor('knowledge', aspira)}, Notion page pushes ${modelFor('notion-push', aspira)}`
  if (step === 'implementor') return `Its lane workers run on ${modelFor('implementor', aspira)}; ${fetches}.`
  if (step === 'pr-reviewer') return `Its review seats run on ${modelFor('pr-reviewer', aspira)} and its verifier on ${modelFor('pr-reviewer-verifier', aspira)}; ${fetches}.`
  return `Its own tasks name their model and, when aspira.json sets one, their effort (by default research and reconciliation on opus, specialists on sonnet, explorers on haiku); ${fetches}.`
}
