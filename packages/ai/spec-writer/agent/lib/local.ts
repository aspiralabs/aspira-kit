import { createHash } from 'node:crypto'
import { sessionResearchTools } from '@aspiralabs/ai/common/lib/research-rule'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { openDecisions } from '@aspiralabs/ai/common/lib/decisions'
import type { SessionModel } from '@aspiralabs/ai/common/lib/session-model'
import { taskModel, type Effort } from '@aspiralabs/ai/common/lib/model-config'
import type { Call } from '@aspiralabs/ai/spec-reviewer/lib/pipeline'
import { lenses, reviewSchema, synthesisSchema, systemPrompt as reviewSystemPrompt } from '@aspiralabs/ai/spec-reviewer/lib/review'
import { writeArtifacts } from './artifacts.ts'
import { knowledgeConfig, knowledgeSource, loadKnowledge, snapshotKnowledge, type Env, type Knowledge } from './local-knowledge.ts'
import { EXPLORE_MAX_STEPS, applySnapshotGaps, prepareWrite, reportDirFor, specSha256, summary, writeContext, writeFiles, type RunInput } from './runner.ts'
import { mapBriefForRun, type MapStatus } from '@aspiralabs/ai/common/lib/codebase-map-run'
import { draftSchema, exploreSchema, writePipeline, writerSystemPrompt } from './writer.ts'

// --local: the same pipeline with the Claude Code session as the model, as in spec-reviewer. Each
// invocation replays writePipeline from the start. A phase whose output file exists and validates is
// fed back in; a missing one gets its exact agent prompt written to disk and the replay stops at that
// stage. The session runs the pending phases as subagents and invokes this again. Validation, finding
// IDs, edit application, contract checks and artifacts stay code, identical to the agent.
//
// Nothing here restates the agent's rules. The System and Task sections of every prompt file are the
// writer.ts and spec-reviewer prompts as this process loaded them; the notes only say how this
// environment differs from the agent's (tools, files, output contract).

/** One --local step: a load-knowledge snapshot (`guidelinesPath`) or, when omitted, the knowledge folder the run fetches itself. */
export type LocalInput = Omit<RunInput, 'guidelinesPath'> & { guidelinesPath?: string; finish?: boolean }

/** Seams for tests: the agent package whose files and env are read, and the knowledge walk's own fetch/API base (never set outside tests). */
export type LocalDeps = { agentDir?: string; env?: Env; fetch?: (url: string, init?: RequestInit) => Promise<Response>; api?: string }

/** A phase for the session to run: prompt and output are file paths; `model` the session model it runs on (KIT-48). */
export type LocalTask = { phase: string; prompt: string; output: string; model: SessionModel; effort?: Effort; error?: string }

/** Explorers on Haiku (they find and quote), specialists on Sonnet, the draft, research and reconciliation on Opus (KIT-48). */
export const modelForPhase = (phase: string): SessionModel => (phase === 'explore' || phase.startsWith('explore:') ? 'haiku' : phase in lenses ? 'sonnet' : 'opus')
/**
 * The phase's model and effort: aspira.json `models` spec-writer.<family>, where the family is explore,
 * draft, research, specialists (every review lens) or reconciliation; else modelForPhase.
 */
export const taskModelForPhase = (phase: string, repo: string): { model: SessionModel; effort?: Effort } =>
  taskModel(`spec-writer.${phase in lenses ? 'specialists' : phase.split(':')[0]!}`, modelForPhase(phase), repo)

type LocalCall = { phase: string; prompt: string; output?: unknown; error?: string }

const STAGES = ['explore', 'draft', 'research', 'specialists', 'reconciliation'] as const
const STAGE_OF: Record<string, number> = { explore: 0, draft: 1, research: 2, synthesis: 4 }
const stageOf = (phase: string) => (phase.startsWith('explore:') ? 0 : (STAGE_OF[phase] ?? 3))
const PHASE_ORDER = ['explore', 'draft', 'research', ...Object.keys(lenses), 'synthesis']
const orderOf = (phase: string) => (phase.startsWith('explore:') ? 0 : PHASE_ORDER.indexOf(phase))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
// spec-reviewer's reviewModelCall gives each specialist this many tool rounds.
const SPECIALIST_STEPS = 6

/** This package: its agent/ holds the instructions and the prompt modules. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The work directory beside an output directory. */
export const workDirFor = (reportDir: string) => `${reportDir}.local`

/** The agent's routing instructions: what the session, standing in for the agent's router, reads in full. */
export const orchestratorFile = (agentDir: string = PACKAGE_DIR) => join(agentDir, 'agent', 'instructions.md')

