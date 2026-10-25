// --local: the planner's pipeline with a Claude Code session as the model. Each call makes no
// model call. It loads the knowledge first, itself, once per run (load-knowledge's shared walk):
// without the engineering rules nothing starts, and without a NOTION_TOKEN the run ends blocked. Then it
// replays the runner over the outputs already in the work directory: a phase whose output
// validates against the agent's schema is fed forward, and the first phase without one is
// returned as a task, its exact agent prompt written to a file. Prompts are assembled on every
// call from the agent's own files (agent/instructions.md and agent/lib/prompts.ts), so editing the
// agent changes them. Once both phases are done, the plan is assessed and exported by the same
// code the agent uses.

import { createHash } from 'node:crypto'
import { RESEARCH_RULE, sessionResearchTools } from '@aspiralabs/ai/common/lib/research-rule'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeArtifacts } from '@aspiralabs/ai/common/lib/artifacts'
import type { DecisionRecord } from '@aspiralabs/ai/common/lib/decisions'
import type { SessionModel } from '@aspiralabs/ai/common/lib/session-model'
import { taskModel, type Effort } from '@aspiralabs/ai/common/lib/model-config'
import { z } from 'zod'
import { fingerprintKnowledge, KnowledgeBlocked, knowledgeConfig, knowledgeFiles, knowledgeSource, loadKnowledge, REQUIRED_NAME, verifyGuidelines, type KnowledgeConfig, type KnowledgeFile } from './local-knowledge.ts'
import { applyPlanPatch, exploreSchema, planPatchSchema, planSchema, readAnswers, researchSchema, type Exploration, type Plan, type PlanPatch, type Research } from './plan.ts'
import { exploreInstructions, exploreSystem } from './prompts.ts'
import { assertPlannableSpec, assessPlan, explorationsSection, explorePrompt, withExplorations, type GuidelinePage, outputDirFor, planContext, planIssues, planningPrompt, planReportFiles, preparePlan, REPAIR_ROUNDS, repairPrompt, researchPrompt, ticketFolderFor, uncoveredRules, type PreparedPlan } from './runner.ts'
import { renderFactsBlock, reviewFacts, type ReviewFactsResult } from './review-facts.ts'

/** The model phases of a --local run, in order. */
export type Stage = 'explore' | 'research' | 'planning'

/** What one `local` call is asked to do. */
export type LocalInput = {
  specPath: string
  repoPath: string
  /** Export directory. Default: plan.review/ as the agent chooses it. */
  outputDir?: string
  /** A REQUIRED.md snapshot load-knowledge wrote, used instead of fetching the knowledge from Notion (F50). */
  guidelinesPath?: string
  /** Export what exists now, with the missing phases recorded. */
  finish?: boolean
  /** Take every open decision's recommended option as the agent's (F10). */
  takeRecommended?: boolean
  /** The run packet build-feature wrote (KIT-48), put in front of every phase's context. */
  packetPath?: string
}

/** Seams for tests: the agent's environment, the package the agent files are read from, and the knowledge walk's own fetch/API base (never set outside tests). */
export type LocalDeps = { env?: Record<string, string | undefined>; packageDir?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response>; api?: string }

/** The model phases: research, planning, then up to REPAIR_ROUNDS correction passes. */
export type PhaseId = `explore-${number}` | 'research' | 'planning' | `repair-${number}`

/** A task as printed for the session: the prompt and output are file paths; `model` the session model it runs on (KIT-48). */
export type LocalTask = { id: PhaseId; prompt: string; output: string; schema: string; model: SessionModel; effort?: Effort; reads?: string; error?: string; retry?: boolean }

/** Explorers on Haiku, research and planning on Opus, the correction passes on Sonnet (KIT-48). */
export const modelForPhase = (id: PhaseId): SessionModel => (id.startsWith('explore-') ? 'haiku' : id.startsWith('repair-') ? 'sonnet' : 'opus')

