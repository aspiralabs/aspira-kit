import { defineAgent } from 'eve'
export default defineAgent({
  description: 'Turns a feature idea into a reviewed spec: repository exploration, an initial draft, then the official spec review.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
