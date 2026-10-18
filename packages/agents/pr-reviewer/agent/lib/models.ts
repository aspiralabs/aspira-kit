// Which model each agent runs on, for the cost table and the run telemetry. Keep in step with the agent.ts files.
// Dependency-free so build-feature and the ticket scripts can import it under plain node type stripping.
export const MODELS: Readonly<Record<string, string>> = {
  'pr-reviewer': 'anthropic/claude-sonnet-5',
  ava: 'anthropic/claude-opus-5.5',
  cole: 'anthropic/claude-opus-5.5',
  nova: 'anthropic/claude-opus-5.5',
  reba: 'anthropic/claude-opus-5.5',
  dex: 'anthropic/claude-opus-5.5',
  iris: 'anthropic/claude-opus-5.5',
  quinn: 'openai/gpt-6-luna',
}
