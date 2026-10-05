import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { generateText, gateway, hasToolCall, Output, stepCountIs, tool, type ToolSet } from 'ai'
import { writeArtifacts } from '@aspiralabs/agent-common/lib/artifacts'
import { connectReadTools } from '@aspiralabs/agent-common/lib/mcp'
import { modelTrace } from '@aspiralabs/agent-common/lib/model-trace'
import { repository } from '@aspiralabs/agent-common/lib/repository'
import { runAnalysis } from '@aspiralabs/agent-common/lib/run-analysis'
import { checkBusinessSpec } from '@aspiralabs/agent-common/lib/spec'
import { planSchema, researchSchema, renderPlan, validatePlan, type Plan, type Research } from './plan.ts'
import { system, researchInstructions, planningInstructions } from './prompts.ts'

/** Research model turns, including the final forced `submit_research` turn. */
const RESEARCH_STEPS = 10

export type PlanInput = { specPath: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean }

/** The repository snapshot a plan is grounded in, as `repository` returns it. */
export type PlanRepository = Awaited<ReturnType<typeof repository>>

/** Inputs read and checked before any model work: the same for the agent and for --local. */
export type PreparedPlan = { dir: string; spec: string; guidelines: string; repo: PlanRepository; uiRequired: boolean }

/** The export directory: an explicit one, else plan.review/ beside the spec (beside spec.reviewed/ for a reviewed spec). */
export function outputDirFor(input: Pick<PlanInput, 'specPath' | 'outputDir'>): string {
  const specDirectory = dirname(resolve(input.specPath))
  const featureDirectory = basename(specDirectory) === 'spec.reviewed' ? dirname(specDirectory) : specDirectory
  return resolve(input.outputDir ?? resolve(featureDirectory, 'plan.review'))
}

/** Refuse a spec the planner cannot plan from: not a business spec, or a review still awaiting resolution. */
export function assertPlannableSpec(spec: string): void {
  const invalidSpec = checkBusinessSpec(spec)
  if (invalidSpec.length) throw new Error(`Invalid business spec: ${invalidSpec.join('; ')}`)
  if (/Review status:\s*\*\*(?:incomplete|needs-author)\*\*/i.test(spec)) throw new Error('Resolve the spec review before planning implementation')
}

/** Resolve the output directory, read the spec, guidelines and repository, and refuse inputs the planner cannot plan from. */
export async function preparePlan(input: PlanInput, signal: AbortSignal): Promise<PreparedPlan> {
  const dir = outputDirFor(input)
  for (const source of [input.specPath, input.guidelinesPath]) {
    const path = relative(dir, resolve(source))
    if (!path || (!path.startsWith('../') && path !== '..')) throw new Error('Output directory must not contain the source spec or guidelines')
  }
  const [spec, guidelines, repo] = await Promise.all([readFile(resolve(input.specPath), 'utf8'), readFile(resolve(input.guidelinesPath), 'utf8'), repository(input.repoPath, signal)])
  assertPlannableSpec(spec)
  if (!guidelines.trim() || /TRUNCATED by the Notion API/i.test(guidelines)) throw new Error('A complete required-guidelines snapshot is required')
  const uiRequired = input.uiRequired ?? /\b(?:UI|screen|page|card|button|mobile|component|navigation)\b/i.test(spec)
  return { dir, spec, guidelines, repo, uiRequired }
}

/** The evidence block both model phases start from: spec, required guidelines, repository instructions and source packet. */
export function planContext(prepared: Pick<PreparedPlan, 'spec' | 'guidelines' | 'repo'>): string {
  return `BUSINESS SPEC:\n${prepared.spec}\n\nREQUIRED GUIDELINES:\n${prepared.guidelines}\n\nREPOSITORY INSTRUCTIONS:\n${prepared.repo.instructions}\n\n${prepared.repo.packet(prepared.spec)}`
}

/** The research phase's user prompt. */
export function researchPrompt(context: string, instructions: string = researchInstructions): string {
  return `${context}\n\n${instructions}`
}

/** The planning phase's user prompt, over the submitted research. */
export function planningPrompt(context: string, research: Research, instructions: string = planningInstructions): string {
  return `${context}\n\nRESEARCH:\n${JSON.stringify(research)}\n\n${instructions}`
}

