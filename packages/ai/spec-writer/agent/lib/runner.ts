import { createHash } from 'node:crypto'
import { notionReadToolsFromEnv } from '@aspiralabs/ai/common/lib/notion-read'
import { CLOUD_RESEARCH_TOOLS } from '@aspiralabs/ai/common/lib/research-rule'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { takenDecision } from '@aspiralabs/ai/common/lib/decisions'
import { modelSession, reviewModelCall, reviewModels } from '@aspiralabs/ai/spec-reviewer/lib/models'
import { readAnswers, renderDecisionsFile, renderFindings, renderFindingsSection, withSettledDecisions } from '@aspiralabs/ai/spec-reviewer/lib/report'
import { systemPrompt as reviewSystemPrompt } from '@aspiralabs/ai/spec-reviewer/lib/review'
import { stripReviewHeader } from '@aspiralabs/ai/spec-reviewer/lib/runner'
import { writeArtifacts } from './artifacts.ts'
import { connectReadTools } from './mcp.ts'
import { repository } from './repository.ts'
import { runAnalysis } from './run-analysis.ts'
import { draftSchema, exploreAreas, exploreSchema, uiPattern, writePipeline, writerSystemPrompt, type WriteResult } from './writer.ts'

// The one spec step (KIT-48). Write mode, from an idea: explore, draft, then the one specialist
// review round on the draft. Review mode, from a spec (`specPath`, the answered spec the author
// ticked decisions on): the same review round on that spec, nothing explored or drafted. Both end in
// spec.reviewed/ with the reviewer's layout, so the planner and the board rules see one output.

/**
 * `ideaPath` writes a spec from the idea; `specPath` reviews an existing spec again (the previous
 * run's own spec.reviewed.md, answered, or the ticket's spec.md). One of the two is required.
 * `takeRecommended` (F10): every decision the review leaves open is taken as the agent's recommended
 * option instead of waiting on the author.
 */
export type RunInput = { ideaPath?: string; specPath?: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean; takeRecommended?: boolean; /** The run packet build-feature wrote (KIT-48), put in front of every phase's context. */ packetPath?: string }

/** The ticket folder an input lives in: the spec's own directory, or its parent when the spec is the previous export's spec.reviewed.md. */
const folderOf = (input: Pick<RunInput, 'ideaPath' | 'specPath'>): string => {
  if (input.specPath !== undefined) {
    const dir = dirname(resolve(input.specPath))
    return basename(dir) === 'spec.reviewed' ? dirname(dir) : dir
  }
  if (input.ideaPath !== undefined) return dirname(resolve(input.ideaPath))
  throw new Error('The spec step needs an idea (ideaPath) to write from or a spec (specPath) to review')
}

/** The output directory: the explicit one, else spec.reviewed/ beside the idea or the spec. */
export const reportDirFor = (input: Pick<RunInput, 'ideaPath' | 'specPath' | 'outputDir'>) => resolve(input.outputDir ?? resolve(folderOf(input), 'spec.reviewed'))

/** Tool rounds the explore phase gets before it must submit. */
export const EXPLORE_MAX_STEPS = 10

/** Inputs every mode shares: the eve/CLI runner and the in-session --local replay. */
export async function prepareWrite(input: RunInput, signal: AbortSignal) {
  const dir = reportDirFor(input)
  const inside = (source: string) => {
    const path = relative(dir, resolve(source))
    return !path || (!path.startsWith('../') && path !== '..')
  }
  if (input.ideaPath !== undefined && inside(input.ideaPath)) throw new Error('Output directory must not contain the idea')
  if (inside(input.guidelinesPath)) throw new Error('Output directory must not contain the guidelines')
  // A review rerun may read the previous run's own spec.reviewed.md (KIT-30): into memory, before anything below is written.
  if (input.specPath !== undefined && inside(input.specPath) && resolve(input.specPath) !== resolve(dir, 'spec.reviewed.md')) throw new Error('Output directory must not contain the source spec (only its own spec.reviewed.md, on a rerun)')
  const mode: 'write' | 'review' = input.specPath !== undefined ? 'review' : 'write'
  // The previous run's trace/decisions.md, with the options the author ticked, is read before the run replaces it.
  const [idea, rawSpec, guidelines, repo, answers, packet] = await Promise.all([
    input.ideaPath === undefined ? Promise.resolve('') : readFile(resolve(input.ideaPath), 'utf8'),
    input.specPath === undefined ? Promise.resolve(undefined) : readFile(resolve(input.specPath), 'utf8'),
    readFile(resolve(input.guidelinesPath), 'utf8'),
    repository(input.repoPath, signal),
    readAnswers(dir),
    input.packetPath === undefined ? Promise.resolve('') : readFile(resolve(input.packetPath), 'utf8'),
  ])
  const spec = rawSpec === undefined ? undefined : stripReviewHeader(rawSpec)
  if (mode === 'write' && !idea.trim()) throw new Error('The idea is empty')
  if (mode === 'review' && !(spec ?? '').trim()) throw new Error('The spec to review is empty')
  if (!guidelines.trim()) throw new Error('Required guidelines snapshot is empty')
  if (/TRUNCATED by the Notion API/i.test(guidelines)) throw new Error('Required guidelines snapshot is truncated')
  const uiRequired = input.uiRequired ?? uiPattern.test(mode === 'write' ? idea : (spec ?? ''))
  const areas = mode === 'write' ? exploreAreas(idea, repo.files.keys()) : []
  return { dir, mode, idea, spec, guidelines, repo, uiRequired, answers, takeRecommended: input.takeRecommended ?? false, areas, packet }
}
export type Prepared = Awaited<ReturnType<typeof prepareWrite>>