/** Where the run loads the Notion pages when no --guidelines snapshot is given. */
export const knowledgeDirFor = (reportDir: string) => join(workDirFor(reportDir), 'knowledge')

const schemaFor = (phase: string): z.ZodType => {
  if (phase === 'explore' || phase.startsWith('explore:')) return exploreSchema
  if (phase === 'draft') return draftSchema
  if (phase === 'synthesis') return synthesisSchema
  return reviewSchema
}
const systemFor = (phase: string) => (phase === 'explore' || phase.startsWith('explore:') || phase === 'draft' ? writerSystemPrompt : reviewSystemPrompt)

const readOnly = (repo: string) => `${sessionResearchTools(repo)} An external source you could not open stays a gap.`
const uiCatalog = 'The agent preloads the Aspira UI catalog (list_components) for UI work; here, call list_components and get_component through the aspiralabs-ui MCP and record each read in uiEvidence. If that MCP is not available in this session, record it as a gap.'
// Draft, research and reconciliation start from the packet (KIT-48) but are not walled in by it
// (KIT-53, David: no phase is packet-only for reads). The exploration, the source packet and the
// review record in the task are the head start; a fact they lack is read, not left as a gap.
const headStart = (repo: string) => `The material in the task is your evidence and your head start, not a wall: work from it first and do not re-explore the whole repository; when it lacks a fact you need, read it instead of raising a gap. ${sessionResearchTools(repo)} The session records your tool calls.`
const phaseNotes: Record<string, (repo: string) => string> = {
  explore: (repo) => `${readOnly(repo)} The agent gives this phase ${EXPLORE_MAX_STEPS} tool rounds; be as efficient: batch reads and searches. ${uiCatalog}`,
  draft: (repo) => `This phase works over the idea and the exploration in the task. ${headStart(repo)}`,
  research: (repo) => `This phase works over the source packet in the task. ${headStart(repo)} Do not start the specialists' work.`,
  synthesis: (repo) => `This phase works over the review record in the task. ${headStart(repo)}`,
  ui: (repo) => `${readOnly(repo)} The agent makes get_component this phase's first tool call. ${uiCatalog}`,
}
const specialistNote = (repo: string) => `${readOnly(repo)} The agent gives this phase ${SPECIALIST_STEPS} tool rounds; be as efficient: batch reads and searches.`
const noteFor = (phase: string): ((repo: string) => string) => (phase.startsWith('explore:') ? phaseNotes.explore! : (phaseNotes[phase] ?? specialistNote))

/** Tool phases with a --guidelines snapshot read the topic pages from the folder load-knowledge wrote it in, never from Notion (F49). */
export const snapshotNote = (file: string) => `Engineering guidelines: the REQUIRED GUIDELINES in the task are ${file}, a load-knowledge snapshot. The topic pages they route to are the files beside it in ${dirname(file)}, indexed by ${join(dirname(file), 'INDEX.md')}; they stand in for the agent's read-only guideline tools (list_guidelines, read_guideline). Open the pages that apply with Read; record a page that is not there as a gap. Do not edit them.`

/** Tool phases with a knowledge folder read the topic pages from it: the files stand in for the agent's read-only guideline tools. */
export const folderNote = (dir: string) => `Engineering guidelines: the REQUIRED GUIDELINES in the task are ${join(dir, 'REQUIRED.md')}. The topic pages they route to are files in ${dir}, indexed by ${join(dir, 'INDEX.md')}, one file per page; they stand in for the agent's read-only guideline tools (list_guidelines, read_guideline). Open the pages that apply with Read. Do not edit them.`

/** The file a phase subagent reads: the agent's system prompt and task prompt verbatim, then the output contract. */
export function renderPhasePrompt(phase: string, prompt: string, output: string, repo: string, knowledge?: Pick<Knowledge, 'source' | 'path'>, mode: 'write' | 'review' = 'write'): string {
  const role = mode === 'review' ? 'the spec review of the answered spec (the one spec step, rerun from In Review: Spec)' : stageOf(phase) < 2 ? 'the spec writer' : 'the spec review that the spec writer runs on its draft'
  const guidelines = knowledge?.source === 'snapshot' ? snapshotNote(knowledge.path) : folderNote(knowledge?.path ?? 'the knowledge folder')
  return [
    `# Aspira spec writer: ${phase} (--local)`, '',
    `You are the \`${phase}\` phase of ${role}, running as a subagent of a Claude Code session instead of inside spec-writer. The System and Task sections below are the exact prompt the agent sends. Follow them.`, '',
    '- Do not edit, create or delete any file in the repository or in Notion. The only file you write is your output file.',
    `- ${noteFor(phase)(repo)}`,
    ...(['draft', 'research', 'synthesis'].includes(phase) ? [] : [`- ${guidelines}`]),
    `- Finish by writing ONE JSON object to \`${output}\` that validates against the output schema at the end. No markdown fences and no prose in that file. Then reply with one line: \`done\`, or what stopped you.`, '',
    '## System', '', systemFor(phase), '',
    '## Task', '', prompt, '',
    '## Output schema', '', '```json', JSON.stringify(z.toJSONSchema(schemaFor(phase), { io: 'input' }), null, 2), '```', '',
  ].join('\n')
}

