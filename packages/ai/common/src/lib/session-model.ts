// The model a --local task runs on (KIT-48): every task a step's `local` stage prints names one of
// the session's model names, and the orchestrating session launches that task's subagent on it.
// The orchestrator itself stays on Fable; research and synthesis run on Opus, specialists on
// Sonnet, explorers and mechanical work on Haiku. The names are the Agent tool's.

// fable is never a default task model; aspira.json `models` may name it for an experiment (model-config.ts).
export const SESSION_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type SessionModel = (typeof SESSION_MODELS)[number]

/** The session model closest to a gateway model id (`anthropic/claude-haiku-4.5`, `openai/gpt-6.1-sol`): haiku and sonnet by name, everything else opus. */
export function sessionModel(gatewayModel: string | undefined): SessionModel {
  const id = (gatewayModel ?? '').toLowerCase()
  if (id.includes('haiku')) return 'haiku'
  if (id.includes('sonnet')) return 'sonnet'
  return 'opus'
}
