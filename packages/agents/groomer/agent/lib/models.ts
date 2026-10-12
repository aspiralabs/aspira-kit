// The groomer's two model tiers (spec D13, F35), both through the Vercel AI Gateway: rounds on the
// frontier tier, fact-finding on the cheap tier the routers already use. The fact-finder subagent
// declares FACT_FINDER_MODEL; eve has no per-call model parameter, so the tier is the subagent's.
export const ROUND_MODEL = 'anthropic/claude-opus-5.5'
export const FACT_FINDER_MODEL = 'anthropic/claude-haiku-4.5'
