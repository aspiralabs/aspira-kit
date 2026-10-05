import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Call } from '@aspiralabs/spec-reviewer/lib/pipeline'
import { lenses, reviewSchema, synthesisSchema, systemPrompt as reviewSystemPrompt } from '@aspiralabs/spec-reviewer/lib/review'
import { writeArtifacts } from './artifacts.ts'
import { knowledgeConfig, loadKnowledge, snapshotKnowledge, type Env, type Knowledge, type KnowledgePlan, type KnowledgeRequired } from './local-knowledge.ts'
import { EXPLORE_MAX_STEPS, applySnapshotGaps, prepareWrite, reportDirFor, summary, writeContext, writeFiles, type RunInput } from './runner.ts'
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

/** One --local step: a snapshot (`guidelinesPath`) or, when omitted, the session-built knowledge folder. */
export type LocalInput = Omit<RunInput, 'guidelinesPath'> & { guidelinesPath?: string; finish?: boolean }

/** Seams for tests: the agent package whose files and env are read. */
export type LocalDeps = { agentDir?: string; env?: Env }

/** A phase for the session to run: prompt and output are file paths. */
export type LocalTask = { phase: string; prompt: string; output: string; error?: string }
type LocalCall = { phase: string; prompt: string; output?: unknown; error?: string }

const STAGES = ['explore', 'draft', 'research', 'specialists', 'reconciliation'] as const
const STAGE_OF: Record<string, number> = { explore: 0, draft: 1, research: 2, synthesis: 4 }
const stageOf = (phase: string) => STAGE_OF[phase] ?? 3
const PHASE_ORDER = ['explore', 'draft', 'research', ...Object.keys(lenses), 'synthesis']
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
// spec-reviewer's reviewModelCall gives each specialist this many tool rounds.
const SPECIALIST_STEPS = 6

/** This package: its agent/ holds the instructions and the prompt modules. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The work directory beside an output directory. */
export const workDirFor = (reportDir: string) => `${reportDir}.local`

/** The agent's routing instructions: what the session, standing in for the agent's router, reads in full. */
export const orchestratorFile = (agentDir: string = PACKAGE_DIR) => join(agentDir, 'agent', 'instructions.md')

/** Where the session puts the Notion pages when no --guidelines snapshot is given. */
export const knowledgeDirFor = (reportDir: string) => join(workDirFor(reportDir), 'knowledge')

/** The first stage of a run without guidelines: the pages to fetch, printed instead of starting. */
export function knowledgeStage(error: KnowledgeRequired, agentDir: string = PACKAGE_DIR): { pending: true; status: 'pending'; stage: 'knowledge'; orchestrator: string; knowledge: KnowledgePlan; message: string } {
  return { pending: true, status: 'pending', stage: 'knowledge', orchestrator: orchestratorFile(agentDir), knowledge: error.plan, message: error.message }
}

const schemaFor = (phase: string): z.ZodType => {
  if (phase === 'explore') return exploreSchema
  if (phase === 'draft') return draftSchema
  if (phase === 'synthesis') return synthesisSchema
  return reviewSchema
}
const systemFor = (phase: string) => (phase === 'explore' || phase === 'draft' ? writerSystemPrompt : reviewSystemPrompt)

const readOnly = (repo: string) => `Read-only tools only: Read, Grep, Glob and non-mutating git commands, in the repository at ${repo}.`
const uiCatalog = 'The agent preloads the Aspira UI catalog (list_components) for UI work; here, call list_components and get_component through the aspiralabs-ui MCP and record each read in uiEvidence. If that MCP is not available in this session, record it as a gap.'
const phaseNotes: Record<string, (repo: string) => string> = {
  explore: (repo) => `${readOnly(repo)} The agent gives this phase ${EXPLORE_MAX_STEPS} tool rounds; be as efficient: batch reads and searches. ${uiCatalog}`,
  draft: () => 'The agent runs this phase without tools, over the idea and exploration in the task.',
  research: () => 'The agent runs this phase without tools, over the source packet in the task. You may open a file to confirm a fact in the packet, but do not start the specialists\' work.',
  synthesis: () => 'The agent runs this phase without tools, over the review record in the task.',
  ui: (repo) => `${readOnly(repo)} The agent makes get_component this phase's first tool call. ${uiCatalog}`,
}
const specialistNote = (repo: string) => `${readOnly(repo)} The agent gives this phase ${SPECIALIST_STEPS} tool rounds; be as efficient: batch reads and searches.`

/** Tool phases with only a --guidelines snapshot read the topic pages it routes to through the Notion MCP, as the agent's Notion connection allows. */
export const notionNote = 'Engineering guidelines: the required snapshot in the task routes to topic pages (its "Which pages to read" table). Read the linked pages that apply with the Notion MCP (notion-fetch, read-only); they stand in for the agent\'s read-only guideline tools (list_guidelines, read_guideline). Never create, edit, move or comment on anything in Notion. If the Notion MCP is not available in this session, record each unread page as a gap.'

/** Tool phases with a knowledge folder read the topic pages from it: the files stand in for the agent's read-only guideline tools. */
export const folderNote = (dir: string) => `Engineering guidelines: the REQUIRED GUIDELINES in the task are ${join(dir, 'REQUIRED.md')}. The topic pages they route to are files in ${dir}, indexed by ${join(dir, 'INDEX.md')}, one file per page; they stand in for the agent's read-only guideline tools (list_guidelines, read_guideline). Open the pages that apply with Read. Do not edit them.`

