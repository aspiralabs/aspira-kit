import { createGateway, streamText } from 'ai'
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

/** One structured generation, streamed. A long structured answer sent as a single response is
 * silent until the model finishes, and the gateway dropped such a request ("Gateway request
 * failed") while planning HAN-15. Streaming keeps bytes flowing for as long as the model writes.
 * Resolves with the parsed output; rejects with the stream's own error when there is one. */
export async function streamStructured<OUTPUT>(options: Parameters<typeof streamText>[0]): Promise<OUTPUT> {
  let failure: unknown
  const result = streamText({ ...options, onError: ({ error }) => { failure ??= error } })
  try {
    const [output] = await Promise.all([result.output, result.consumeStream()])
    return output as OUTPUT
  } catch (error) {
    throw failure ?? error
  }
}
