import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { modelSession, reviewModelCall, reviewModels } from '@aspiralabs/spec-reviewer/lib/models'
import { systemPrompt as reviewSystemPrompt } from '@aspiralabs/spec-reviewer/lib/review'
import { writeArtifacts } from './artifacts.ts'
import { connectReadTools } from './mcp.ts'
import { repository } from './repository.ts'
import { runAnalysis } from './run-analysis.ts'
import { draftSchema, exploreSchema, uiPattern, writePipeline, writerSystemPrompt, type WriteResult } from './writer.ts'

export type RunInput = { ideaPath: string; repoPath: string; guidelinesPath: string; outputDir?: string; uiRequired?: boolean }

/** Inputs every mode shares: the eve/CLI runner and the in-session --local replay. */
export async function prepareWrite(input: RunInput, signal: AbortSignal) {
  const dir = resolve(input.outputDir ?? resolve(dirname(input.ideaPath), 'spec.written'))
  for (const source of [input.ideaPath, input.guidelinesPath]) {
    const path = relative(dir, resolve(source))
    if (!path || (!path.startsWith('../') && path !== '..')) throw new Error('Output directory must not contain the idea or guidelines')
  }
  const [idea, guidelines, repo] = await Promise.all([
    readFile(resolve(input.ideaPath), 'utf8'), readFile(resolve(input.guidelinesPath), 'utf8'), repository(input.repoPath, signal),
  ])
  if (!idea.trim()) throw new Error('The idea is empty')
  if (!guidelines.trim()) throw new Error('Required guidelines snapshot is empty')
  if (/TRUNCATED by the Notion API/i.test(guidelines)) throw new Error('Required guidelines snapshot is truncated')
  const uiRequired = input.uiRequired ?? uiPattern.test(idea)
  return { dir, idea, guidelines, repo, uiRequired }
}
export type Prepared = Awaited<ReturnType<typeof prepareWrite>>

export const writeContext = ({ repo, idea }: Prepared, catalog: string) =>
  `${repo.instructions}\n${repo.packet(idea)}\nAspira UI catalog (read in preparation): ${catalog}\nSnapshot gaps: ${repo.gaps.join('; ')}`

/** Repository snapshot gaps block readiness in every mode. */
export function applySnapshotGaps(result: WriteResult, { repo }: Prepared) {
  if (repo.gaps.length) { result.problems.push(...repo.gaps); result.status = 'incomplete' }
}

const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- none')

/** The written spec and the human-readable trace, identical across modes. */
export function writeFiles(result: WriteResult, { idea, guidelines }: Prepared): Record<string, string> {
  const { exploration, draft, review } = result
  const files: Record<string, string> = {
    'idea.md': idea,
    'trace/guidelines.md': guidelines,
    'trace/exploration.md': exploration
      ? `# Exploration\n\n## Facts\n\n${list(exploration.facts)}\n\n## Constraints\n\n${list(exploration.constraints)}\n\n## Open questions\n\n${exploration.questions.map((q) => `- ${q.question}\n  - Options: ${q.options.join('; ')}\n  - Evidence: ${q.evidence.join('; ') || 'none'}`).join('\n') || '- none'}\n\n## UI evidence\n\n${list(exploration.uiEvidence)}\n\n## Gaps\n\n${list(exploration.gaps)}\n`
      : '# Exploration\n\nThe explore phase did not finish. See trace/checks.md.\n',
    'trace/checks.md': `# Checks\n\nStatus: ${result.status}\n\n${list(result.problems)}\n\n## Draft contract\n\n${draft ? list(result.draftContract) : 'No draft.'}\n\n${review?.reviews.map((r) => `## ${r.phase}\n\n${r.output.checks.map((c) => `- ${c.rule}: ${c.evidence}`).join('\n')}`).join('\n\n') ?? ''}`,
    'trace/findings.md': review?.findings.map((f) => `## ${f.id} — ${f.title}\n\n${f.evidence.join('\n\n')}\n\nProposed correction: ${f.fix}`).join('\n\n') || 'No review findings.',
    'trace/decisions.md': `# Decisions\n\nStatus: ${result.status}\n\n${review?.synthesis?.dispositions.map((d) => `## ${d.findingId} — ${d.status}\n\n${d.reason}\n\nEvidence: ${d.evidence.join('; ')}\n\nEdits: ${d.editIds.join(', ') || 'none'}${d.duplicateOf ? `; duplicate of ${d.duplicateOf}` : ''}`).join('\n\n') ?? 'Reconciliation did not finish. All findings remain unresolved.'}\n`,
  }
  if (draft) files['spec.draft.md'] = draft.spec
  if (result.spec !== null) files['spec.md'] = result.status === 'ready' ? result.spec
    : `> Spec writer status: **${result.status}**. Not ready for planning; resolve trace/decisions.md and trace/checks.md first.\n\n${result.spec}`
  return files
}

export function writerModels(env: NodeJS.ProcessEnv = process.env) {
  return {
    explore: env.SPEC_WRITER_EXPLORE_MODEL || 'anthropic/claude-opus-5.5',
    draft: env.SPEC_WRITER_DRAFT_MODEL || 'anthropic/claude-opus-5.5',
    review: reviewModels(env),
  }
}

export async function runWrite(input: RunInput, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const preparation = options.signal ?? new AbortController().signal
  const prepared = await prepareWrite(input, preparation)
  const { dir, idea, guidelines, repo, uiRequired } = prepared
  const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, preparation)
  const tools = { ...repo.tools, ...mcp.tools }
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
    if (phase === 'explore') return session.toolLoop({ phase, model: models.explore, system: writerSystemPrompt, prompt, schema: exploreSchema, tools, signal, maxSteps: 10, maxOutputTokens: 8_000, submitName: 'submit_exploration' })
    if (phase === 'draft') return session.structured({ phase, model: models.draft, system: writerSystemPrompt, prompt, schema: draftSchema, signal, reasoning: 'medium', maxOutputTokens: 24_000 })
    return reviewCall(request)
  })
  try {
    const result = await writePipeline({ idea, guidelines, context: writeContext(prepared, JSON.stringify(catalog)), uiRequired }, call, options)
    const uiReviewed = result.review !== null && (uiRequired || uiPattern.test(result.draft?.spec ?? ''))
    if (uiReviewed && !['list_components', 'get_component'].every((name) => mcp.reads.some((read) => read.ok && read.tool.endsWith(`__${name}`)))) {
      result.problems.push('UI work requires successful list_components and get_component MCP reads')
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
      const report = { ...result, review: result.review && { ...result.review, candidate: undefined }, spec: undefined, input: { ...input, repoCommit: repo.commit, repoDirty: repo.dirty }, models, reportedCostUsd, mcp: mcp.sources, mcpReads: mcp.reads, prepareMs, exportMs, totalMs, dir }
      return { 'run-analysis.md': analysis.markdown, 'trace/review.json': JSON.stringify(report, null, 2) }
    })
    return summary(result, dir, { prepareMs, reportedCostUsd, totalMs })
  } finally { await mcp.close() }
}

export function summary(result: WriteResult, dir: string, extra: Record<string, number>) {
  return {
    status: result.status, dir, spec: result.spec === null ? null : resolve(dir, 'spec.md'), draft: result.draft ? resolve(dir, 'spec.draft.md') : null,
    findings: result.review?.findings.length ?? 0, problems: result.problems, authorDecisions: result.authorDecisions, writeMs: result.writeMs, ...extra,
  }
}
