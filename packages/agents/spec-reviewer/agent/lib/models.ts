import { generateText, Output, hasToolCall, tool, stepCountIs, type ToolSet } from 'ai'
import { gateway } from '@aspiralabs/agent-common/lib/gateway'
import type { z } from 'zod'
import type { Call } from './pipeline.ts'
import { reviewSchema, synthesisSchema, systemPrompt } from './review.ts'
import type { UsageEntry } from './run-analysis.ts'

// Model calls for one run: the turn ledger behind run-analysis.md, the call records behind
// trace/calls.json, and the two call shapes every phase uses. Exported so the spec writer runs
// the review phases through exactly the same code as the reviewer.

export type CallRecord = { phase: string; prompt: string; startedMs: number; durationMs?: number; output?: unknown; error?: string }
type Reasoning = 'low' | 'medium' | 'high'
type StepStart = { stepNumber: number; messages?: unknown }
type StepEnd = { usage: UsageEntry['usage']; providerMetadata?: unknown; finishReason: string; text: string; toolCalls: unknown; toolResults: unknown }

export function modelSession(started: number) {
  const ledger: UsageEntry[] = []
  const calls: CallRecord[] = []
  function hooks(phase: string, model: string) {
    let current: UsageEntry | undefined
    return {
      onStepStart: (step: StepStart) => {
        current = { phase, model, turn: step.stepNumber + 1, startedMs: Date.now() - started, status: 'running', usage: {}, messages: step.messages }
        ledger.push(current)
      },
      onStepEnd: (step: StepEnd) => {
        if (!current) return
        Object.assign(current, { durationMs: Date.now() - started - current.startedMs, status: 'completed', usage: step.usage, providerMetadata: step.providerMetadata, finishReason: step.finishReason, text: step.text, toolCalls: step.toolCalls, toolResults: step.toolResults })
      },
    }
  }
  /** One native structured generation, no tools. */
  async function structured(options: { phase: string; model: string; system: string; prompt: string; schema: z.ZodType; signal: AbortSignal; reasoning: Reasoning; maxOutputTokens: number }): Promise<unknown> {
    const { phase, model, system, prompt, schema, signal, reasoning, maxOutputTokens } = options
    return (await generateText({ model: gateway(model), system, prompt, abortSignal: signal, maxRetries: 0, reasoning, maxOutputTokens, output: Output.object({ schema }), ...hooks(phase, model) })).output
  }
  /** Tool exploration that must end with a structured submit call within the step budget. */
  async function toolLoop(options: { phase: string; model: string; system: string; prompt: string; schema: z.ZodType; tools: ToolSet; signal: AbortSignal; maxSteps: number; maxOutputTokens: number; submitName: string; firstTool?: string }): Promise<unknown> {
    const { phase, model, system, prompt, schema, tools, signal, maxSteps, maxOutputTokens, submitName, firstTool } = options
    let submitted: unknown
    const accept = async (value: unknown) => { submitted = value; return { accepted: true } }
    const phaseTools: ToolSet = { ...tools, [submitName]: tool({ description: 'Finish with the structured result after gathering evidence. No prose final response.', inputSchema: schema, execute: accept }) }
    await generateText({
      model: gateway(model), system, prompt: `${prompt}\nFinish by calling ${submitName} with your complete result.`, tools: phaseTools,
      abortSignal: signal, maxRetries: 0,
      maxOutputTokens,
      reasoning: 'low',
      stopWhen: [stepCountIs(maxSteps), hasToolCall(submitName)],
      prepareStep: ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber >= maxSteps - 1) return { toolChoice: { type: 'tool' as const, toolName: submitName } }
        if (stepNumber === 0 && firstTool) return { toolChoice: { type: 'tool' as const, toolName: firstTool } }
        if (stepNumber === 0) return { activeTools: Object.keys(tools), toolChoice: 'required' as const }
        return {}
      },
      ...hooks(phase, model),
    })
    if (submitted === undefined) throw new Error(`${phase} did not submit a structured result within its step budget`)
    return submitted
  }
  /** Mark turns a transport never settled; a cancelled provider may never report them. */
  function settle(phase?: string) {
    for (const turn of ledger) if (turn.status === 'running' && (phase === undefined || turn.phase === phase)) {
      turn.status = 'failed'
      turn.durationMs = Date.now() - started - turn.startedMs
    }
  }
  /** Record every request with its prompt, output or error, and timing. */
  function record(invoke: Call): Call {
    return async (request) => {
      const entry: CallRecord = { phase: request.phase, prompt: request.prompt, startedMs: Date.now() - started }
      calls.push(entry)
      try {
        entry.output = await invoke(request)
        return entry.output
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        entry.durationMs = Date.now() - started - entry.startedMs
        settle(request.phase)
      }
    }
  }
  return { ledger, calls, structured, toolLoop, settle, record }
}
export type ModelSession = ReturnType<typeof modelSession>

export type ReviewModels = { frontier: string; specialist: string; reconciliation: string }
export function reviewModels(env: NodeJS.ProcessEnv = process.env): ReviewModels {
  return {
    frontier: env.SPEC_REVIEW_FRONTIER_MODEL || env.V3_FRONTIER_MODEL || 'anthropic/claude-opus-5.5',
    specialist: env.SPEC_REVIEW_SPECIALIST_MODEL || env.V3_SPECIALIST_MODEL || 'openai/gpt-6.1-sol',
    reconciliation: env.SPEC_REVIEW_RECONCILIATION_MODEL || env.V3_RECONCILIATION_MODEL || 'openai/gpt-6.1-sol',
  }
}

/** Tool rounds a specialist gets before it must submit. */
export const SPECIALIST_MAX_STEPS = 6

/** The review phases: structured research and reconciliation, tool-using specialists. */
export function reviewModelCall(session: ModelSession, models: ReviewModels, tools: ToolSet, componentTool?: string): Call {
  return async ({ phase, prompt, signal }) => {
    // One native structured generation for research/reconciliation. Repository selection is code,
    // exploration is parallel specialists: no fragile forced-tool loop on this model.
    if (phase === 'research') return session.structured({ phase, model: models.frontier, system: systemPrompt, prompt, schema: reviewSchema, signal, reasoning: 'low', maxOutputTokens: 8_000 })
    if (phase === 'synthesis') return session.structured({ phase, model: models.reconciliation, system: systemPrompt, prompt, schema: synthesisSchema, signal, reasoning: 'medium', maxOutputTokens: 20_000 })
    return session.toolLoop({ phase, model: models.specialist, system: systemPrompt, prompt, schema: reviewSchema, tools, signal, maxSteps: SPECIALIST_MAX_STEPS, maxOutputTokens: 5_000, submitName: 'submit_review', firstTool: phase === 'ui' ? componentTool : undefined })
  }
}
