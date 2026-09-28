import { defineAgent } from 'eve'

// Hidden from the root model; only the pr-debator workflow calls Quinn.
export default defineAgent({
  description: 'Quinn, the verification seat of the PR review. Runs on OpenAI.',
  // Checking a finding against the file it names is mechanical work, and Quinn makes
  // more calls than any seat. luna is ~100x cheaper per token than gpt-6-astra, which
  // cost more than a third of the first real run. Move up to openai/gpt-6-sol if the
  // rulings start reading like rubber stamps.
  model: 'openai/gpt-6-luna',
  tool: false,
  limits: { sessionTimeoutMs: false },
})
