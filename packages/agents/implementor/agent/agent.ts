import { defineAgent } from 'eve'

// The agent exists to run the aspira-implement skill in the cloud. It keeps the built-in `agent`
// tool: the skill fans independent plan lanes out to copies of this agent, which share the sandbox.
export default defineAgent({
  description: 'Builds an approved spec-to-plan implementation plan test-first in a GitHub repository, running independent tasks in parallel, under the Aspira engineering rules in Notion.',
  model: process.env.IMPLEMENTOR_MODEL || 'anthropic/claude-opus-5.5',
  limits: { sessionTimeoutMs: false },
})
