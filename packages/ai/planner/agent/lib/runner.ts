import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from 'ai'
import { gateway, structuredWithTools } from '@aspiralabs/ai/common/lib/gateway'
import { writeArtifacts } from '@aspiralabs/ai/common/lib/artifacts'
import { openDecisions } from '@aspiralabs/ai/common/lib/decisions'
import { connectReadTools } from '@aspiralabs/ai/common/lib/mcp'
import { modelTrace } from '@aspiralabs/ai/common/lib/model-trace'
import { renderPlanBlock } from '@aspiralabs/ai/common/lib/plan-block'
import { repository, type ExploreArea } from '@aspiralabs/ai/common/lib/repository'
import { runAnalysis } from '@aspiralabs/ai/common/lib/run-analysis'
import { type RunStatus } from '@aspiralabs/ai/common/lib/run-status'
import { checkBusinessSpec } from '@aspiralabs/ai/common/lib/spec'
import { pageIdFrom } from '@aspiralabs/ai/common/lib/knowledge'
import type { Answer, DecisionRecord } from '@aspiralabs/ai/common/lib/decisions'
import { applyPlanPatch, mergeDecisions, planPatchSchema, planSchema, readAnswers, renderChecks, renderDecisionsFile, renderPlan, exploreSchema, researchSchema, touchesUi, validatePlan, type Exploration, type Plan, type Research, type Touch } from './plan.ts'
import { system, researchSystem, researchInstructions, planningInstructions, repairInstructions, exploreSystem, exploreInstructions } from './prompts.ts'
import { notionReadToolsFromEnv } from '@aspiralabs/ai/common/lib/notion-read'
import { CLOUD_RESEARCH_TOOLS, RESEARCH_RULE } from '@aspiralabs/ai/common/lib/research-rule'

/** The system prompts with the research rule (KIT-54): research and planning read before they report a gap. */
const researchSystemWithRule = `${researchSystem}\n\n${RESEARCH_RULE}`
const planningSystem = `${system}\n\n${RESEARCH_RULE}`
/** Tool rounds planning gets before it must submit the plan (KIT-54). */
export const PLANNING_MAX_STEPS = 8
/** Tool turns one cloud explorer gets for its area. */
export const EXPLORE_MAX_STEPS = 8
import { renderFactsBlock, researchSteps, reviewFacts } from './review-facts.ts'

/** Correction passes planning gets when its plan fails the checks a model can fix. */
export const REPAIR_ROUNDS = 2

export type PlanInput = { specPath: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean; takeRecommended?: boolean }

/** The repository snapshot a plan is grounded in, as `repository` returns it. */
export type PlanRepository = Awaited<ReturnType<typeof repository>>

/** Inputs read and checked before any model work: the same for the agent and for --local. */
export type PreparedPlan = { dir: string; spec: string; specPath: string; guidelines: string; repo: PlanRepository; uiRequired: boolean }

/** The ticket's working folder: the spec's own directory, or its parent when the spec came from spec.reviewed/ (the reviewer's own export). */
export function ticketFolderFor(specPath: string): string {
  const specDirectory = dirname(resolve(specPath))
  return basename(specDirectory) === 'spec.reviewed' ? dirname(specDirectory) : specDirectory
}