const stateSchema = z.object({
  fingerprint: z.string(),
  startedAt: z.string(),
  knowledge: z.object({ source: z.enum(['folder', 'snapshot']), path: z.string() }).optional(),
})
type State = z.infer<typeof stateSchema>

/** The rules this run uses: the snapshot it started with, a new --guidelines, or the knowledge folder. */
async function resolveKnowledge(input: LocalInput, saved: State | null, reportDir: string, deps: LocalDeps): Promise<Knowledge> {
  const given = input.guidelinesPath === undefined ? undefined : resolve(input.guidelinesPath)
  const started = saved?.knowledge
  if (given !== undefined && started !== undefined && started.path !== given) {
    throw new Error(`--guidelines ${given} differs from the ${started.source === 'snapshot' ? started.path : `knowledge folder ${started.path}`} this run started with. Drop it, or delete ${workDirFor(reportDir)} to start over.`)
  }
  const snapshot = given ?? (started?.source === 'snapshot' ? started.path : undefined)
  const env = deps.env ?? process.env
  const config = await knowledgeConfig(deps.agentDir ?? PACKAGE_DIR, env)
  if (snapshot !== undefined) return snapshotKnowledge(snapshot, config)
  const source = await knowledgeSource(input.repoPath, env)
  return loadKnowledge(knowledgeDirFor(reportDir), config, { ...source, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.api ? { api: deps.api } : {}) })
}

