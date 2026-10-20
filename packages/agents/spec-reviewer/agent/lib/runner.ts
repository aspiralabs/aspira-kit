import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { writeArtifacts } from './artifacts.ts'
import { runAnalysis } from './run-analysis.ts'
import { connectReadTools } from './mcp.ts'
import { modelSession, reviewModelCall, reviewModels } from './models.ts'
import { runPipeline, type PipelineResult } from './pipeline.ts'
import { readAnswers, renderDecisionsFile, renderFindings, renderFindingsSection, withSettledDecisions } from './report.ts'
import { repository } from './repository.ts'
import { systemPrompt } from './review.ts'

export type RunInput = { specPath: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean; takeRecommended?: boolean }

/** The report directory: the explicit output directory, else spec.reviewed/ beside the spec. */
export const reportDirFor = (input: Pick<RunInput, 'specPath' | 'outputDir'>) => resolve(input.outputDir ?? resolve(dirname(input.specPath), 'spec.reviewed'))

/**
 * The spec without the review header a needs-author or incomplete spec.reviewed.md carries above the
 * candidate (the "> Review status:" callout, the findings and the `---` rule that reviewFiles writes),
 * so a rerun on the answered file reviews the spec itself (KIT-30). Any other text is returned as is.
 */
export function stripReviewHeader(text: string): string {
  // The spec writer's own header ("> Spec writer status:") has the same shape (KIT-34): a reviewed
  // spec must not carry "author decisions pending" into the planner after the review settled them.
  if (!text.startsWith('> Review status: ') && !text.startsWith('> Spec writer status: ')) return text
  const rule = '\n---\n\n'
  const at = text.indexOf(rule)
  return at === -1 ? text : text.slice(at + rule.length)
}

/** Inputs every review mode shares: the eve/CLI runner and the in-session --local replay. */
export async function prepareReview(input: RunInput, signal: AbortSignal) {
  const dir = reportDirFor(input)
  // The guidelines never live in the report directory. The spec may be the previous run's own
  // spec.reviewed.md there (KIT-30): a rerun after needs-author or incomplete reads the answered spec
  // the Playbook names, into memory, before anything below is written; spec.original.md keeps it.
  const inside = (source: string) => {
    const path = relative(dir, resolve(source))
    return !path || (!path.startsWith('../') && path !== '..')
  }
  if (inside(input.guidelinesPath)) throw new Error('Output directory must not contain the guidelines')
  if (inside(input.specPath) && resolve(input.specPath) !== resolve(dir, 'spec.reviewed.md')) throw new Error('Output directory must not contain the source spec (only its own spec.reviewed.md, on a rerun)')
  // The previous run's trace/decisions.md, with the options the author ticked, is read before the run replaces it.
  const [raw, guidelines, repo, answers] = await Promise.all([
    readFile(resolve(input.specPath), 'utf8'), readFile(resolve(input.guidelinesPath), 'utf8'), repository(input.repoPath, signal), readAnswers(dir),
  ])
  const spec = stripReviewHeader(raw)
  if (!guidelines.trim()) throw new Error('Required guidelines snapshot is empty')
  if (/TRUNCATED by the Notion API/i.test(guidelines)) throw new Error('Required guidelines snapshot is truncated')
  const uiRequired = input.uiRequired ?? /\b(?:UI|screen|page|card|button|mobile|component|navigation)\b/i.test(spec)
  return { dir, spec, guidelines, repo, uiRequired, answers }
}
export type Prepared = Awaited<ReturnType<typeof prepareReview>>

export const reviewContext = ({ repo, spec }: Prepared, catalog: string) =>
  `${repo.instructions}\n${repo.packet(spec)}\nAspira UI catalog (read in preparation): ${catalog}\nSnapshot gaps: ${repo.gaps.join('; ')}`

/** Repository snapshot gaps (files not indexed for size) are notes in the evidence packet, never a problem: they used to end every run on a repository with one large tracked file incomplete (KIT-29). Kept so both callers stay as they are. */
export function applySnapshotGaps(_result: PipelineResult, _prepared: Prepared) {
  // Nothing to apply: the gaps are already in the packet's "Snapshot gaps" line.
}

