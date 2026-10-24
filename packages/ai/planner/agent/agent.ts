import { defineAgent } from 'eve'
export default defineAgent({
  description: 'Create repository-grounded implementation plans and test-first unit/integration checklists from business specs.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  // The router only loads knowledge and calls create-plan, which run on the host. The sandbox
  // cannot see the host repository, so its bash/read_file tools only lead the router astray.
  defaultTools: false,
  limits: { sessionTimeoutMs: false },
})
