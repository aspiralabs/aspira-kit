import { defineAgent } from 'eve'
export default defineAgent({
  description: 'Three-phase spec review with preserved findings and business acceptance criteria.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