/** The reviewed spec and the human-readable trace, identical across modes. */
export function reviewFiles(result: PipelineResult, { spec, guidelines }: Prepared): Record<string, string> {
  const files: Record<string, string> = {
    'spec.original.md': spec,
    'trace/guidelines.md': guidelines,
    'trace/decisions.md': renderDecisionsFile(result.status, result.authorDecisions, result.synthesis),
    'trace/findings.md': renderFindings(result.findings, result.synthesis, result.gaps),
    'trace/checks.md': `# Checks\n\nStatus: ${result.status}\n\n${result.problems.map((p) => `- ${p}`).join('\n')}\n\n${result.reviews.map((r) => `## ${r.phase}\n\n${r.output.checks.map((c) => `- ${c.rule}: ${c.evidence}`).join('\n')}`).join('\n\n')}`,
  }
  // A ready candidate is the spec the planner takes, so it carries nothing but the spec. A candidate
  // that still needs the author or has problems carries the findings, sorted, above it.
  // The decided author decisions go into the spec's ## Decisions (KIT-36), so the planner reads them as settled instead of raising them again.
  const candidate = result.candidate === null ? null : withSettledDecisions(result.candidate, result.authorDecisions)
  if (candidate !== null) files['spec.reviewed.md'] = result.status === 'ready' ? candidate
    : `> Review status: **${result.status}**. Not ready for implementation; resolve trace/decisions.md and trace/checks.md first. Original status metadata below has not been approved by this review.\n\n${renderFindingsSection(result.findings)}\n\n---\n\n${candidate}`
  return files
}

export async function runReview(input: RunInput, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const preparation = options.signal ?? new AbortController().signal
  const prepared = await prepareReview(input, preparation)
  const { dir, spec, guidelines, repo, uiRequired, answers } = prepared
  const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, preparation)
  const tools = { ...repo.tools, ...mcp.tools }
  const catalogTool = Object.keys(mcp.tools).find((name) => name.endsWith('__list_components'))
  const componentTool = Object.keys(mcp.tools).find((name) => name.endsWith('__get_component'))
  let catalog: unknown = null
  try {
    if (uiRequired && catalogTool) catalog = await mcp.tools[catalogTool]!.execute!({}, { toolCallId: 'catalog-preflight', messages: [], context: {}, abortSignal: preparation })
  } catch (error) { await mcp.close(); throw error }
  const prepareMs = Date.now() - started
  const models = reviewModels()
  const session = modelSession(started)
  const { ledger, calls } = session
  const call = session.record(reviewModelCall(session, models, tools, componentTool))
  try {
    const result = await runPipeline({ spec, guidelines, context: reviewContext(prepared, JSON.stringify(catalog)), uiRequired, answers, takeRecommended: input.takeRecommended ?? false }, call, options)
    // A successful catalog listing is the requirement (KIT-35): a catalog with nothing in it has nothing to get_component.
    if (uiRequired && !mcp.reads.some((read) => read.ok && read.tool.endsWith('__list_components'))) {
      result.problems.push('UI review requires a successful list_components MCP read')
      result.status = 'incomplete'
    }
    applySnapshotGaps(result, prepared)
    const exportStarted = Date.now()
    // A transport may settle after the pipeline is cancelled; preserve the state at export.
    session.settle()
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
      // The export's own hash of spec.reviewed.md, so a later run can tell whether it still describes this review (F33).
      const specSha256 = files['spec.reviewed.md'] === undefined ? undefined : createHash('sha256').update(files['spec.reviewed.md']).digest('hex')
      const report = { ...result, candidate: undefined, input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, specSha256, models, reportedCostUsd, mcp: mcp.sources, mcpReads: mcp.reads, prepareMs, exportMs, totalMs, dir }
      return { 'run-analysis.md': analysis.markdown, 'trace/review.json': JSON.stringify(report, null, 2) }
    })
    return { status: result.status, dir, findings: result.findings.length, problems: result.problems, authorDecisions: result.authorDecisions, prepareMs, reviewMs: result.reviewMs, reportedCostUsd, totalMs }
  } finally { await mcp.close() }
}
