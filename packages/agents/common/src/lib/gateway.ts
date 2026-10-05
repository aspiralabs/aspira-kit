import { createGateway } from 'ai'
import { Agent, fetch as undiciFetch } from 'undici'

// Model calls are never cut off by the client. Node's built-in fetch gives up when response
// headers take longer than five minutes, which a large structured generation can: planning
// HAN-15 did, and lost the whole run. No headers or body time limit; cancellation stays with
// each call's abortSignal.
const unlimited = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

/** The AI Gateway provider every agent's direct model calls use, with no client-side time limit. */
export const gateway = createGateway({
  fetch: ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => undiciFetch(input, { ...init, dispatcher: unlimited })) as unknown as typeof globalThis.fetch,
})