/** The phase's model and effort: aspira.json `models` planner.research, planner.planning or planner.repair, else modelForPhase. */
export const taskModelForPhase = (id: PhaseId, repo: string): { model: SessionModel; effort?: Effort } => taskModel(`planner.${id.startsWith('repair-') ? 'repair' : id.startsWith('explore-') ? 'explore' : id}`, modelForPhase(id), repo)

/** A stage for the session to run. */
export type LocalPending = { pending: true; status: 'pending'; stage: Stage; workDir: string; router: string; instructions: string; tasks: LocalTask[] }

/** The exported plan. */
export type LocalDone = { pending: false; status: 'ready' | 'needs-author' | 'incomplete'; dir: string; problems: string[]; openGaps?: string[]; decisions: DecisionRecord[]; totalMs: number }

/** The guidelines could not be loaded (no NOTION_TOKEN or KNOWLEDGE_PAGE): nothing ran and nothing was written to `dir` (F52). */
export type LocalBlocked = Omit<LocalDone, 'status'> & { status: 'blocked'; stage: 'knowledge'; reason: string }

/** Either the next stage, the exported plan, or a run blocked before it started. */
export type LocalResult = LocalPending | LocalDone | LocalBlocked

/** The work directory beside an export directory. */
export const workDirFor = (outputDir: string) => `${outputDir}.local`

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const promptsModule = z.object({ system: z.string().min(1), researchSystem: z.string().min(1), researchInstructions: z.string().min(1), planningInstructions: z.string().min(1), repairInstructions: z.string().min(1), exploreSystem: z.string().min(1).default(exploreSystem), exploreInstructions: z.string().min(1).default(exploreInstructions) })
/** The agent's prompt texts, loaded from its prompt module when the step runs. */
export type AgentPrompts = z.infer<typeof promptsModule>

/** Import agent/lib/prompts.ts from the package, so an edit to it reaches the next prompt file. */
export async function loadPrompts(packageDir: string): Promise<AgentPrompts> {
  const loaded: unknown = await import(pathToFileURL(join(packageDir, 'agent', 'lib', 'prompts.ts')).href)
  return promptsModule.parse(loaded)
}

const readsSchema = z.array(z.object({ tool: z.string().min(1), ok: z.boolean() }))

type KnowledgeRecord = { source: 'notion'; dir: string; config: KnowledgeConfig; fingerprint: string; files: KnowledgeFile[] } | { source: 'snapshot'; snapshot: string; fingerprint: string; files: KnowledgeFile[] }

const stateSchema = z.object({
  fingerprint: z.string(),
  knowledge: z.string(),
  startedAt: z.string(),
  rejections: z.record(z.string(), z.array(z.string())),
})
type State = z.infer<typeof stateSchema>

type Call = { phase: PhaseId; prompt: string; output?: unknown; error?: string }

/** The router file: the agent's instructions.md, verbatim, with how its tool calls map onto this driver. */
export function renderRouter(instructions: string, script: string): string {
  return [
    '# Aspira planner: router (--local)', '',
    'This Claude Code session stands in for the planner agent\'s router. The Instructions section is the agent\'s agent/instructions.md, read when this step ran. Follow it, with this mapping:', '',
    `- load-knowledge is what \`${script} local\` runs itself, once per run, before any stage: the knowledge folder is there when a task starts, or the run ends blocked naming what to set.`,
    `- create-plan is \`${script} local\` itself: run each stage's tasks as subagents and call it again until it prints \`"pending": false\`.`,
    '- MCP_READ_CONNECTIONS is the session\'s own read-only MCP servers.', '',
    '## Instructions', '', instructions.trim(), '',
  ].join('\n')
}