/** The export directory: an explicit one, else plan.review/ beside the spec (beside spec.reviewed/ for a reviewed spec). */
export function outputDirFor(input: Pick<PlanInput, 'specPath' | 'outputDir'>): string {
  return resolve(input.outputDir ?? resolve(ticketFolderFor(input.specPath), 'plan.review'))
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
export function planContext(prepared: Pick<PreparedPlan, 'spec' | 'specPath' | 'guidelines' | 'repo'>, source: 'packet' | 'index' = 'packet'): string {
  // A missing root instruction file is a fact the plan can state, not evidence it lacks.
  const root = ['AGENTS.md', 'CLAUDE.md'].filter((name) => prepared.repo.files.has(name))
  const rootNote = root.length ? '' : 'The repository has no AGENTS.md or CLAUDE.md at its root.\n'
  // Research reads the whole source packet; planning and repair get only its index, since research's
  // facts and touch list carry what they need from it (pasting it again made every planning turn heavier).
  const packet = source === 'index' && prepared.repo.packetIndex !== undefined ? prepared.repo.packetIndex(prepared.spec) : prepared.repo.packet(prepared.spec)
  return `BUSINESS SPEC (${prepared.specPath}):\n${prepared.spec}\n\nREQUIRED GUIDELINES:\n${prepared.guidelines}\n\nREPOSITORY INSTRUCTIONS:\n${rootNote}${prepared.repo.instructions}\n\n${packet}`
}

/** One explorer's prompt: the shared context and its area, with the packet files under it. */
export function explorePrompt(context: string, area: ExploreArea, instructions: string = exploreInstructions): string {
  return `${context}\n\nAREA: ${area.name}\nFiles of the source packet in this area:\n${area.files.map((file) => `- ${file}`).join('\n')}\n\n${instructions}`
}

/** The explorers' findings, for research's prompt: settled evidence it builds on rather than rereads. */
export function explorationsSection(explorations: readonly { area: string; result: Exploration }[]): string {
  if (!explorations.length) return ''
  return `\n\nEXPLORER FINDINGS (settled evidence for their areas; carry their touches into yours and read only what they leave open):\n${explorations.map(({ area, result }) => `AREA ${area}:\n${JSON.stringify(result)}`).join('\n\n')}`
}

/**
 * Research with the explorers' findings folded in: their facts first, then research's own, and one touch
 * per path (research's own entry wins, since it saw every area). Planning sees one research record.
 */
export function withExplorations(research: Research, explorations: readonly { result: Exploration }[]): Research {
  if (!explorations.length) return research
  const facts = [...new Set([...explorations.flatMap(({ result }) => result.facts), ...research.facts])]
  const touches = new Map<string, Touch>()
  for (const touch of explorations.flatMap(({ result }) => result.touches)) if (!touches.has(touch.path)) touches.set(touch.path, touch)
  for (const touch of research.touches ?? []) touches.set(touch.path, touch)
  return { ...research, facts, touches: [...touches.values()] }
}

/** A guideline page research read in full: Notion through the read tool, or a knowledge file in --local. */
export type GuidelinePage = { source: string; markdown: string }

/** The full text of the guideline pages research read, so planning sees them without re-reading them. */
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

/** The research phase's user prompt, with the spec reviewer's reusable facts (reviewFacts/renderFactsBlock) appended when there are any. */
export function researchPrompt(context: string, instructions: string = researchInstructions, factsBlock: string = '', explorations: string = ''): string {
  return `${context}${explorations}\n\n${instructions}${factsBlock}`
}

/**
 * The decisions research already raised, as a rule for planning (KIT-34): the same question under
 * other words is not raised again, and the plan builds the recommended option, so research and
 * planning never take opposite answers to one question.
 */
export function raisedDecisionsSection(research: Pick<Research, 'decisions'>): string {
  if (!research.decisions.length) return ''
  const lines = research.decisions.map((decision) => `- ${decision.question} (recommended: ${decision.recommended})`)
  return `\n\nDECISIONS RESEARCH ALREADY RAISED:\n${lines.join('\n')}\nDo not raise any of these again, under these or other words; plan the recommended option of each, and say so in the task that depends on it. Raise only a product question none of them covers.`
}

/** The planning phase's user prompt, over the submitted research. */
export function planningPrompt(context: string, research: Research, instructions: string = planningInstructions, pages: GuidelinePage[] = []): string {
  return `${context}\n\nRESEARCH:\n${JSON.stringify(research)}${guidelinePagesSection(pages)}${raisedDecisionsSection(research)}\n\n${instructions}`
}

/** The planning prompt for a correction pass: the previous plan and the checks it failed. */
export function repairPrompt(context: string, research: Research, plan: Plan, issues: string[], instructions: string = repairInstructions, pages: GuidelinePage[] = []): string {
  return `${context}\n\nRESEARCH:\n${JSON.stringify(research)}${guidelinePagesSection(pages)}${raisedDecisionsSection(research)}\n\nPREVIOUS PLAN:\n${JSON.stringify(plan)}\n\nPLAN CHECKS:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n\n${instructions}`
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

/** Notion page ids the required guidelines link to, in order of first appearance. */
export function linkedGuidelineIds(guidelines: string): string[] {
  const ids = [...guidelines.matchAll(/https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>")\]]+/g)].map((match) => pageIdFrom(match[0])).filter((id) => id !== undefined)
  return [...new Set(ids)]
}

/** Read each linked guideline page research did not, through the same read tool, so it lands in `pages`. */
export async function readLinkedGuidelines(tools: ToolSet, guidelines: string, pages: GuidelinePage[], signal: AbortSignal): Promise<void> {
  const reader = Object.entries(tools).find(([name]) => /read_guideline$/.test(name))?.[1]
  if (!reader?.execute) return
  const known = () => new Set(pages.map((page) => pageIdFrom(page.source)))
  for (const id of linkedGuidelineIds(guidelines)) {
    if (signal.aborted) return
    if (known().has(id)) continue
    // A page that cannot be read stays out; planning names what it lacks.
    await Promise.resolve(reader.execute({ page: id }, { toolCallId: `linked-${id}`, messages: [], context: {}, abortSignal: signal })).catch(() => undefined)
  }
}

/**
 * True when a UI plan lacks the successful catalog read it requires. A successful list_components
 * is the requirement; get_component reads are expected for the components the plan uses, but a
 * catalog with nothing in it (a project whose UI package has no docs yet) has nothing to get, so
 * they are never a condition the check can hold (KIT-35).
 */
export function missingUiReads(uiRequired: boolean, reads: { tool: string; ok: boolean }[]): boolean {
  return uiRequired && !reads.some((read) => read.ok && read.tool.endsWith('__list_components'))
}

/** ready: structural checks passed; needs-author: product decisions remain; incomplete: anything else. */
export type PlanStatus = 'ready' | 'needs-author' | 'incomplete'

/**
 * The plan's status and every reason it is not ready, in the order the agent reports them. Sets
 * plan.decisions to the merged decisions; `answers` are the author's ticks from the previous plan.
 * `takeRecommended` (threaded from the driver through to plan.ts's mergeDecisions) takes every
 * decision still open as the agent's recommended option; the status rule (needs-author only while a
 * decision is open) is unchanged, so a run with nothing left open is ready.
 */
export function assessPlan(args: { spec: string; guidelines: string; repo: Pick<PlanRepository, 'gaps' | 'files' | 'tracked'>; research: Research | null; plan: Plan | null; phaseErrors: { phase: string; error: string | null }[]; uiRequired: boolean; reads: { tool: string; ok: boolean }[]; cancelled: boolean; answers?: Answer[]; takeRecommended?: boolean }): { status: PlanStatus; problems: string[]; openGaps: string[]; decisions: DecisionRecord[] } {
  const { spec, guidelines, repo, research, plan } = args
  // Snapshot gaps (files not indexed for size) are notes in the evidence packet, never a problem (KIT-29).
  const problems: string[] = []
  for (const phase of args.phaseErrors) if (phase.error) problems.push(`${phase.phase}: ${phase.error}`)
  if (!research) problems.push('Research unavailable')
  if (!plan) problems.push('No structured plan produced')
  // A gap research still had after its turns is a note for the approver, never a problem (KIT-54): it names what it looked for and could not settle.
  const openGaps: string[] = (research?.gaps ?? []).map((gap) => `Research gap: ${gap}`)
  if (plan && openGaps.length) plan.notes = [...(plan.notes ?? []), ...openGaps.filter((note) => !(plan.notes ?? []).includes(note))]
  // A spec that mentions a page or a card is not UI work; a plan that writes UI files is.
  const catalogMissing = missingUiReads(args.uiRequired && (plan === null || touchesUi(plan)), args.reads)
  if (plan) {
    // A gap about the UI catalog (an empty listing, a failed get_component) is a note once the listing itself succeeded (KIT-37): there is nothing more to read.
    const catalogGap = (gap: string) => /list_components|get_component|ui catalog|component docs|aspiralabs-ui|@aspiralabs\/ui/i.test(gap)
    // Every plan gap is a note too (KIT-54): listed on the plan and in the summary for the approver; the UI catalog's own gap stays a problem only while the listing itself failed (KIT-37).
    const [notes, gaps] = catalogMissing ? [plan.gaps.filter((gap) => !catalogGap(gap)), plan.gaps.filter(catalogGap)] : [plan.gaps, []]
    if (notes.length) plan.notes = [...(plan.notes ?? []), ...notes.filter((note) => !(plan.notes ?? []).includes(note))]
    openGaps.push(...notes.map((gap) => `Plan gap: ${gap}`))
    problems.push(...validatePlan(plan, spec, repo.files, repo.tracked), ...gaps.map((gap) => `Plan gap: ${gap}`))
  }
  if (catalogMissing) problems.push('UI planning requires a successful list_components MCP read')
  if (args.cancelled) problems.push('Planning cancelled')
  for (const rule of uncoveredRules(guidelines, [...(research?.checks ?? []), ...(plan?.checks ?? [])])) problems.push(`Uncovered guideline: ${rule}`)
  const decisions = mergeDecisions([research?.decisions ?? [], plan?.decisions ?? []], args.answers ?? [], args.takeRecommended ?? false)
  if (plan) plan.decisions = decisions
  const status: PlanStatus = problems.length ? 'incomplete' : decisions.some((decision) => decision.decidedBy === 'open') ? 'needs-author' : 'ready'
  return { status, problems, openGaps, decisions }
}

/** `problems` with any occurrence of `repoPath` (absolute) made repository-relative: the Plan page's
 * block never carries a host's own filesystem layout (F36). */
function repositoryRelative(problems: readonly string[], repoPath: string): string[] {
  const root = `${resolve(repoPath).replace(/\/+$/, '')}/`
  return problems.map((problem) => problem.split(root).join(''))
}

/** The report files that do not depend on how the models were called. `repoPath` is the repository
 * root: used only to redact it out of `problems` before they reach the Plan page's block. */
export function planReportFiles(args: { prepared: PreparedPlan; specPath: string; repoPath: string; research: Research | null; plan: Plan | null; status: string; problems: string[]; decisions: DecisionRecord[] }): Record<string, string> {
  const { prepared, research, plan, status, problems, decisions } = args
  const files: Record<string, string> = {
    'trace/spec.original.md': prepared.spec, 'trace/guidelines.md': prepared.guidelines,
    'trace/research.json': JSON.stringify(research, null, 2), 'trace/plan.json': JSON.stringify(plan, null, 2),
    'trace/checks.md': renderChecks(status, problems),
    'trace/decisions.md': renderDecisionsFile(status, decisions),
  }
  if (plan) {
    const rendered = renderPlan(plan, status, { specPath: args.specPath, commit: prepared.repo.commit, dirty: prepared.repo.dirty }, problems, decisions)
    // The Plan page's block carries plan.json and the gate fields so a fresh pull can rebuild them
    // (F36): pageTextSha256 is unknown until the pushed page is read back once (ticket-flow.ts's
    // planner verify step fills it in with a second, final push).
    files['plan.reviewed.md'] = renderPlanBlock({
      pageMarkdown: rendered,
      plan,
      review: { status, decisions, repoCommit: prepared.repo.commit, problems: repositoryRelative(problems, args.repoPath) },
      pageTextSha256: null,
    })
  }
  return files
}

/** Run the planner: research, then planning, then validation and export to plan.review/. */
export async function runPlan(input: PlanInput, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const preparation = options.signal ?? new AbortController().signal
  const prepared = await preparePlan(input, preparation)
  const { dir, spec, guidelines, repo, uiRequired } = prepared
  // The previous plan's trace/decisions.md, with the options the author ticked, is read before the run replaces it.
  const answers = await readAnswers(dir)
  const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, preparation)
  const prepareMs = Date.now() - started
  const trace = modelTrace(started, options.signal)
  const models = { explore: process.env.SPEC_PLAN_EXPLORE_MODEL || 'anthropic/claude-sonnet-5', research: process.env.SPEC_PLAN_RESEARCH_MODEL || 'anthropic/claude-opus-5.5', planning: process.env.SPEC_PLAN_MODEL || 'openai/gpt-6.1-sol' }
  const context = planContext(prepared)
  // Planning and repair get the packet's index, not the packet: research's facts and touches carry it.
  const planningContext = planContext(prepared, 'index')
  let plan: Plan | null = null
  let research: Research | null = null
  const pages: GuidelinePage[] = []
  // The Notion read tools ride on the integration token (KIT-54): any page or database, not only the guideline topics.
  const readTools = { ...readingGuidelines(mcp.tools, pages), ...notionReadToolsFromEnv() }
  // The spec reviewer's own facts, reused when they still describe this spec and commit (F33-F35):
  // research then gets a smaller turn budget and the facts block in its prompt.
  const facts = await reviewFacts({ folder: ticketFolderFor(input.specPath), repoPath: input.repoPath, repo: { commit: repo.commit, dirty: repo.dirty } })
  const steps = researchSteps(facts.included)
  try {
    // Explorers read the spec's areas of the repository in parallel first, so research starts from their
    // findings instead of reading everything itself. One that fails leaves its area to research.
    const areas = repo.areas?.(spec) ?? []
    if (areas.length) options.progress?.('explore')
    const explorations = (await Promise.all(areas.map((area, index) => trace.invoke({ phase: `explore-${index + 1}`, model: models.explore, prompt: explorePrompt(context, area) }, async (signal, hooks) => {
      const output = await structuredWithTools({ model: gateway(models.explore), system: exploreSystem, prompt: `${explorePrompt(context, area)}\n\n${CLOUD_RESEARCH_TOOLS}`, schema: exploreSchema, tools: repo.tools, maxSteps: EXPLORE_MAX_STEPS, maxOutputTokens: 12_000, reasoning: 'low', submitName: 'submit_exploration', abortSignal: signal, ...hooks })
      return { area: area.name, result: exploreSchema.parse(output) }
    })))).filter((exploration) => exploration !== null)
    options.progress?.('research')
    const prompt = researchPrompt(context, researchInstructions, renderFactsBlock(facts), explorationsSection(explorations))
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
        const turnsLeft = steps - turn - 1
        if (value.gaps.length && !gapsRefused && turnsLeft >= 2) {
          gapsRefused = true
          return { accepted: false, reason: researchGapsRefusal(value.gaps, turnsLeft, guidelineTools) }
        }
        submitted = value
        return { accepted: true }
      }
      const tools: ToolSet = { ...repo.tools, ...readTools, submit_research: tool({ description: 'Finish after gathering concrete repository and guideline evidence.', inputSchema: researchSchema, execute: submit }) }
      // Research that replies without submitting while turns remain is sent back to keep reading,
      // told how many turns it has left. Only its last turn is forced to submit what it has.
      let messages: ModelMessage[] = [{ role: 'user', content: prompt }]
      let used = 0
      while (!submitted && steps - used > 1 && !signal.aborted) {
        const remaining = steps - used
        const first = used === 0
        const result = await generateText({ model: gateway(models.research), system: researchSystemWithRule, ...(first ? { prompt } : { messages }), tools, abortSignal: signal, maxRetries: 0, maxOutputTokens: 7000, reasoning: 'low', stopWhen: [stepCountIs(remaining - 1), () => submitted !== undefined], prepareStep: ({ stepNumber }) => { turn = used + stepNumber; return first && stepNumber === 0 ? { activeTools: Object.keys(tools).filter((name) => name !== 'submit_research'), toolChoice: 'required' as const } : {} }, ...hooks })
        used += Math.max(1, result.steps?.length ?? 1)
        messages = [...messages, ...(result.responseMessages ?? [])]
        if (!submitted) messages.push({ role: 'user', content: researchContinue(steps - used) })
      }
      lastTurn = true
      if (!submitted && !signal.aborted) await generateText({ model: gateway(models.research), system: researchSystemWithRule, messages: [...messages.slice(0, -1), { role: 'user', content: 'Your turns are used up. Submit the evidence you gathered with submit_research now. Cite only files and lines you actually read; list anything you did not read as a gap.' }], tools: { submit_research: tools.submit_research! }, toolChoice: { type: 'tool', toolName: 'submit_research' }, abortSignal: signal, maxRetries: 0, maxOutputTokens: 7000, reasoning: 'low', ...hooks })
      if (!submitted) throw new Error('Research did not submit evidence within its turn budget')
      return withExplorations(researchSchema.parse(submitted), explorations)
    })
    // Planning gets every page the required guidelines link to, not only the ones research
    // chose to open: the routing table names the pages that bind every code change.
    if (research && !options.signal?.aborted) await readLinkedGuidelines(readTools, guidelines, pages, preparation)
    if (research && !options.signal?.aborted) {
      options.progress?.('planning')
      const prompt = planningPrompt(planningContext, research, planningInstructions, pages)
      // Planning reads too (KIT-54): the repository, the guideline topics and Notion, for a fact research left out, then submits the plan.
      const planningTools: ToolSet = { ...repo.tools, ...readTools }
      const draftPlan = (phase: string, prompt: string) => trace.invoke({ phase, model: models.planning, prompt }, async (signal, hooks) => {
        const output = await structuredWithTools({ model: gateway(models.planning), system: planningSystem, prompt: `${prompt}\n\n${CLOUD_RESEARCH_TOOLS}`, schema: planSchema, tools: planningTools, maxSteps: PLANNING_MAX_STEPS, maxOutputTokens: 24_000, reasoning: 'medium', submitName: 'submit_plan', abortSignal: signal, ...hooks })
        return planSchema.parse(output)
      })
      plan = await draftPlan('planning', prompt)
      // Correction passes: hand the plan back with the checks it failed. Keep a revision only when
      // it fails fewer of them, and stop at the first one that does not improve.
      for (let round = 1; plan && round <= REPAIR_ROUNDS && !options.signal?.aborted; round++) {
        const issues = planIssues({ spec, guidelines, repo, research, plan })
        if (!issues.length) break
        options.progress?.(`repair-${round}`)
        const before = plan
        const fix = repairPrompt(planningContext, research, before, issues, repairInstructions, pages)
        // A correction pass submits only what it changes (planPatchSchema), merged into the plan here.
        const patch = await trace.invoke({ phase: `repair-${round}`, model: models.planning, prompt: fix }, async (signal, hooks) => {
          const output = await structuredWithTools({ model: gateway(models.planning), system: planningSystem, prompt: `${fix}\n\n${CLOUD_RESEARCH_TOOLS}`, schema: planPatchSchema, tools: planningTools, maxSteps: PLANNING_MAX_STEPS, maxOutputTokens: 24_000, reasoning: 'medium', submitName: 'submit_plan', abortSignal: signal, ...hooks })
          return applyPlanPatch(before, planPatchSchema.parse(output))
        })
        const revised = patch
        if (!revised || planIssues({ spec, guidelines, repo, research, plan: revised }).length >= issues.length) break
        plan = revised
      }
    }
    const { status, problems, openGaps, decisions } = assessPlan({ spec, guidelines, repo, research, plan, phaseErrors: trace.phases.filter((phase) => !phase.phase.startsWith('explore-')), uiRequired, reads: mcp.reads, cancelled: options.signal?.aborted === true, answers, takeRecommended: input.takeRecommended ?? false })
    const runStatus: RunStatus = status
    const reviewMs = Date.now() - started - prepareMs
    const exportStarted = Date.now()
    const files: Record<string, string> = {
      ...planReportFiles({ prepared, specPath: input.specPath, repoPath: input.repoPath, research, plan, status, problems, decisions }),
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
      // One sentence for a non-ready status: the open decision count and the decisions file for
      // needs-author, the first problem otherwise (F4, F18); reasonCode is always null here, the
      // planner has no sub-cases of its own.
      const openCount = openDecisions(decisions).length
      const reason = runStatus === 'ready' ? null
        : runStatus === 'needs-author' ? `${openCount} decision${openCount === 1 ? '' : 's'} open: ${join(dir, 'trace', 'decisions.md')}`
          : (problems[0] ?? null)
      const reasonCode = null
      return { 'run-analysis.md': analysis.markdown, 'trace/review.json': JSON.stringify({ status: runStatus, reason, reasonCode, problems, openGaps, decisions, input, repoCommit: repo.commit, repoDirty: repo.dirty, reviewFacts: { included: facts.included, reason: facts.reason }, models, phases: trace.phases, mcp: mcp.sources, mcpReads: mcp.reads, prepareMs, reviewMs, exportMs, totalMs, reportedCostUsd }, null, 2) }
    })
    return { status, dir, problems, openGaps, decisions, prepareMs, reviewMs, totalMs, reportedCostUsd }
  } finally { await mcp.close() }
}
