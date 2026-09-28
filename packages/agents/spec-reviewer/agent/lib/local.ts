import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { writeArtifacts } from './artifacts.ts'
import { runPipeline, type Call } from './pipeline.ts'
import { lenses, reviewSchema, synthesisSchema, systemPrompt } from './review.ts'
import { applySnapshotGaps, prepareReview, reviewContext, reviewFiles, type RunInput } from './runner.ts'

// --local: the same pipeline, with the Claude Code session as the model. Each invocation replays
// runPipeline from the start. A phase whose output file exists and validates is fed back in; a
// missing one gets its exact agent prompt written to disk and the replay stops at that stage. The
// session runs the pending phases as subagents and invokes this again. Finding IDs, validation,
// edit application, contract checks and artifacts stay code, identical to the agent.

export type LocalInput = RunInput & { finish?: boolean }
export type LocalTask = { phase: string; prompt: string; output: string; error?: string }
type LocalCall = { phase: string; prompt: string; output?: unknown; error?: string }

const STAGES = ['research', 'specialists', 'reconciliation'] as const
const stageOf = (phase: string) => (phase === 'research' ? 0 : phase === 'synthesis' ? 2 : 1)
const PHASE_ORDER = ['research', ...Object.keys(lenses), 'synthesis']
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const workDirFor = (reportDir: string) => `${reportDir}.local`

const phaseNotes: Record<string, (repo: string) => string> = {
  research: () => 'The agent runs this phase without tools, over the source packet in the task. You may open a file to confirm a fact in the packet, but do not start the specialists\' work.',
  synthesis: () => 'No tool reads in this phase: reconcile from the review record in the task.',
  ui: (repo) => `Read-only tools only: Read, Grep, Glob and non-mutating git commands, in the repository at ${repo}. First call the aspiralabs-ui MCP: list_components, then get_component for every control the spec proposes, and record each read in uiEvidence. If that MCP is not available in this session, record it as a gap; do not substitute other evidence for the catalog.`,
}
const specialistNote = (repo: string) => `Read-only tools only: Read, Grep, Glob and non-mutating git commands, in the repository at ${repo}. The agent gives this phase six tool rounds; be as efficient: batch reads and searches.`

export function renderPhasePrompt(phase: string, prompt: string, output: string, repo: string, schema: z.ZodType): string {
  return [
    `# Aspira spec review: ${phase} (--local)`, '',
    `You are the \`${phase}\` phase of the Aspira spec review, running as a subagent of a Claude Code session instead of inside spec-reviewer. The System and Task sections below are the exact prompt the agent sends. Follow them.`, '',
    '- Do not edit, create or delete any file in the repository. The only file you write is your output file.',
    `- ${(phaseNotes[phase] ?? specialistNote)(repo)}`,
    `- Finish by writing ONE JSON object to \`${output}\` that validates against the output schema at the end. No markdown fences and no prose in that file. Then reply with one line: \`done\`, or what stopped you.`, '',
    '## System', '', systemPrompt, '',
    '## Task', '', prompt, '',
    '## Output schema', '', '```json', JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2), '```', '',
  ].join('\n')
}

export async function runLocal(input: LocalInput) {
  const prepared = await prepareReview(input, new AbortController().signal)
  const { dir, spec, guidelines, repo, uiRequired } = prepared
  const work = workDirFor(dir)
  const repoRoot = resolve(input.repoPath)
  const context = reviewContext(prepared, 'not preloaded in --local mode; the ui reviewer reads it through the aspiralabs-ui MCP in the session')
  const fingerprint = createHash('sha256').update(JSON.stringify([spec, guidelines, context, uiRequired])).digest('hex')
  await mkdir(join(work, 'prompts'), { recursive: true })
  await mkdir(join(work, 'outputs'), { recursive: true })
  const stateFile = join(work, 'state.json')
  const saved = await readFile(stateFile, 'utf8').then((text) => JSON.parse(text) as { fingerprint: string; startedAt: string }, () => null)
  if (saved && saved.fingerprint !== fingerprint) throw new Error(`The spec, guidelines or repository changed since this local review started. Delete ${work} to start over.`)
  const state = saved ?? { fingerprint, startedAt: new Date().toISOString() }
  if (!saved) await writeFile(stateFile, JSON.stringify(state, null, 2))

  const tasks: LocalTask[] = []
  const calls: LocalCall[] = []
  const call: Call = async ({ phase, prompt }) => {
    // A later stage's prompt depends on the earlier stage's outputs; never write it early.
    if (tasks.some((task) => stageOf(task.phase) < stageOf(phase))) throw new Error('waiting for an earlier phase')
    const schema = phase === 'synthesis' ? synthesisSchema : reviewSchema
    const output = join(work, 'outputs', `${phase}.json`)
    const raw = await readFile(output, 'utf8').catch(() => null)
    let error: string | undefined
    if (raw !== null) {
      try {
        const value = schema.parse(JSON.parse(raw))
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
    await writeFile(promptFile, renderPhasePrompt(phase, prompt, output, repoRoot, schema))
    tasks.push({ phase, prompt: promptFile, output, ...(error ? { error } : {}) })
    throw new Error('pending in the session')
  }

  const result = await runPipeline({ spec, guidelines, context, uiRequired }, call)
  if (tasks.length) {
    tasks.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))
    return { pending: true as const, status: 'pending', stage: STAGES[stageOf(tasks[0]!.phase)], workDir: work, tasks }
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
  const report = { ...result, candidate: undefined, mode: 'local', input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, models: { all: 'Claude Code session subagents' }, startedAt: state.startedAt, totalMs, dir }
  await writeArtifacts(dir, {
    ...reviewFiles(result, prepared),
    'trace/calls.json': JSON.stringify({ mode: 'local', system: systemPrompt, calls }, null, 2),
    'run-analysis.md': analysis,
    'trace/review.json': JSON.stringify(report, null, 2),
  })
  // Every prompt and output is now in trace/calls.json.
  await rm(work, { recursive: true, force: true })
  return { pending: false as const, status: result.status, dir, findings: result.findings.length, problems: result.problems, authorDecisions: result.authorDecisions, totalMs }
}