/** The file a subagent reads: the agent's system prompt and phase prompt verbatim, the tool mapping and the output contract. */
export function renderTaskPrompt(args: { id: PhaseId; system: string; prompt: string; output: string; reads: string | null; repo: string; knowledge: string[]; schema: z.ZodType }): string {
  const mechanics = args.id.startsWith('explore-')
    ? [
      `- ${RESEARCH_RULE} ${sessionResearchTools(args.repo)}`,
      `- Read the repository at ${args.repo} with Read, Grep, Glob and non-mutating git commands, read-only, and only inside your AREA. Batch reads and searches; other explorers run beside you.`,
    ]
    : args.id === 'research'
    ? [
      `- ${RESEARCH_RULE} ${sessionResearchTools(args.repo)}`,
      `- The agent's repository tools (list_files, read_files, search) are read-only reads of the repository at ${args.repo}: use Read, Grep, Glob and non-mutating git commands there. The agent gives research ten tool steps; be as efficient: batch reads and searches.`,
      `- The agent's guideline MCP topics are these files, fetched from Notion for this run: ${args.knowledge.join(', ') || 'none beyond the required guidelines in the Task'}. Read them with Read. A Notion page the spec or the ticket names (a product doc the work mirrors, a decision page) you may read with the Notion MCP read tools (notion-fetch, notion-search), read-only, citing its title and the quoted line (KIT-35); when the spec names a Notion page the work changes or mirrors, read it this way rather than leaving it as a gap; any other Notion page stays out.`,
      '- The agent\'s Aspira UI tools (list_components, get_component) are the session\'s aspiralabs-ui MCP server. If it is not available, record that as a gap.',
      `- submit_research is your output file. Also write \`${args.reads ?? ''}\`: a JSON array with one {"tool", "ok"} entry per MCP call you made, tool named as the session names it (for example mcp__aspiralabs-ui__get_component), ok false when it failed. Write [] if you made none.`,
    ]
    : [
      // KIT-34, KIT-54: the session's planning subagent reads, so a fact the packet lacks is checked rather than left as a plan gap.
      `- ${RESEARCH_RULE} ${sessionResearchTools(args.repo)}`,
      `- In this session you may use Read, Grep, Glob and non-mutating git commands, read-only, in the repository at ${args.repo}, to settle a fact the packet and research leave out (a path, a symbol, a signature, a caller) before you name it, and the Notion MCP read tools (notion-fetch, notion-search) for a Notion page the spec or the ticket names, citing its title and the quoted line; a plan gap is only for evidence you could not read. Plan from the spec, guidelines, packet and research in the Task.`,
      `- If your plan creates or changes a UI file (.tsx, .jsx, .css, .scss, or anything under components/), call the session's aspiralabs-ui MCP server first: list_components, then get_component for each component the change uses. Write \`${args.reads ?? ''}\`: a JSON array with one {"tool", "ok"} entry per MCP call you made, tool named as the session names it (for example mcp__aspiralabs-ui__get_component), ok false when it failed. Write [] if you made none.`,
    ]
  return [
    `# Aspira planner: ${args.id} (--local)`, '',
    `You are the \`${args.id}\` phase of the Aspira planner, running as a subagent of a Claude Code session instead of inside the planner agent. The System and Task sections below are the exact prompt the agent sends. Follow them.`, '',
    '- Do not edit, create or delete any file in the repository or in Notion. The only files you write are named below.',
    ...mechanics,
    `- Finish by writing ONE JSON object to \`${args.output}\` that validates against the output schema at the end. No markdown fences and no prose in that file. Then reply with one line: \`done\`, or what stopped you.`, '',
    '## System', '', args.system, '',
    '## Task', '', args.prompt, '',
    '## Output schema', '', '```json', JSON.stringify(z.toJSONSchema(args.schema, { io: 'input' }), null, 2), '```', '',
  ].join('\n')
}