export const writeContext = ({ repo, idea, spec, mode, packet }: Prepared, catalog: string) =>
  `${packet ? `RUN PACKET (data):\n${packet}\n\n` : ''}${repo.instructions}\n${repo.packet(mode === 'review' ? (spec ?? '') : idea)}\nAspira UI catalog (read in preparation): ${catalog}\nSnapshot gaps: ${repo.gaps.join('; ')}`

/**
 * With take-recommended, every decision the review left open is recorded with takenDecision before
 * trace/decisions.md and review.json are written (both callers, runWrite and --local's runLocal, call
 * this right after the pipeline and before export), so status is ready when nothing else is open; no
 * decision is ever decidedBy 'author' unless an author actually ticked it.
 */
export function applySnapshotGaps(result: WriteResult, { takeRecommended }: Prepared) {
  // Snapshot gaps (files not indexed for size) are notes in the evidence packet, never a problem: they used to end every run on a repository with one large tracked file incomplete (KIT-29).
  if (takeRecommended && result.status === 'needs-author') {
    result.authorDecisions = result.authorDecisions.map((decision) => (decision.decidedBy === 'open' ? takenDecision(decision.id, decision) : decision))
    result.status = result.authorDecisions.some((decision) => decision.decidedBy === 'open') ? 'needs-author' : 'ready'
  }
}

const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- none')

/** The reviewed spec and the human-readable trace, identical across modes: the reviewer's layout, plus the writer's own files in write mode. */
export function writeFiles(result: WriteResult, { idea, spec, guidelines, mode }: Prepared): Record<string, string> {
  const { exploration, draft, review } = result
  const files: Record<string, string> = {
    'trace/guidelines.md': guidelines,
    'trace/checks.md': `# Checks\n\nStatus: ${result.status}\n\n${list(result.problems)}\n\n## Evidence gaps left open\n\n${list((review?.openGaps ?? []).map((gap) => `${gap.id} (${gap.source}): ${gap.text}`))}\n\n${mode === 'write' ? `## Draft contract\n\n${draft ? list(result.draftContract) : 'No draft.'}\n\n` : ''}${review?.reviews.map((r) => `## ${r.phase}\n\n${r.output.checks.map((c) => `- ${c.rule}: ${c.evidence}`).join('\n')}`).join('\n\n') ?? ''}`,
    // The review half renders through the spec reviewer's own code: sorted findings, checkbox decisions.
    'trace/findings.md': review ? renderFindings(review.findings, review.synthesis, review.gaps) : '# Findings\n\nNo review findings: the review did not run.\n',
    'trace/decisions.md': renderDecisionsFile(result.status, result.authorDecisions, review?.synthesis ?? null),
  }
  if (mode === 'write') {
    files['idea.md'] = idea
    files['trace/exploration.md'] = exploration
      ? `# Exploration\n\n## Facts\n\n${list(exploration.facts)}\n\n## Constraints\n\n${list(exploration.constraints)}\n\n## Open questions\n\n${exploration.questions.map((q) => `- ${q.question}\n  - Options: ${q.options.join('; ')}\n  - Evidence: ${q.evidence.join('; ') || 'none'}`).join('\n') || '- none'}\n\n## UI evidence\n\n${list(exploration.uiEvidence)}\n\n## Gaps\n\n${list(exploration.gaps)}\n`
      : '# Exploration\n\nThe explore phase did not finish. See trace/checks.md.\n'
    if (draft) files['spec.draft.md'] = draft.spec
  } else files['spec.original.md'] = spec ?? ''
  // A ready candidate is the spec the planner takes, so it carries nothing but the spec; one that
  // still needs the author or has problems carries the findings above it. The decided author
  // decisions go into the spec's ## Decisions (KIT-36), so the planner reads them as settled.
  const candidate = result.spec === null ? null : withSettledDecisions(result.spec, result.authorDecisions)
  if (candidate !== null) files['spec.reviewed.md'] = result.status === 'ready' ? candidate
    : `> Review status: **${result.status}**. Not ready for planning; resolve trace/decisions.md and trace/checks.md first. Original status metadata below has not been approved by this review.\n\n${renderFindingsSection(review?.findings ?? [])}\n\n---\n\n${candidate}`
  return files
}

export function writerModels(env: NodeJS.ProcessEnv = process.env) {
  return {
    explore: env.SPEC_WRITER_EXPLORE_MODEL || 'anthropic/claude-opus-5.5',
    draft: env.SPEC_WRITER_DRAFT_MODEL || 'anthropic/claude-opus-5.5',
    review: reviewModels(env),
  }
}

