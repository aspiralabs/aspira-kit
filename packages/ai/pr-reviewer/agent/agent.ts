import { defineAgent } from 'eve'

// The root only routes: loads the PR, runs pr-debator, exports the markdown,
// reports back. Cheap model, no self-copies. The six seats and the verifier are
// hidden subagents; only the workflow reaches them.
export default defineAgent({
  description: 'Loads a pull request, runs the pr-debator review loop over it, and reports the verdict and the markdown.',
  model: 'anthropic/claude-sonnet-5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
