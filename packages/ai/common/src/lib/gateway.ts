import { createGateway, generateText, hasToolCall, stepCountIs, streamText, tool, type ToolSet } from 'ai'
import type { z } from 'zod'
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

/**
 * A structured result reached through tools (KIT-54): the model may read (the repository, Notion,
 * any read tool it was given) for up to `maxSteps` rounds, then must call `submitName` with a value
 * valid against `schema`. The last step forces the submit. For a phase that used to be one
 * tool-less structured generation and now researches what its prompt lacks.
 */
export async function structuredWithTools<T>(options: {
  model: Parameters<typeof streamText>[0]['model']
  system: string
  prompt: string
  schema: z.ZodType<T>
  tools: ToolSet
  maxSteps: number
  maxOutputTokens: number
  reasoning?: 'low' | 'medium' | 'high'
  submitName: string
  abortSignal: AbortSignal
  // The planner's trace hooks: typed by their own step shapes, so accepted as the narrowest parameter type and cast once below.
  onStepStart?: (step: never) => void
  onStepEnd?: (step: never) => void
}): Promise<T> {
  const { model, system, prompt, schema, tools, maxSteps, maxOutputTokens, submitName, abortSignal } = options
  let submitted: T | undefined
  let seen = false
  const phaseTools: ToolSet = { ...tools, [submitName]: tool({ description: 'Finish with the structured result once what the prompt lacks has been read. No prose final response.', inputSchema: schema, execute: async (value: T) => { submitted = value; seen = true; return { accepted: true } } }) }
  await generateText({
    model, system, prompt: `${prompt}\n\nFinish by calling ${submitName} with your complete result.`, tools: phaseTools, abortSignal, maxRetries: 0, maxOutputTokens,
    reasoning: options.reasoning ?? 'medium',
    stopWhen: [stepCountIs(maxSteps), hasToolCall(submitName)],
    prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber >= maxSteps - 1 ? { toolChoice: { type: 'tool' as const, toolName: submitName } } : {}),
    // The trace hooks go through under their own names, as every other generateText call in the agents passes them.
    ...(options.onStepStart ? { onStepStart: options.onStepStart } : {}),
    ...(options.onStepEnd ? { onStepEnd: options.onStepEnd } : {}),
  } as Parameters<typeof generateText>[0])
  if (!seen || submitted === undefined) throw new Error(`${submitName} was not called within ${maxSteps} steps`)
  return submitted
}