/** True when a UI plan lacks the successful catalog and component-document reads it requires. */
export function missingUiReads(uiRequired: boolean, reads: { tool: string; ok: boolean }[]): boolean {
  return uiRequired && !['list_components', 'get_component'].every((name) => reads.some((read) => read.ok && read.tool.endsWith(`__${name}`)))
}

/** ready: structural checks passed; needs-author: product decisions remain; incomplete: anything else. */
export type PlanStatus = 'ready' | 'needs-author' | 'incomplete'

/** The plan's status and every reason it is not ready, in the order the agent reports them. Sets plan.decisions to the merged decisions. */
export function assessPlan(args: { spec: string; guidelines: string; repo: Pick<PlanRepository, 'gaps' | 'files' | 'tracked'>; research: Research | null; plan: Plan | null; phaseErrors: { phase: string; error: string | null }[]; uiRequired: boolean; reads: { tool: string; ok: boolean }[]; cancelled: boolean }): { status: PlanStatus; problems: string[]; decisions: string[] } {
  const { spec, guidelines, repo, research, plan } = args
  const problems = [...repo.gaps]
  for (const phase of args.phaseErrors) if (phase.error) problems.push(`${phase.phase}: ${phase.error}`)
  if (!research) problems.push('Research unavailable')
  if (!plan) problems.push('No structured plan produced')
  if (research?.gaps.length) problems.push(...research.gaps.map((gap) => `Research gap: ${gap}`))
  if (plan) { problems.push(...validatePlan(plan, spec, repo.files, repo.tracked), ...plan.gaps.map((gap) => `Plan gap: ${gap}`)) }
  if (missingUiReads(args.uiRequired, args.reads)) problems.push('UI planning requires successful list_components and get_component MCP reads')
  if (args.cancelled) problems.push('Planning cancelled')
  const requiredRules = [...new Set([...guidelines.matchAll(/^(?:#{1,6}\s+|\*\*|[-*]\s+)?([A-Z]{2,10}-\d+)\b/gm)].map((match) => match[1]!))]
  const checks = [...(research?.checks ?? []), ...(plan?.checks ?? [])]
  const covered = new Set(checks.flatMap((check) => [...check.rule.matchAll(/([A-Z]{2,10})-(\d+(?:\/\d+)*)/g)].flatMap((match) => match[2]!.split('/').map((n) => `${match[1]}-${n}`))))
  for (const rule of requiredRules) if (!covered.has(rule)) problems.push(`Uncovered guideline: ${rule}`)
  const decisions = [...new Set([...(research?.decisions ?? []), ...(plan?.decisions ?? [])])]
  if (plan) plan.decisions = decisions
  const status: PlanStatus = problems.length ? 'incomplete' : decisions.length ? 'needs-author' : 'ready'
  return { status, problems, decisions }
}

/** The report files that do not depend on how the models were called. */
export function planReportFiles(args: { prepared: PreparedPlan; specPath: string; research: Research | null; plan: Plan | null; status: string; problems: string[] }): Record<string, string> {
  const { prepared, research, plan, status, problems } = args
  const files: Record<string, string> = {
    'trace/spec.original.md': prepared.spec, 'trace/guidelines.md': prepared.guidelines,
    'trace/research.json': JSON.stringify(research, null, 2), 'trace/plan.json': JSON.stringify(plan, null, 2),
    'trace/checks.md': `# Planning checks\n\nStatus: ${status}\n\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`,
  }
  if (plan) files['plan.reviewed.md'] = renderPlan(plan, status, { specPath: args.specPath, commit: prepared.repo.commit, dirty: prepared.repo.dirty }, problems)
  return files
}

/** Run the planner: research, then planning, then validation and export to plan.review/. */
export async function runPlan(input: PlanInput, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const preparation = options.signal ?? new AbortController().signal
  const prepared = await preparePlan(input, preparation)
  const { dir, spec, guidelines, repo, uiRequired } = prepared
  const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, preparation)
  const prepareMs = Date.now() - started
  const trace = modelTrace(started, options.signal)
  const models = { research: process.env.SPEC_PLAN_RESEARCH_MODEL || 'anthropic/claude-opus-5.5', planning: process.env.SPEC_PLAN_MODEL || 'openai/gpt-6.1-sol' }
  const context = planContext(prepared)
  let plan: Plan | null = null
  let research: Research | null = null
  try {
    options.progress?.('research')
    const prompt = researchPrompt(context)
    research = await trace.invoke({ phase: 'research', model: models.research, prompt }, async (signal, hooks) => {
      let submitted: Research | undefined
      const tools: ToolSet = { ...repo.tools, ...mcp.tools, submit_research: tool({ description: 'Finish after gathering concrete repository and guideline evidence.', inputSchema: researchSchema, execute: async (value) => { submitted = value; return { accepted: true } } }) }
      const result = await generateText({ model: gateway(models.research), system, prompt, tools, abortSignal: signal, maxRetries: 0, maxOutputTokens: 7000, reasoning: 'low', stopWhen: [stepCountIs(RESEARCH_STEPS), hasToolCall('submit_research')], prepareStep: ({ stepNumber }) => stepNumber >= RESEARCH_STEPS - 1 ? { toolChoice: { type: 'tool' as const, toolName: 'submit_research' } } : stepNumber === 0 ? { activeTools: Object.keys(tools).filter((name) => name !== 'submit_research'), toolChoice: 'required' as const } : {}, ...hooks })
      // Research may stop early with prose. Its structured submission is the proof
      // that it finished, so give it one turn that can only submit what it found.
      if (!submitted) await generateText({ model: gateway(models.research), system, messages: [{ role: 'user', content: prompt }, ...(result?.responseMessages ?? []), { role: 'user', content: 'Submit the evidence you gathered with submit_research now. Cite only files and lines you actually read; list anything you did not read as a gap.' }], tools: { submit_research: tools.submit_research! }, toolChoice: { type: 'tool', toolName: 'submit_research' }, abortSignal: signal, maxRetries: 0, maxOutputTokens: 7000, reasoning: 'low', ...hooks })
      if (!submitted) throw new Error('Research did not submit evidence within its turn budget')
      return researchSchema.parse(submitted)
    })
    if (research && !options.signal?.aborted) {
      options.progress?.('planning')
      const prompt = planningPrompt(context, research)
      plan = await trace.invoke({ phase: 'planning', model: models.planning, prompt }, async (signal, hooks) => {
        const result = await generateText({ model: gateway(models.planning), system, prompt, output: Output.object({ schema: planSchema }), abortSignal: signal, maxRetries: 0, maxOutputTokens: 24_000, reasoning: 'medium', ...hooks })
        return planSchema.parse(result.output)
      })
    }
    const { status, problems, decisions } = assessPlan({ spec, guidelines, repo, research, plan, phaseErrors: trace.phases, uiRequired, reads: mcp.reads, cancelled: options.signal?.aborted === true })
    const reviewMs = Date.now() - started - prepareMs
    const exportStarted = Date.now()
    const files: Record<string, string> = {
      ...planReportFiles({ prepared, specPath: input.specPath, research, plan, status, problems }),
      'trace/calls.json': JSON.stringify({ system, models, calls: trace.calls }, null, 2),
      'trace/usage.json': JSON.stringify({ scope: 'Direct planner calls only; excludes eve routing and guideline loading before entry.', turns: trace.turns }, null, 2),
    }
    let totalMs = 0
    let reportedCostUsd = 0
    await writeArtifacts(dir, files, () => {
      totalMs = Date.now() - started
      const exportMs = Date.now() - exportStarted
      const analysis = runAnalysis(trace.turns, trace.phases, { prepareMs, reviewMs, exportMs, totalMs, status })
      reportedCostUsd = analysis.reportedCostUsd
      return { 'run-analysis.md': analysis.markdown, 'trace/review.json': JSON.stringify({ status, problems, decisions, input, repoCommit: repo.commit, repoDirty: repo.dirty, models, phases: trace.phases, mcp: mcp.sources, mcpReads: mcp.reads, prepareMs, reviewMs, exportMs, totalMs, reportedCostUsd }, null, 2) }
    })
    return { status, dir, problems, decisions, prepareMs, reviewMs, totalMs, reportedCostUsd }
  } finally { await mcp.close() }
}
