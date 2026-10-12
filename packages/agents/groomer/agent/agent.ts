import { defineAgent } from 'eve'

// The root only routes: load-knowledge, then the groom workflow, then the report. The router is the
// cheap tier; rounds are composed in the runner on the frontier tier, facts by the fact-finder.
export default defineAgent({
  description: 'Grooms a Feature card\'s Idea in rounds before it reaches Ready: Idea: finds the facts in the repository, asks the product decisions the Idea leaves open, and records the answers on the card.',
  model: 'anthropic/claude-haiku-4.5',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