/** One step of a --local run: the next stage's tasks, or the exported report. Throws KnowledgeBlocked, before anything starts, when the guidelines cannot be loaded (F52). */
export async function runLocal(input: LocalInput, deps: LocalDeps = {}) {
  const orchestrator = orchestratorFile(deps.agentDir)
  const reportDir = reportDirFor(input)
  const work = workDirFor(reportDir)
  const stateFile = join(work, 'state.json')
  const saved = await readFile(stateFile, 'utf8').then((text) => stateSchema.parse(JSON.parse(text)), () => null)
  // No folder and nothing to fetch it with throws KnowledgeBlocked (pending false, status blocked):
  // a blocked run end that handleRunError reports, never a pending stage for the session (F52).
  const knowledge = await resolveKnowledge(input, saved, reportDir, deps)

  const prepared = await prepareWrite({ ...input, guidelinesPath: knowledge.requiredFile }, new AbortController().signal)
  const { dir, mode, idea, spec, guidelines, repo, uiRequired, answers } = prepared
  const repoRoot = resolve(input.repoPath)
  const context = writeContext(prepared, 'not preloaded in --local mode; the explore and ui phases read it through the aspiralabs-ui MCP in the session')
  // The run packet is rewritten before every step print (KIT-48), so it stays out of the fingerprint a resumed call checks.
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, idea, spec ?? null, guidelines, writeContext({ ...prepared, packet: '' }, ''), uiRequired, knowledge.digest])).digest('hex')
  if (saved && saved.fingerprint !== fingerprint) throw new Error(`The ${mode === 'review' ? 'spec' : 'idea'}, guidelines or repository changed since this local run started. Delete ${work} to start over.`)
  await mkdir(join(work, 'prompts'), { recursive: true })
  await mkdir(join(work, 'outputs'), { recursive: true })
  const state: State = saved ?? { fingerprint, startedAt: new Date().toISOString(), knowledge: { source: knowledge.source, path: knowledge.path } }
  if (!saved) await writeFile(stateFile, JSON.stringify(state, null, 2))

  const tasks: LocalTask[] = []
  const calls: LocalCall[] = []
  const call: Call = async ({ phase, prompt, attempt }) => {
    // A later stage's prompt depends on the earlier stage's outputs; never write it early.
    if (tasks.some((task) => stageOf(task.phase) < stageOf(phase))) throw new Error('waiting for an earlier phase')
    // A send-back (attempt 2) is its own task with its own files, so the refused output stays on disk.
    const file = `${phase.replaceAll('/', '_').replaceAll(':', '-')}${attempt === 2 ? '.sent-back' : ''}`
    const output = join(work, 'outputs', `${file}.json`)
    const raw = await readFile(output, 'utf8').catch(() => null)
    let error: string | undefined
    if (raw !== null) {
      try {
        const value = schemaFor(phase).parse(JSON.parse(raw))
        calls.push({ phase, prompt, output: value })
        return value
      } catch (cause) { error = message(cause).slice(0, 2000) }
    }
    if (input.finish) {
      const reason = error ? `invalid output: ${error}` : 'no output was produced in the session'
      calls.push({ phase, prompt, error: reason })
      throw new Error(reason)
    }
    const promptFile = join(work, 'prompts', `${file}.md`)
    await writeFile(promptFile, renderPhasePrompt(phase, prompt, output, repoRoot, knowledge, mode))
    tasks.push({ phase, prompt: promptFile, output, ...taskModelForPhase(phase, repoRoot), ...(error ? { error } : {}) })
    throw new Error('pending in the session')
  }

  // KIT-70: the codebase map brief is saved in the work folder by the helper, so a resumed call reuses it; it stays out of the fingerprint.
  const impactNote = 'The impact files above feed ## Blast radius.'
  let map: MapStatus | undefined
  if (mode === 'review') {
    map = await mapBriefForRun({ repo: repoRoot, workDir: work, text: spec ?? '', instruction: impactNote })
  }
  const mapBrief = mode === 'review' ? undefined : async (explored: unknown) => {
    map = await mapBriefForRun({ repo: repoRoot, workDir: work, text: JSON.stringify(explored), instruction: impactNote })
    return map.text
  }
  const result = await writePipeline({ idea, guidelines, context: map?.text ? `${context}\n\n${map.text}` : context, uiRequired, answers, areas: prepared.areas, ...(mapBrief ? { mapBrief } : {}), ...(spec === undefined ? {} : { spec }) }, call)
  if (tasks.length) {
    // Explore tasks share one order and are pushed as their prompt writes finish, so they tie-break by area (the areas are sorted).
    tasks.sort((a, b) => orderOf(a.phase) - orderOf(b.phase) || a.phase.localeCompare(b.phase))
    return { pending: true as const, status: 'pending', stage: STAGES[stageOf(tasks[0]!.phase)], workDir: work, orchestrator, tasks }
  }

  applySnapshotGaps(result, prepared)
  const mapReport = (map ?? await mapBriefForRun({ repo: repoRoot, workDir: work, targets: [] })).report
  const totalMs = Date.now() - Date.parse(state.startedAt)
  const phaseRows = result.phases.map((phase) => `| ${phase.phase} | ${phase.error ? `failed: ${phase.error.replaceAll('|', '/').slice(0, 200)}` : 'completed'} |`)
  const analysis = [
    '# Run analysis', '', `Status: **${result.status}**`, '',
    'Mode: **--local**. The model work ran as subagents of a Claude Code session, on that session\'s model and usage, so no cost or token counts are reported here.', '',
    `Wall time from the first local preparation (${state.startedAt}) to export: **${(totalMs / 1000).toFixed(1)}s**. It includes any time the session spent between stages.`, '',
    '| Phase | Result |', '| --- | --- |', ...phaseRows, '', mapReport, '',
  ].join('\n')
  // One sentence for a non-ready status: the open decision count and the decisions file for
  // needs-author, the first problem otherwise (F4, F18); reasonCode is always null here, the
  // spec writer has no sub-cases of its own.
  const openCount = openDecisions(result.authorDecisions).length
  const reason = result.status === 'ready' ? null
    : result.status === 'needs-author' ? `${openCount} decision${openCount === 1 ? '' : 's'} open: ${join(dir, 'trace', 'decisions.md')}`
      : (result.problems[0] ?? null)
  const reasonCode = null
  const files = writeFiles(result, prepared)
  // `mode: 'local'` is the run mode every trace reader expects; the write/review mode is `specMode`.
  const report = { ...result, review: result.review && { ...result.review, candidate: undefined }, spec: undefined, mode: 'local', specMode: result.mode, codebaseMap: mapReport, input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, specSha256: specSha256(files), models: { all: 'Claude Code session subagents' }, knowledge, startedAt: state.startedAt, totalMs, dir, reason, reasonCode }
  await writeArtifacts(dir, {
    ...files,
    'trace/calls.json': JSON.stringify({ mode: 'local', system: { writer: writerSystemPrompt, review: reviewSystemPrompt }, knowledge, calls }, null, 2),
    'run-analysis.md': analysis,
    'trace/review.json': JSON.stringify(report, null, 2),
  })
  // Every prompt and output is now in trace/calls.json; the rules used are in trace/review.json.
  await rm(work, { recursive: true, force: true })
  return { pending: false as const, orchestrator, ...summary(result, dir, { totalMs }), reason, reasonCode }
}

export { KnowledgeRequired } from './local-knowledge.ts'