/** Tool rounds the draft gets before it must submit (KIT-54). */
export const DRAFT_MAX_STEPS = 6

export async function runWrite(input: RunInput, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const preparation = options.signal ?? new AbortController().signal
  const prepared = await prepareWrite(input, preparation)
  const { dir, idea, spec, guidelines, repo, uiRequired, answers } = prepared
  const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, preparation)
  // The Notion read tools ride on the integration token every phase can use (KIT-54).
  const tools = { ...repo.tools, ...mcp.tools, ...notionReadToolsFromEnv() }
  const catalogTool = Object.keys(mcp.tools).find((name) => name.endsWith('__list_components'))
  const componentTool = Object.keys(mcp.tools).find((name) => name.endsWith('__get_component'))
  let catalog: unknown = null
  try {
    if (uiRequired && catalogTool) catalog = await mcp.tools[catalogTool]!.execute!({}, { toolCallId: 'catalog-preflight', messages: [], context: {}, abortSignal: preparation })
  } catch (error) { await mcp.close(); throw error }
  const prepareMs = Date.now() - started
  const models = writerModels()
  const session = modelSession(started)
  const reviewCall = reviewModelCall(session, models.review, tools, componentTool)
  const call = session.record(async (request) => {
    const { phase, prompt, signal } = request
    if (phase === 'explore' || phase.startsWith('explore:')) return session.toolLoop({ phase, model: models.explore, system: writerSystemPrompt, prompt, schema: exploreSchema, tools, signal, maxSteps: EXPLORE_MAX_STEPS, maxOutputTokens: 8_000, submitName: 'submit_exploration' })
    // The draft reads too (KIT-54): what the exploration lacks is looked up, not left as an assumption.
    if (phase === 'draft') return session.toolLoop({ phase, model: models.draft, system: writerSystemPrompt, prompt: `${prompt}\n\n${CLOUD_RESEARCH_TOOLS}`, schema: draftSchema, tools, signal, maxSteps: DRAFT_MAX_STEPS, maxOutputTokens: 24_000, submitName: 'submit_draft', reasoning: 'medium' })
    return reviewCall(request)
  })
  try {
    const result = await writePipeline({ idea, guidelines, context: writeContext(prepared, JSON.stringify(catalog)), uiRequired, answers, areas: prepared.areas, ...(spec === undefined ? {} : { spec }) }, call, options)
    const uiReviewed = result.review !== null && (uiRequired || uiPattern.test(result.draft?.spec ?? spec ?? ''))
    // A successful catalog listing is the requirement (KIT-35): a catalog with nothing in it has nothing to get_component.
    if (uiReviewed && !mcp.reads.some((read) => read.ok && read.tool.endsWith('__list_components'))) {
      result.problems.push('UI work requires a successful list_components MCP read')
      result.status = 'incomplete'
    }
    applySnapshotGaps(result, prepared)
    const exportStarted = Date.now()
    session.settle()
    const files: Record<string, string> = {
      ...writeFiles(result, prepared),
      'trace/calls.json': JSON.stringify({ system: { writer: writerSystemPrompt, review: reviewSystemPrompt }, models, calls: session.calls }, null, 2),
      'trace/usage.json': JSON.stringify({ scope: 'Direct writer and review calls only; excludes eve router. Aborted calls may have unreported provider usage.', turns: session.ledger }, null, 2),
    }
    let totalMs = 0
    let reportedCostUsd = 0
    await writeArtifacts(dir, files, () => {
      totalMs = Date.now() - started
      const exportMs = Date.now() - exportStarted
      const analysis = runAnalysis(session.ledger, result.phases, { prepareMs, reviewMs: result.writeMs, exportMs, totalMs, status: result.status })
      reportedCostUsd = analysis.reportedCostUsd
      const report = { ...result, review: result.review && { ...result.review, candidate: undefined }, spec: undefined, input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, specSha256: specSha256(files), models, reportedCostUsd, mcp: mcp.sources, mcpReads: mcp.reads, prepareMs, exportMs, totalMs, dir }
      return { 'run-analysis.md': analysis.markdown, 'trace/review.json': JSON.stringify(report, null, 2) }
    })
    return summary(result, dir, { prepareMs, reportedCostUsd, totalMs })
  } finally { await mcp.close() }
}

/** The export's own hash of spec.reviewed.md, so a later run (the planner's review-facts) can tell whether it still describes this review (F33). */
export const specSha256 = (files: Record<string, string>): string | undefined => (files['spec.reviewed.md'] === undefined ? undefined : createHash('sha256').update(files['spec.reviewed.md']).digest('hex'))

export function summary(result: WriteResult, dir: string, extra: Record<string, number>) {
  return {
    status: result.status, mode: result.mode, dir, spec: result.spec === null ? null : resolve(dir, 'spec.reviewed.md'), draft: result.draft ? resolve(dir, 'spec.draft.md') : null,
    findings: result.review?.findings.length ?? 0, problems: result.problems, openGaps: result.review?.openGaps ?? [], authorDecisions: result.authorDecisions, writeMs: result.writeMs, ...extra,
  }
}
