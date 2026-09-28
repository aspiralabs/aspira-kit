import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { generateText, gateway, Output, hasToolCall, tool, stepCountIs, type ToolSet } from 'ai'
import { writeArtifacts } from './artifacts.ts'
import { runAnalysis, type UsageEntry } from './run-analysis.ts'
import { connectReadTools } from './mcp.ts'
import { runPipeline, type Call, type PipelineResult } from './pipeline.ts'
import { repository } from './repository.ts'
import { reviewSchema, synthesisSchema, systemPrompt } from './review.ts'

export type RunInput = { specPath: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean }

/** Inputs every review mode shares: the eve/CLI runner and the in-session --local replay. */
export async function prepareReview(input: RunInput, signal: AbortSignal) {
  const dir = resolve(input.outputDir ?? resolve(dirname(input.specPath), 'spec.reviewed'))
  for (const source of [input.specPath, input.guidelinesPath]) {
    const path = relative(dir, resolve(source))
    if (!path || (!path.startsWith('../') && path !== '..')) throw new Error('Output directory must not contain the source spec or guidelines')
  }
  const [spec, guidelines, repo] = await Promise.all([
    readFile(resolve(input.specPath), 'utf8'), readFile(resolve(input.guidelinesPath), 'utf8'), repository(input.repoPath, signal),
  ])
  if (!guidelines.trim()) throw new Error('Required guidelines snapshot is empty')
  if (/TRUNCATED by the Notion API/i.test(guidelines)) throw new Error('Required guidelines snapshot is truncated')
  const uiRequired = input.uiRequired ?? /\b(?:UI|screen|page|card|button|mobile|component|navigation)\b/i.test(spec)
  return { dir, spec, guidelines, repo, uiRequired }
}
export type Prepared = Awaited<ReturnType<typeof prepareReview>>

export const reviewContext = ({ repo, spec }: Prepared, catalog: string) =>
  `${repo.instructions}\n${repo.packet(spec)}\nAspira UI catalog (read in preparation): ${catalog}\nSnapshot gaps: ${repo.gaps.join('; ')}`

/** Repository snapshot gaps block readiness in every mode. */
export function applySnapshotGaps(result: PipelineResult, { repo }: Prepared) {
  if (repo.gaps.length) { result.problems.push(...repo.gaps); result.status = 'incomplete' }
}

/** The reviewed spec and the human-readable trace, identical across modes. */
export function reviewFiles(result: PipelineResult, { spec, guidelines }: Prepared): Record<string, string> {
  const decisions = result.synthesis?.dispositions.map((d) => `## ${d.findingId} — ${d.status}\n\n${d.reason}\n\nEvidence: ${d.evidence.join('; ')}\n\nEdits: ${d.editIds.join(', ') || 'none'}${d.duplicateOf ? `; duplicate of ${d.duplicateOf}` : ''}`).join('\n\n') ?? 'Reconciliation did not finish. All findings remain unresolved.'
  const files: Record<string, string> = {
    'spec.original.md': spec,
    'trace/guidelines.md': guidelines,
    'trace/decisions.md': `# Decisions\n\nStatus: ${result.status}\n\n${decisions}\n`,
    'trace/findings.md': result.findings.map((f) => `## ${f.id} — ${f.title}\n\n${f.evidence.join('\n\n')}\n\nProposed correction: ${f.fix}`).join('\n\n'),
    'trace/checks.md': `# Checks\n\nStatus: ${result.status}\n\n${result.problems.map((p) => `- ${p}`).join('\n')}\n\n${result.reviews.map((r) => `## ${r.phase}\n\n${r.output.checks.map((c) => `- ${c.rule}: ${c.evidence}`).join('\n')}`).join('\n\n')}`,
  }
  if (result.candidate !== null) files['spec.reviewed.md'] = result.status === 'ready' ? result.candidate
    : `> Review status: **${result.status}**. Not ready for implementation; resolve trace/decisions.md and trace/checks.md first. Original status metadata below has not been approved by this review.\n\n${result.candidate}`
  return files
}

