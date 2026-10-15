import { z } from 'zod'

// Round zero's output shape. The groom workflow body (agent/tools/groom.ts) parses the fact-finder's
// answer with it, so this module goes into eve's workflow bundle: import nothing here that reaches a
// Node.js builtin (runner.ts does, and the bundle refuses it).

/** What round zero returns: the concepts searched, the facts found and the terms that collide with an existing name. */
export const factFindingSchema = z.object({
  searched: z.array(z.string().trim().min(1)).min(1),
  facts: z.array(z.object({ path: z.string(), line: z.number().int(), quote: z.string().optional() })),
  collisions: z.array(z.object({ term: z.string(), path: z.string(), line: z.number().int() })),
})
export type FactFinding = z.infer<typeof factFindingSchema>

/** The same shape as JSON Schema, for the fact-finder subagent's `outputSchema`. */
export const FACT_FINDING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    searched: { type: 'array', items: { type: 'string' }, description: 'Every domain concept searched, including those that found nothing.' },
    facts: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } }, required: ['path', 'line'] } },
    collisions: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, path: { type: 'string' }, line: { type: 'integer' } }, required: ['term', 'path', 'line'] } },
  },
  required: ['searched', 'facts', 'collisions'],
} as const
