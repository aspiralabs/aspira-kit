import { defineAgent } from 'eve'

// Hidden from the root model; only the pr-debator workflow calls Dex.
export default defineAgent({
  description: 'Dex, the developer-experience seat of the PR review. Runs on Claude.',
  model: 'anthropic/claude-opus-5.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