/** One step of a --local plan: the next model phase's task, the exported plan, or a blocked run when the knowledge cannot be loaded. */
export async function runLocal(input: LocalInput, deps: LocalDeps = {}): Promise<LocalResult> {
  const env = deps.env ?? process.env
  const packageDir = deps.packageDir ?? PACKAGE_DIR
  const dir = outputDirFor(input)
  const work = workDirFor(dir)
  const knowledgeDir = join(work, 'knowledge')
  const script = 'planner.sh'

  // Refuse a spec the agent would refuse before fetching anything.
  assertPlannableSpec(await readFile(resolve(input.specPath), 'utf8'))
  await mkdir(join(work, 'prompts'), { recursive: true })
  const instructionsPath = join(packageDir, 'agent', 'instructions.md')
  const router = join(work, 'prompts', 'router.md')
  await writeFile(router, renderRouter(await readFile(instructionsPath, 'utf8'), script))
  const base = { pending: true as const, status: 'pending' as const, workDir: work, router, instructions: instructionsPath }

  // Knowledge first: the agent never plans without the engineering rules.
  let knowledge: KnowledgeRecord
  let guidelinesPath: string
  let topics: string[] = []
  if (input.guidelinesPath !== undefined) {
    guidelinesPath = resolve(input.guidelinesPath)
    await verifyGuidelines(guidelinesPath, knowledgeConfig(env))
    const print = await fingerprintKnowledge([guidelinesPath])
    knowledge = { source: 'snapshot', snapshot: guidelinesPath, fingerprint: print.fingerprint, files: print.files }
  } else {
    const config = knowledgeConfig(env)
    let state: Awaited<ReturnType<typeof loadKnowledge>>
    try {
      state = await loadKnowledge(knowledgeDir, config, { ...(await knowledgeSource(input.repoPath, env)), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.api ? { api: deps.api } : {}) })
    } catch (error) {
      if (error instanceof KnowledgeBlocked) return { pending: false, status: 'blocked', stage: 'knowledge', reason: error.message, dir, problems: [error.message], decisions: [], totalMs: 0 }
      throw error
    }
    guidelinesPath = join(knowledgeDir, REQUIRED_NAME)
    const print = await fingerprintKnowledge(await knowledgeFiles(knowledgeDir))
    knowledge = { source: 'notion', dir: knowledgeDir, config, fingerprint: print.fingerprint, files: print.files }
    topics = state.pages.filter((page) => page.role === 'topic' && page.present).map((page) => page.file)
  }

  const prepared = await preparePlan({ specPath: input.specPath, repoPath: input.repoPath, guidelinesPath, outputDir: dir }, new AbortController().signal)
  await withoutWorkDir(prepared, input.repoPath, work)
  const prompts = await loadPrompts(packageDir)
  // The run packet (KIT-48): what build-feature already gathered, in front of the spec and the source packet.
  const packet = input.packetPath === undefined ? '' : await readFile(resolve(input.packetPath), 'utf8')
  const context = `${packet ? `RUN PACKET (data):\n${packet}\n\n` : ''}${planContext(prepared)}`
  // The spec reviewer's own facts, reused in the session's research prompt when they still describe this spec and commit (F33-F35).
  const facts = await reviewFacts({ folder: ticketFolderFor(input.specPath), repoPath: input.repoPath, repo: { commit: prepared.repo.commit, dirty: prepared.repo.dirty } })
  // The run packet is rewritten before every step print (KIT-48), so the fingerprint a resumed call checks leaves it out.
  const fingerprint = createHash('sha256').update(JSON.stringify([prepared.spec, planContext(prepared), prepared.uiRequired])).digest('hex')

  await mkdir(join(work, 'outputs'), { recursive: true })
  const stateFile = join(work, 'state.json')
  const saved = await readFile(stateFile, 'utf8').then((text) => stateSchema.parse(JSON.parse(text)), () => null)
  if (saved !== null && saved.knowledge !== knowledge.fingerprint) throw new Error(`The knowledge changed since this local plan started (${knowledge.source === 'notion' ? knowledgeDir : knowledge.snapshot}). Restore it, or delete ${work} to start over.`)
  if (saved !== null && saved.fingerprint !== fingerprint) throw new Error(`The spec or repository changed since this local plan started. Delete ${work} to start over.`)
  const state: State = saved ?? { fingerprint, knowledge: knowledge.fingerprint, startedAt: new Date().toISOString(), rejections: {} }
  await writeFile(stateFile, JSON.stringify(state, null, 2))

  const calls: Call[] = []
  // check: what the agent refuses beyond the schema, such as research that leaves a required rule out.
  const resolvePhase = async <T>(id: PhaseId, prompt: string, schema: z.ZodType<T>, check: (value: T) => string | undefined = () => undefined): Promise<{ value?: T; task?: LocalTask }> => {
    const output = join(work, 'outputs', `${id}.json`)
    // Each phase records its own MCP reads (KIT-34): planning may make the UI catalog reads research did not.
    const readsFile = join(work, 'outputs', `${id}.reads.json`)
    const raw = await readFile(output, 'utf8').catch(() => null)
    let error: string | undefined
    if (raw !== null) {
      try {
        const parsed = schema.safeParse(JSON.parse(raw))
        if (parsed.success) error = check(parsed.data)
        if (parsed.success && error === undefined) {
          calls.push({ phase: id, prompt, output: parsed.data })
          return { value: parsed.data }
        }
        if (!parsed.success) error = z.prettifyError(parsed.error).slice(0, 2000)
      } catch (cause) { error = `The output is not valid JSON: ${message(cause)}` }
    }
    if (input.finish === true) {
      const reason = error === undefined ? 'no output was produced in the session' : `invalid output: ${error}`
      calls.push({ phase: id, prompt, error: reason })
      return {}
    }
    let retry: boolean | undefined
    if (error !== undefined) {
      // Set the rejected output aside, so the next call sees whether it was resent.
      const rejected = [...(state.rejections[id] ?? []), error]
      state.rejections[id] = rejected
      await rename(output, join(work, 'outputs', `${id}.rejected-${rejected.length}.json`))
      await writeFile(stateFile, JSON.stringify(state, null, 2))
      retry = rejected.length < 2
    }
    const promptFile = join(work, 'prompts', `${id}.md`)
    await writeFile(promptFile, renderTaskPrompt({ id, system: id === 'research' ? prompts.researchSystem : id.startsWith('explore-') ? prompts.exploreSystem : prompts.system, prompt, output, reads: readsFile, repo: resolve(input.repoPath), knowledge: topics, schema }))
    return { task: { id, prompt: promptFile, output, schema: id === 'research' ? 'researchSchema' : id.startsWith('explore-') ? 'exploreSchema' : id.startsWith('repair-') ? 'planPatchSchema' : 'planSchema', ...taskModelForPhase(id, resolve(input.repoPath)), ...(readsFile === null ? {} : { reads: readsFile }), ...(error === undefined ? {} : { error }), ...(retry === undefined ? {} : { retry }) } }
  }

  const coversRules = (value: Research) => {
    const missing = uncoveredRules(prepared.guidelines, value.checks)
    return missing.length ? `Checks must name every required rule ID. Add a check for each of these, with how it applies or evidence that it does not: ${missing.join(', ')}` : undefined
  }
  // Explorers read the spec's areas in parallel first (one task each, launched together); research then
  // starts from their findings. An area whose explorer has no output under --finish is left to research.
  const explorations: { area: string; result: Exploration }[] = []
  const exploring: LocalTask[] = []
  for (const [index, area] of (prepared.repo.areas?.(prepared.spec) ?? []).entries()) {
    const explored = await resolvePhase(`explore-${index + 1}`, explorePrompt(context, area, prompts.exploreInstructions), exploreSchema)
    if (explored.task !== undefined) exploring.push(explored.task)
    else if (explored.value !== undefined) explorations.push({ area: area.name, result: explored.value })
  }
  if (exploring.length) return { ...base, stage: 'explore', tasks: exploring }
  const researched = await resolvePhase('research', researchPrompt(context, prompts.researchInstructions, renderFactsBlock(facts), explorationsSection(explorations)), researchSchema, coversRules)
  if (researched.task !== undefined) return { ...base, stage: 'research', tasks: [researched.task] }
  const research: Research | null = researched.value === undefined ? null : withExplorations(researched.value, explorations)
  // Planning and repair get the packet's index instead of the packet: research's facts and touches carry it.
  const planningContext = `${packet ? `RUN PACKET (data):\n${packet}\n\n` : ''}${planContext(prepared, 'index')}`
  let plan: Plan | null = null
  if (research !== null) {
    // The agent hands planning the guideline pages research read; here research reads the
    // knowledge folder's topic pages, so planning gets all of them.
    const pages: GuidelinePage[] = await Promise.all(topics.map(async (file) => ({ source: file, markdown: await readFile(file, 'utf8') })))
    const planned = await resolvePhase('planning', planningPrompt(planningContext, research, prompts.planningInstructions, pages), planSchema)
    if (planned.task !== undefined) return { ...base, stage: 'planning', tasks: [planned.task] }
    plan = planned.value ?? null
    // The agent's correction passes: the same rounds, kept only while each one improves the plan.
    for (let round = 1; plan !== null && round <= REPAIR_ROUNDS; round++) {
      const issues = planIssues({ spec: prepared.spec, guidelines: prepared.guidelines, repo: prepared.repo, research, plan })
      if (!issues.length) break
      // A correction pass answers with a patch of only what it changes (planPatchSchema), merged into the plan here.
      const before: Plan = plan
      const repaired = await resolvePhase(`repair-${round}`, repairPrompt(planningContext, research, plan, issues, prompts.repairInstructions, pages), planPatchSchema, (patch) => mergeProblem(before, patch))
      if (repaired.task !== undefined) return { ...base, stage: 'planning', tasks: [repaired.task] }
      const merged = repaired.value === undefined ? undefined : applyPlanPatch(before, repaired.value)
      if (merged === undefined || planIssues({ spec: prepared.spec, guidelines: prepared.guidelines, repo: prepared.repo, research, plan: merged }).length >= issues.length) break
      plan = merged
    }
  }
  return exportPlan({ input, prepared, prompts, knowledge, state, calls, research, plan, work, facts })
}

