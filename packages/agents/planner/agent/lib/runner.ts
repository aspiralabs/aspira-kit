import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { generateText, Output, stepCountIs, tool, type ModelMessage, type ToolSet } from 'ai'
import { gateway } from '@aspiralabs/agent-common/lib/gateway'
import { writeArtifacts } from '@aspiralabs/agent-common/lib/artifacts'
import { connectReadTools } from '@aspiralabs/agent-common/lib/mcp'
import { modelTrace } from '@aspiralabs/agent-common/lib/model-trace'
import { repository } from '@aspiralabs/agent-common/lib/repository'
import { runAnalysis } from '@aspiralabs/agent-common/lib/run-analysis'
import { checkBusinessSpec } from '@aspiralabs/agent-common/lib/spec'
import { planSchema, researchSchema, renderPlan, touchesUi, validatePlan, type Plan, type Research } from './plan.ts'
import { system, researchSystem, researchInstructions, planningInstructions, repairInstructions } from './prompts.ts'

/** Research model turns, including the final forced `submit_research` turn. */
const RESEARCH_STEPS = 10

/** Correction passes planning gets when its plan fails the checks a model can fix. */
export const REPAIR_ROUNDS = 2

export type PlanInput = { specPath: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean }

/** The repository snapshot a plan is grounded in, as `repository` returns it. */
export type PlanRepository = Awaited<ReturnType<typeof repository>>

/** Inputs read and checked before any model work: the same for the agent and for --local. */
export type PreparedPlan = { dir: string; spec: string; specPath: string; guidelines: string; repo: PlanRepository; uiRequired: boolean }

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
  // The spec's path as commits cite it: repository-relative when the spec is inside the repository.
  const specFromRepo = relative(await realpath(input.repoPath), await realpath(input.specPath))
  const specPath = specFromRepo.startsWith('..') || isAbsolute(specFromRepo) ? resolve(input.specPath) : specFromRepo
  return { dir, spec, specPath, guidelines, repo, uiRequired }
}

/** The evidence block both model phases start from: spec, required guidelines, repository instructions and source packet. */
export function planContext(prepared: Pick<PreparedPlan, 'spec' | 'specPath' | 'guidelines' | 'repo'>): string {
  // A missing root instruction file is a fact the plan can state, not evidence it lacks.
  const root = ['AGENTS.md', 'CLAUDE.md'].filter((name) => prepared.repo.files.has(name))
  const rootNote = root.length ? '' : 'The repository has no AGENTS.md or CLAUDE.md at its root.\n'
  return `BUSINESS SPEC (${prepared.specPath}):\n${prepared.spec}\n\nREQUIRED GUIDELINES:\n${prepared.guidelines}\n\nREPOSITORY INSTRUCTIONS:\n${rootNote}${prepared.repo.instructions}\n\n${prepared.repo.packet(prepared.spec)}`
}

/** A guideline page research read in full: Notion through the read tool, or a knowledge file in --local. */
export type GuidelinePage = { source: string; markdown: string }

/** The full text of the guideline pages research read, so planning (which has no tools) sees them too. */
export function guidelinePagesSection(pages: GuidelinePage[]): string {
  return pages.length ? `\n\nGUIDELINE PAGES READ DURING RESEARCH (full text):\n${pages.map((page) => `SOURCE ${page.source}\n${page.markdown}`).join('\n\n')}` : ''
}

/** What research is told when it replies without submitting while turns remain. */
export function researchContinue(turnsLeft: number): string {
  return `You replied without calling submit_research, and you have ${turnsLeft} turns left. Research gathers evidence; it does not write the plan. Keep reading: open the files, guideline topic pages and kit configuration you have not read yet that the plan will depend on, batching reads. Then call submit_research.`
}

/** Why research's gaps were sent back: it still has turns, so it reads them instead. */
export function researchGapsRefusal(gaps: string[], turnsLeft: number, guidelineTools: string[]): string {
  const pages = guidelineTools.length ? ` Read guideline topic pages with ${guidelineTools.join(' and ')}.` : ''
  return `Not accepted: you have ${turnsLeft} turns left, so read these now instead of listing them as gaps.${pages} Kit configuration is under node_modules/@aspiralabs/config/ and readable with read_files. Then submit again, keeping as gaps only what you tried and failed to read:\n${gaps.map((gap) => `- ${gap}`).join('\n')}`
}

/** The research phase's user prompt. */
export function researchPrompt(context: string, instructions: string = researchInstructions): string {
  return `${context}\n\n${instructions}`
}

