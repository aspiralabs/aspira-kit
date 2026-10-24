// The model each subagent of a build-feature run uses, in one table (spec A15, revised). The
// orchestrating session runs on Fable; the steps that write or decide run on Opus; the workers that
// edit code and the review seats run on Sonnet; fetches, pushes and the analyzer run on Haiku. A
// project can override a role in aspira.json `models`; the override is validated at the boundary
// (PATTERN-012) and an unknown role or model name is refused, naming it.

import { z } from 'zod'

export const MODEL_NAMES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type ModelName = (typeof MODEL_NAMES)[number]

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
const isModel = (value: string): value is ModelName => (MODEL_NAMES as readonly string[]).includes(value)

/** aspira.json `models`: role → model name, every key a known role and every value a known model. */
export const modelsSchema = z
  .record(z.string(), z.string())
  .superRefine((models, ctx) => {
    for (const [role, model] of Object.entries(models)) {
      // A role an earlier kit knew (spec-reviewer, folded into spec-writer by KIT-48) is ignored, not refused.
      if ((RETIRED_ROLES as readonly string[]).includes(role)) continue
      if (!isRole(role)) ctx.addIssue({ code: 'custom', path: [role], message: `unknown role "${role}" in aspira.json models; the roles are ${ROLES.join(', ')}` })
      if (!isModel(model)) ctx.addIssue({ code: 'custom', path: [role], message: `unknown model "${model}" for ${role} in aspira.json models; the models are ${MODEL_NAMES.join(', ')}` })
    }
  })
  .transform((models) => Object.fromEntries(Object.entries(models).filter(([role]) => !(RETIRED_ROLES as readonly string[]).includes(role))) as Partial<Record<Role, ModelName>>)
export type ModelOverrides = z.infer<typeof modelsSchema>

/** The overrides in aspira.json `models`, or a thrown error naming the unknown role or model. */
export function parseModels(models: unknown): ModelOverrides {
  if (models === undefined) return {}
  const parsed = modelsSchema.safeParse(models)
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '))
  return parsed.data
}

/** The model a role runs on: the aspira.json override when there is one, else the table. */
export function modelFor(role: Role, aspira: { models?: unknown } | null = null): ModelName {
  return parseModels(aspira?.models)[role] ?? MODELS[role]
}

/** The line a step prompt carries about the models the step's own subagents use. */
export function subagentModels(step: string, aspira: { models?: unknown } | null = null): string {
  const fetches = `knowledge fetches ${modelFor('knowledge', aspira)}, Notion page pushes ${modelFor('notion-push', aspira)}`
  if (step === 'implementor') return `Its lane workers run on ${modelFor('implementor', aspira)}; ${fetches}.`
  if (step === 'pr-reviewer') return `Its review seats run on ${modelFor('pr-reviewer', aspira)} and its verifier on ${modelFor('pr-reviewer-verifier', aspira)}; ${fetches}.`
  return `Its own tasks name their model (research and reconciliation on opus, explorers and specialists on sonnet); ${fetches}.`
}