export async function runReview(input: RunInput, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const preparation = options.signal ?? new AbortController().signal
  const prepared = await prepareReview(input, preparation)
  const { dir, spec, guidelines, repo, uiRequired } = prepared
  const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, preparation)
  const ledger: UsageEntry[] = []
  const tools = { ...repo.tools, ...mcp.tools }
  const catalogTool = Object.keys(mcp.tools).find((name) => name.endsWith('__list_components'))
  const componentTool = Object.keys(mcp.tools).find((name) => name.endsWith('__get_component'))
  let catalog: unknown = null
  try {
    if (uiRequired && catalogTool) catalog = await mcp.tools[catalogTool]!.execute!({}, { toolCallId: 'catalog-preflight', messages: [], context: {}, abortSignal: preparation })
  } catch (error) { await mcp.close(); throw error }
  const prepareMs = Date.now() - started
  const models = {
    frontier: process.env.SPEC_REVIEW_FRONTIER_MODEL || process.env.V3_FRONTIER_MODEL || 'anthropic/claude-opus-5.5',
    specialist: process.env.SPEC_REVIEW_SPECIALIST_MODEL || process.env.V3_SPECIALIST_MODEL || 'openai/gpt-6-sol',
    reconciliation: process.env.SPEC_REVIEW_RECONCILIATION_MODEL || process.env.V3_RECONCILIATION_MODEL || 'openai/gpt-6-sol',
  }
  const invokeModel: Call = async ({ phase, prompt, signal }) => {
    const structuredPhase = phase === 'research' || phase === 'synthesis'
    const model = phase === 'research' ? models.frontier : phase === 'synthesis' ? models.reconciliation : models.specialist
    const maxSteps = 6
    let current: UsageEntry | undefined
    const startStep = (step: { stepNumber: number; messages?: unknown }) => {
      current = { phase, model, turn: step.stepNumber + 1, startedMs: Date.now() - started, status: 'running', usage: {}, messages: step.messages }
      ledger.push(current)
    }
    const recordStep = (step: { usage: UsageEntry['usage']; providerMetadata?: unknown; finishReason: string; text: string; toolCalls: unknown; toolResults: unknown }) => {
      if (!current) return
      Object.assign(current, { durationMs: Date.now() - started - current.startedMs, status: 'completed', usage: step.usage, providerMetadata: step.providerMetadata, finishReason: step.finishReason, text: step.text, toolCalls: step.toolCalls, toolResults: step.toolResults })
    }
    // One native structured generation for research/reconciliation. Repository selection is code,
    // exploration is parallel specialists: no fragile forced-tool loop on this model.
    if (structuredPhase) {
      const common = { model: gateway(model), system: systemPrompt, prompt, abortSignal: signal, maxRetries: 0, reasoning: phase === 'synthesis' ? 'medium' as const : 'low' as const, maxOutputTokens: phase === 'synthesis' ? 20_000 : 8_000, onStepStart: startStep, onStepEnd: recordStep }
      if (phase === 'synthesis') return (await generateText({ ...common, output: Output.object({ schema: synthesisSchema }) })).output
      return (await generateText({ ...common, output: Output.object({ schema: reviewSchema }) })).output
    }
    let submitted: unknown
    const submitDescription = 'Finish with the structured result after gathering evidence. No prose final response.'
    const accept = async (value: unknown) => { submitted = value; return { accepted: true } }
    const phaseTools: ToolSet = { ...tools, submit_review: tool({ description: submitDescription, inputSchema: reviewSchema, execute: accept }) }
    const common = {
      model: gateway(model), system: systemPrompt, prompt: `${prompt}\nFinish by calling submit_review with your complete result.`, tools: phaseTools,
      abortSignal: signal, maxRetries: 0,
      maxOutputTokens: 5_000,
      reasoning: 'low' as const,
      stopWhen: [stepCountIs(maxSteps), hasToolCall('submit_review')],
      prepareStep: ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber >= maxSteps - 1) return { toolChoice: { type: 'tool' as const, toolName: 'submit_review' } }
        if (stepNumber === 0 && phase === 'ui' && componentTool) return { toolChoice: { type: 'tool' as const, toolName: componentTool } }
        if (stepNumber === 0) return { activeTools: Object.keys(tools), toolChoice: 'required' as const }
        return {}
      },
      onStepStart: startStep, onStepEnd: recordStep,
    }
    await generateText(common)
    if (submitted === undefined) throw new Error(`${phase} did not submit a structured result within its step budget`)
    return submitted
  }
  const calls: { phase: string; prompt: string; startedMs: number; durationMs?: number; output?: unknown; error?: string }[] = []
  const call: Call = async (request) => {
    const record: (typeof calls)[number] = { phase: request.phase, prompt: request.prompt, startedMs: Date.now() - started }
    calls.push(record)
    try {
      record.output = await invokeModel(request)
      return record.output
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      record.durationMs = Date.now() - started - record.startedMs
      for (const turn of ledger) if (turn.phase === request.phase && turn.status === 'running') {
        turn.status = 'failed'
        turn.durationMs = Date.now() - started - turn.startedMs
      }
    }
  }
  try {
    const result = await runPipeline({ spec, guidelines, context: reviewContext(prepared, JSON.stringify(catalog)), uiRequired }, call, options)
    if (uiRequired && !['list_components', 'get_component'].every((name) => mcp.reads.some((read) => read.ok && read.tool.endsWith(`__${name}`)))) {
      result.problems.push('UI review requires successful list_components and get_component MCP reads')
      result.status = 'incomplete'
    }
    applySnapshotGaps(result, prepared)
    const exportStarted = Date.now()
    // A transport may settle after the pipeline is cancelled; preserve the state at export.
    for (const turn of ledger) if (turn.status === 'running') {
      turn.status = 'failed'
      turn.durationMs = Date.now() - started - turn.startedMs
    }
    const files: Record<string, string> = {
      ...reviewFiles(result, prepared),
      'trace/calls.json': JSON.stringify({ system: systemPrompt, models, calls }, null, 2),
      'trace/usage.json': JSON.stringify({ scope: 'Direct review calls only; excludes eve router. Aborted calls may have unreported provider usage.', turns: ledger }, null, 2),
    }
    let totalMs = 0
    let reportedCostUsd = 0
    await writeArtifacts(dir, files, () => {
      totalMs = Date.now() - started
      const exportMs = Date.now() - exportStarted
      const analysis = runAnalysis(ledger, result.phases, { prepareMs, reviewMs: result.reviewMs, exportMs, totalMs, status: result.status })
      reportedCostUsd = analysis.reportedCostUsd
      const report = { ...result, candidate: undefined, input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, models, reportedCostUsd, mcp: mcp.sources, mcpReads: mcp.reads, prepareMs, exportMs, totalMs, dir }
      return { 'run-analysis.md': analysis.markdown, 'trace/review.json': JSON.stringify(report, null, 2) }
    })
    return { status: result.status, dir, findings: result.findings.length, problems: result.problems, authorDecisions: result.authorDecisions, prepareMs, reviewMs: result.reviewMs, reportedCostUsd, totalMs }
  } finally { await mcp.close() }
}