/** The planning phase's user prompt, over the submitted research. */
export function planningPrompt(context: string, research: Research, instructions: string = planningInstructions, pages: GuidelinePage[] = []): string {
  return `${context}\n\nRESEARCH:\n${JSON.stringify(research)}${guidelinePagesSection(pages)}\n\n${instructions}`
}

/** The planning prompt for a correction pass: the previous plan and the checks it failed. */
export function repairPrompt(context: string, research: Research, plan: Plan, issues: string[], instructions: string = repairInstructions, pages: GuidelinePage[] = []): string {
  return `${context}\n\nRESEARCH:\n${JSON.stringify(research)}${guidelinePagesSection(pages)}\n\nPREVIOUS PLAN:\n${JSON.stringify(plan)}\n\nPLAN CHECKS:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n\n${instructions}`
}

/** The rule IDs the required guidelines define. */
export function requiredRules(guidelines: string): string[] {
  return [...new Set([...guidelines.matchAll(/^(?:#{1,6}\s+|\*\*|[-*]\s+)?([A-Z]{2,10}-\d+)\b/gm)].map((match) => match[1]!))]
}

/** Required rule IDs no check names. A check may name several, as `REV-001/002`. */
export function uncoveredRules(guidelines: string, checks: { rule: string }[]): string[] {
  const covered = new Set(checks.flatMap((check) => [...check.rule.matchAll(/([A-Z]{2,10})-(\d+(?:\/\d+)*)/g)].flatMap((match) => match[2]!.split('/').map((n) => `${match[1]}-${n}`))))
  return requiredRules(guidelines).filter((rule) => !covered.has(rule))
}

/** The problems a correction pass can fix: structural plan errors and required rules no check covers. */
export function planIssues(args: { spec: string; guidelines: string; repo: Pick<PlanRepository, 'files' | 'tracked'>; research: Research | null; plan: Plan }): string[] {
  const checks = [...(args.research?.checks ?? []), ...args.plan.checks]
  return [...validatePlan(args.plan, args.spec, args.repo.files, args.repo.tracked), ...uncoveredRules(args.guidelines, checks).map((rule) => `Uncovered guideline: ${rule}`)]
}

/** The MCP tools, with every successful guideline-page read kept in `pages` (once per page) for planning. */
export function readingGuidelines(tools: ToolSet, pages: GuidelinePage[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (!/read_guideline$/.test(name) || !definition.execute) return [name, definition]
    const execute = definition.execute
    return [name, { ...definition, execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
      const output = await execute(input, options)
      const text = (output as { content?: { type?: string; text?: string }[]; isError?: boolean })
      const body = text.isError ? undefined : text.content?.find((part) => part.type === 'text')?.text
      try {
        const page = body === undefined ? undefined : JSON.parse(body) as { source?: string; markdown?: string }
        if (page?.source && page.markdown && !pages.some((known) => known.source === page.source)) pages.push({ source: page.source, markdown: page.markdown })
      } catch { /* not a page payload: nothing to keep */ }
      return output
    } }]
  }))
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
  // A spec that mentions a page or a card is not UI work; a plan that writes UI files is.
  if (missingUiReads(args.uiRequired && (plan === null || touchesUi(plan)), args.reads)) problems.push('UI planning requires successful list_components and get_component MCP reads')
  if (args.cancelled) problems.push('Planning cancelled')
  for (const rule of uncoveredRules(guidelines, [...(research?.checks ?? []), ...(plan?.checks ?? [])])) problems.push(`Uncovered guideline: ${rule}`)
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
  const pages: GuidelinePage[] = []
  try {
    options.progress?.('research')
    const prompt = researchPrompt(context)
    research = await trace.invoke({ phase: 'research', model: models.research, prompt }, async (signal, hooks) => {
      let submitted: Research | undefined
      // Until its last turn, research cannot submit checks that leave a required rule out: the
      // refusal names the missing rules and research continues. The last turn takes what it has.
      // A first submission that lists gaps while turns remain is refused once: research reads them
      // instead, and keeps only what it tried and failed to read.
      let lastTurn = false
      let turn = 0
      let gapsRefused = false
      const guidelineTools = Object.keys(mcp.tools).filter((name) => /guideline/i.test(name))
      const submit = async (value: Research) => {
        const missing = uncoveredRules(guidelines, value.checks)
        if (missing.length && !lastTurn) return { accepted: false, reason: `Checks must name every required rule ID. Add a check for each of these, with how it applies or evidence that it does not, then submit again: ${missing.join(', ')}` }
        const turnsLeft = RESEARCH_STEPS - turn - 1
        if (value.gaps.length && !gapsRefused && turnsLeft >= 2) {
          gapsRefused = true
          return { accepted: false, reason: researchGapsRefusal(value.gaps, turnsLeft, guidelineTools) }
        }
        submitted = value
        return { accepted: true }
      }
      const tools: ToolSet = { ...repo.tools, ...readingGuidelines(mcp.tools, pages), submit_research: tool({ description: 'Finish after gathering concrete repository and guideline evidence.', inputSchema: researchSchema, execute: submit }) }
      // Research that replies without submitting while turns remain is sent back to keep reading,
      // told how many turns it has left. Only its last turn is forced to submit what it has.
      let messages: ModelMessage[] = [{ role: 'user', content: prompt }]
      let used = 0
      while (!submitted && RESEARCH_STEPS - used > 1 && !signal.aborted) {
        const remaining = RESEARCH_STEPS - used
        const first = used === 0
        const result = await generateText({ model: gateway(models.research), system: researchSystem, ...(first ? { prompt } : { messages }), tools, abortSignal: signal, maxRetries: 0, maxOutputTokens: 7000, reasoning: 'low', stopWhen: [stepCountIs(remaining - 1), () => submitted !== undefined], prepareStep: ({ stepNumber }) => { turn = used + stepNumber; return first && stepNumber === 0 ? { activeTools: Object.keys(tools).filter((name) => name !== 'submit_research'), toolChoice: 'required' as const } : {} }, ...hooks })
        used += Math.max(1, result.steps?.length ?? 1)
        messages = [...messages, ...(result.responseMessages ?? [])]
        if (!submitted) messages.push({ role: 'user', content: researchContinue(RESEARCH_STEPS - used) })
      }
      lastTurn = true
      if (!submitted && !signal.aborted) await generateText({ model: gateway(models.research), system: researchSystem, messages: [...messages.slice(0, -1), { role: 'user', content: 'Your turns are used up. Submit the evidence you gathered with submit_research now. Cite only files and lines you actually read; list anything you did not read as a gap.' }], tools: { submit_research: tools.submit_research! }, toolChoice: { type: 'tool', toolName: 'submit_research' }, abortSignal: signal, maxRetries: 0, maxOutputTokens: 7000, reasoning: 'low', ...hooks })
      if (!submitted) throw new Error('Research did not submit evidence within its turn budget')
      return researchSchema.parse(submitted)
    })
    if (research && !options.signal?.aborted) {
      options.progress?.('planning')
      const prompt = planningPrompt(context, research, planningInstructions, pages)
      const draftPlan = (phase: string, prompt: string) => trace.invoke({ phase, model: models.planning, prompt }, async (signal, hooks) => {
        const result = await generateText({ model: gateway(models.planning), system, prompt, output: Output.object({ schema: planSchema }), abortSignal: signal, maxRetries: 0, maxOutputTokens: 24_000, reasoning: 'medium', ...hooks })
        return planSchema.parse(result.output)
      })
      plan = await draftPlan('planning', prompt)
      // Correction passes: hand the plan back with the checks it failed. Keep a revision only when
      // it fails fewer of them, and stop at the first one that does not improve.
      for (let round = 1; plan && round <= REPAIR_ROUNDS && !options.signal?.aborted; round++) {
        const issues = planIssues({ spec, guidelines, repo, research, plan })
        if (!issues.length) break
        options.progress?.(`repair-${round}`)
        const revised = await draftPlan(`repair-${round}`, repairPrompt(context, research, plan, issues, repairInstructions, pages))
        if (!revised || planIssues({ spec, guidelines, repo, research, plan: revised }).length >= issues.length) break
        plan = revised
      }
    }
    const { status, problems, decisions } = assessPlan({ spec, guidelines, repo, research, plan, phaseErrors: trace.phases, uiRequired, reads: mcp.reads, cancelled: options.signal?.aborted === true })
    const reviewMs = Date.now() - started - prepareMs
    const exportStarted = Date.now()
    const files: Record<string, string> = {
      ...planReportFiles({ prepared, specPath: input.specPath, research, plan, status, problems }),
      'trace/calls.json': JSON.stringify({ system: { research: researchSystem, planning: system }, models, calls: trace.calls }, null, 2),
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
