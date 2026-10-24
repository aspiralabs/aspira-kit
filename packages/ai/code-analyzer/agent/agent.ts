import { defineAgent } from 'eve'

// The root only routes: one static-analysis tool call owns detection, the fix loop and the report.
export default defineAgent({
  description: 'Detects a repository\'s static analyzers, runs and auto-fixes them, hands the rest to a workhorse model, and loops until clean.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
