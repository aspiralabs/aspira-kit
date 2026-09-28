import { defineAgent } from 'eve'
export default defineAgent({
  description: 'Create repository-grounded implementation plans and test-first unit/integration checklists from business specs.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