/** Why a correction pass's patch cannot be merged into the plan (a task left with no changes, a broken reference), or undefined. */
function mergeProblem(plan: Plan, patch: PlanPatch): string | undefined {
  try {
    applyPlanPatch(plan, patch)
    return undefined
  } catch (error) {
    return `The patch does not merge into the previous plan: ${error instanceof z.ZodError ? z.prettifyError(error).slice(0, 2000) : message(error)}`
  }
}

/** The work directory is this run's scratch space, not repository evidence the agent would have seen. */
async function withoutWorkDir(prepared: PreparedPlan, repoPath: string, work: string): Promise<void> {
  const inside = relative(await realpath(repoPath), await realpath(work))
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return
  const prefix = `${inside}/`
  for (const path of [...prepared.repo.files.keys()]) if (path.startsWith(prefix)) prepared.repo.files.delete(path)
  for (const path of [...prepared.repo.tracked]) if (path.startsWith(prefix)) prepared.repo.tracked.delete(path)
}

async function exportPlan(args: { input: LocalInput; prepared: PreparedPlan; prompts: AgentPrompts; knowledge: KnowledgeRecord; state: State; calls: Call[]; research: Research | null; plan: Plan | null; work: string; facts: ReviewFactsResult }): Promise<LocalDone> {
  const { input, prepared, prompts, knowledge, state, calls, research, plan, work, facts } = args
  // The UI catalog check sees every phase's reads (KIT-34): research's, and planning's when it made them.
  const reads = (await Promise.all(['research', 'planning'].map(async (phase) => {
    const text = await readFile(join(work, 'outputs', `${phase}.reads.json`), 'utf8').catch(() => '[]')
    const parsed = readsSchema.safeParse(safeJson(text))
    return parsed.success ? parsed.data : []
  }))).flat()
  // An explorer that produced nothing only leaves its area to research: never a plan problem.
  const phaseErrors = calls.filter((call) => call.error !== undefined && !call.phase.startsWith('explore-')).map((call) => ({ phase: call.phase, error: call.error ?? null }))
  // The previous plan's trace/decisions.md, with the options the author ticked, is read before the export replaces it.
  const answers = await readAnswers(prepared.dir)
  const { status, problems, openGaps, decisions } = assessPlan({ spec: prepared.spec, guidelines: prepared.guidelines, repo: prepared.repo, research, plan, phaseErrors, uiRequired: prepared.uiRequired, reads, cancelled: false, answers, takeRecommended: input.takeRecommended ?? false })
  const totalMs = Date.now() - Date.parse(state.startedAt)
  const phaseRows = ([...calls.map((call) => call.phase).filter((phase) => phase.startsWith('explore-')), 'research', 'planning', ...calls.map((call) => call.phase).filter((phase) => phase.startsWith('repair-'))] as PhaseId[]).map((phase) => {
    const call = calls.find((item) => item.phase === phase)
    return `| ${phase} | ${call === undefined ? 'not run' : call.error === undefined ? 'completed' : `failed: ${call.error.replaceAll('|', '/').slice(0, 200)}`} |`
  })
  const analysis = [
    '# Run analysis', '', `Status: **${status}**`, '',
    'Mode: **--local**. The model work ran as subagents of a Claude Code session, on that session\'s model and usage, so no cost or token counts are reported here.', '',
    `Wall time from the first local model stage (${state.startedAt}) to export: **${(totalMs / 1000).toFixed(1)}s**. It includes any time the session spent between stages; knowledge loading before that is excluded.`, '',
    '| Phase | Result |', '| --- | --- |', ...phaseRows, '',
  ].join('\n')
  const knowledgeContents = knowledge.source === 'notion'
    ? (await fingerprintKnowledge(await knowledgeFiles(knowledge.dir))).contents
    : new Map([[REQUIRED_NAME, prepared.guidelines]])
  const files: Record<string, string> = {
    ...planReportFiles({ prepared, specPath: input.specPath, repoPath: input.repoPath, research, plan, status, problems, decisions }),
    'trace/calls.json': JSON.stringify({ mode: 'local', system: { research: prompts.researchSystem, planning: prompts.system }, models: { all: 'Claude Code session subagents' }, rejections: state.rejections, calls }, null, 2),
    'trace/usage.json': JSON.stringify({ scope: '--local run: model work ran in a Claude Code session; no usage is itemized.', turns: [] }, null, 2),
    'trace/knowledge.json': JSON.stringify({ ...knowledge, pages: knowledge.files.filter((file) => file.url !== null).map((file) => ({ file: file.name, title: file.title, url: file.url })).concat(knowledge.source === 'notion' ? requiredUrls(knowledgeContents.get(REQUIRED_NAME) ?? '') : []) }, null, 2),
    ...Object.fromEntries([...knowledgeContents].map(([name, text]) => [`trace/knowledge/${name}`, text])),
    'run-analysis.md': analysis,
    'trace/review.json': JSON.stringify({ mode: 'local', status, problems, openGaps, decisions, input, repoCommit: prepared.repo.commit, repoDirty: prepared.repo.dirty, reviewFacts: { included: facts.included, reason: facts.reason }, models: { all: 'Claude Code session subagents' }, phases: calls.map((call) => ({ phase: call.phase, error: call.error ?? null })), mcpReads: reads, knowledge: { source: knowledge.source, fingerprint: knowledge.fingerprint }, startedAt: state.startedAt, totalMs }, null, 2),
  }
  await writeArtifacts(prepared.dir, files)
  // Every prompt and output is now in trace/calls.json, and the knowledge in trace/knowledge/.
  await rm(work, { recursive: true, force: true })
  return { pending: false, status, dir: prepared.dir, problems, openGaps, decisions, totalMs }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

/** The required pages' own URLs, from REQUIRED.md's provenance comments. */
function requiredUrls(required: string): { file: string; title: string; url: string }[] {
  return [...required.matchAll(/^# (.+)\n+<!-- (\S+) -->/gm)].map((match) => ({ file: REQUIRED_NAME, title: match[1]!.trim(), url: match[2]! }))
}
