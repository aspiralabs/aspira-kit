import { defineAgent } from 'eve'

// Hidden from the root model; only the groom workflow calls it, with ctx.agent('fact-finder', ...).
// The cheap tier (spec D13, F35): it searches, it does not decide. Keep the literal in step with
// FACT_FINDER_MODEL in agent/lib/models.ts, which the separate-process runner uses.
export default defineAgent({
  description: 'Round zero of the groomer: searches the repository by the idea\'s domain concepts through read-only tools and returns what already exists and every term that collides with an existing name, each fact with file:line.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