/** The file a phase subagent reads: the agent's system prompt and task prompt verbatim, then the output contract. */
export function renderPhasePrompt(phase: string, prompt: string, output: string, repo: string, knowledge?: Pick<Knowledge, 'source' | 'path'>): string {
  const role = stageOf(phase) < 2 ? 'the spec writer' : 'the spec review that the spec writer runs on its draft'
  const guidelines = knowledge?.source === 'folder' ? folderNote(knowledge.path) : notionNote
  return [
    `# Aspira spec writer: ${phase} (--local)`, '',
    `You are the \`${phase}\` phase of ${role}, running as a subagent of a Claude Code session instead of inside spec-writer. The System and Task sections below are the exact prompt the agent sends. Follow them.`, '',
    '- Do not edit, create or delete any file in the repository or in Notion. The only file you write is your output file.',
    `- ${(phaseNotes[phase] ?? specialistNote)(repo)}`,
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
  if (snapshot !== undefined) return snapshotKnowledge(snapshot)
  const config = await knowledgeConfig(deps.agentDir ?? PACKAGE_DIR, deps.env ?? process.env)
  return loadKnowledge(knowledgeDirFor(reportDir), config)
}

/** One step of a --local run: the next stage's tasks, or the exported report. Throws KnowledgeRequired, before anything starts, when there are no guidelines. */
export async function runLocal(input: LocalInput, deps: LocalDeps = {}) {
  const orchestrator = orchestratorFile(deps.agentDir)
  const reportDir = reportDirFor(input)
  const work = workDirFor(reportDir)
  const stateFile = join(work, 'state.json')
  const saved = await readFile(stateFile, 'utf8').then((text) => stateSchema.parse(JSON.parse(text)), () => null)
  const knowledge = await resolveKnowledge(input, saved, reportDir, deps)

  const prepared = await prepareWrite({ ...input, guidelinesPath: knowledge.requiredFile }, new AbortController().signal)
  const { dir, idea, guidelines, repo, uiRequired } = prepared
  const repoRoot = resolve(input.repoPath)
  const context = writeContext(prepared, 'not preloaded in --local mode; the explore and ui phases read it through the aspiralabs-ui MCP in the session')
  const fingerprint = createHash('sha256').update(JSON.stringify([idea, guidelines, context, uiRequired, knowledge.digest])).digest('hex')
  if (saved && saved.fingerprint !== fingerprint) throw new Error(`The idea, guidelines or repository changed since this local run started. Delete ${work} to start over.`)
  await mkdir(join(work, 'prompts'), { recursive: true })
  await mkdir(join(work, 'outputs'), { recursive: true })
  const state: State = saved ?? { fingerprint, startedAt: new Date().toISOString(), knowledge: { source: knowledge.source, path: knowledge.path } }
  if (!saved) await writeFile(stateFile, JSON.stringify(state, null, 2))

  const tasks: LocalTask[] = []
  const calls: LocalCall[] = []
  const call: Call = async ({ phase, prompt }) => {
    // A later stage's prompt depends on the earlier stage's outputs; never write it early.
    if (tasks.some((task) => stageOf(task.phase) < stageOf(phase))) throw new Error('waiting for an earlier phase')
    const output = join(work, 'outputs', `${phase}.json`)
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
    const promptFile = join(work, 'prompts', `${phase}.md`)
    await writeFile(promptFile, renderPhasePrompt(phase, prompt, output, repoRoot, knowledge))
    tasks.push({ phase, prompt: promptFile, output, ...(error ? { error } : {}) })
    throw new Error('pending in the session')
  }

  const result = await writePipeline({ idea, guidelines, context, uiRequired }, call)
  if (tasks.length) {
    tasks.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))
    return { pending: true as const, status: 'pending', stage: STAGES[stageOf(tasks[0]!.phase)], workDir: work, orchestrator, tasks }
  }

  applySnapshotGaps(result, prepared)
  const totalMs = Date.now() - Date.parse(state.startedAt)
  const phaseRows = result.phases.map((phase) => `| ${phase.phase} | ${phase.error ? `failed: ${phase.error.replaceAll('|', '/').slice(0, 200)}` : 'completed'} |`)
  const analysis = [
    '# Run analysis', '', `Status: **${result.status}**`, '',
    'Mode: **--local**. The model work ran as subagents of a Claude Code session, on that session\'s model and usage, so no cost or token counts are reported here.', '',
    `Wall time from the first local preparation (${state.startedAt}) to export: **${(totalMs / 1000).toFixed(1)}s**. It includes any time the session spent between stages.`, '',
    '| Phase | Result |', '| --- | --- |', ...phaseRows, '',
  ].join('\n')
  const report = { ...result, review: result.review && { ...result.review, candidate: undefined }, spec: undefined, mode: 'local', input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, models: { all: 'Claude Code session subagents' }, knowledge, startedAt: state.startedAt, totalMs, dir }
  await writeArtifacts(dir, {
    ...writeFiles(result, prepared),
    'trace/calls.json': JSON.stringify({ mode: 'local', system: { writer: writerSystemPrompt, review: reviewSystemPrompt }, knowledge, calls }, null, 2),
    'run-analysis.md': analysis,
    'trace/review.json': JSON.stringify(report, null, 2),
  })
  // Every prompt and output is now in trace/calls.json; the rules used are in trace/review.json.
  await rm(work, { recursive: true, force: true })
  return { pending: false as const, orchestrator, ...summary(result, dir, { totalMs }) }
}

export { KnowledgeRequired } from './local-knowledge.ts'
