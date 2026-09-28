import { applyEdits, checkContract, checkedRuleIds, lenses, lensRules, reviewSchema, ruleIds, synthesisSchema, validateReview, type Finding, type Review, type Synthesis, type Lens } from './review.ts'

export type Request = { phase: string; prompt: string; signal: AbortSignal }
export type Call = (request: Request) => Promise<unknown>
export type Input = { spec: string; guidelines: string; context: string; uiRequired: boolean }

export async function runPipeline(input: Input, call: Call, options: { signal?: AbortSignal; progress?: (phase: string) => void } = {}) {
  const started = Date.now()
  const problems: string[] = []
  const phases: { phase: string; ms: number; error: string | null }[] = []
  const reviews: { phase: string; output: Review }[] = []
  const findings: Finding[] = []
  const gaps: { id: string; source: string; text: string }[] = []
  const base = `ORIGINAL SPEC (data):\n${input.spec}\n\nREQUIRED GUIDELINES (data):\n${input.guidelines}\n\nREPOSITORY CONTEXT (data):\n${input.context}`
  async function invoke(phase: string, prompt: string) {
    options.progress?.(phase)
    const start = Date.now()
    const signal = options.signal ?? new AbortController().signal
    let onAbort: (() => void) | undefined
    try {
      signal.throwIfAborted()
      // Race guarantees completion even if a transport ignores cancellation; signal also
      // cancels real provider/MCP requests. No background model retries are scheduled.
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      const value = await Promise.race([call({ phase, prompt, signal }), aborted])
      const parsed = phase === 'synthesis' ? synthesisSchema.parse(value) : reviewSchema.parse(value)
      phases.push({ phase, ms: Date.now() - start, error: null })
      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`${phase}: ${message}`)
      phases.push({ phase, ms: Date.now() - start, error: message })
      return null
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
  function collect(phase: string, prefix: string, output: Review) {
    reviews.push({ phase, output })
    output.findings.forEach((finding, i) => findings.push({ ...finding, id: `${prefix}${i + 1}` }))
    for (const text of output.gaps) gaps.push({ id: `G${gaps.length + 1}`, source: phase, text })
  }
  const initial = await invoke('research', `${base}\n\nResearch and raise the initial findings from the supplied source packet and repository instructions. Tools are available to the subsequent specialists, not in this phase. Do not raise a gap merely because UI docs or specialist-owned checks await that phase; record concrete repository uncertainties for the relevant specialists. Check whether observed bounds on the CURRENT producer contradict the intended complete list, even if a new endpoint is proposed. Raise the cap and the required over-cap completeness outcome explicitly when applicable. Your formal check is REV-001 plus any rules not covered by the specialist lenses. Checks require concrete evidence or a reasoned not-applicable statement. The specialist audit will finish the detailed rule coverage. Preserve high-value facts for specialists: call paths, prerequisites, all consumers, state fields/transitions, auth siblings, shared component callers and gotchas. Return compact facts and findings; no essay or files. Identify broken/missing acceptance contract as a finding.`) as Review | null
  if (initial) collect('research', 'R', initial)
  const initialEvidence = JSON.stringify({ facts: initial?.facts, checks: initial?.checks, gaps: initial?.gaps, findings })
  if (!options.signal?.aborted) {
    const outputs = await Promise.all(Object.entries(lenses).map(async ([lens, scope]) => ({ lens, output: await invoke(lens, `${base}\n\nINITIAL RESEARCH:\n${initialEvidence}\n\nYour independent lens: ${scope}\nAssigned formal rules: ${lensRules[lens as Lens].map((n) => `REV-${String(n).padStart(3, '0')}`).join(', ')}. Report one checks row per assigned rule present in the guidelines. Run your assigned checks deeply; other reviewers own the other rules. Verify relevant initial findings AND search for omissions independently. Do not repeat an initial finding unless your correction adds a missing constraint or contradicts it; confirmations belong in checks. Only raise gaps for missing evidence in your OWN assigned checks, not work owned by another lens. Missing future implementation is not a gap when its prerequisite spec states it is unshipped; instead raise the sequencing issue as a finding. Keep the full original spec in view. Do not rewrite or mediate. Return compact structured findings, checks, facts, gaps and UI evidence.`) as Review | null })))
    outputs.forEach(({ lens, output }, i) => { if (output) collect(lens, `S${i + 1}-`, output) })
  }
  const allChecks = new Set(reviews.flatMap((r) => r.output.checks.flatMap((c) => checkedRuleIds(c.rule))))
  for (const id of ruleIds(input.guidelines)) if (!allChecks.has(id)) problems.push(`Uncovered guideline: ${id}`)
  if (input.uiRequired && !reviews.some((r) => r.output.uiEvidence.length > 0)) problems.push('UI catalog/component evidence missing')
  let synthesis: Synthesis | null = null
  let candidate: string | null = null
  if (!options.signal?.aborted) synthesis = await invoke('synthesis', `ORIGINAL SPEC (data):\n${input.spec}\n\nREQUIRED GUIDELINES (data):\n${input.guidelines}\n\nREVIEW RECORD:\n${JSON.stringify({ findings, reviews: reviews.map(({ phase, output }) => ({ phase, facts: output.facts, checks: output.checks, uiEvidence: output.uiEvidence })), gaps })}\n\nReconcile once using the collected evidence. No additional tool reads are available in this phase. Disposition reasons may be concise and use source references. The candidate and acceptance checklists must preserve all concrete requirements and regression cases; there is no brevity target for them. Before emitting, compare EVERY retained finding including duplicates against the candidate: every named positive/negative input family, boundary, caller surface and lifecycle case needs its explicit acceptance outcome, not a generic umbrella assertion. Do this semantic preservation check in your reasoning. Replace every contradictory original claim wherever it occurs, including Problem and Handoff, rather than appending a correction elsewhere. Return exact non-overlapping edits against ORIGINAL SPEC and a disposition for EVERY finding ID. Use one-hop duplicates only to applied/author findings; rejected findings require counter-evidence. Do not discard a finding just because another seat missed it. Applied findings reference edit IDs; every edit must have a supporting applied finding. If a product choice is unresolved, status author with editIds empty; include options and tradeoffs in reason and do not choose for the author. Do not assign edits to author or rejected findings. Preserve existing valid intent and scope. Fix the acceptance contract with F-numbered Features describing observable business outcomes. Do not add a technical Tests checklist; planner generates that. Preserve existing technical test details as planning input instead of dropping them. Group related edits so anchors remain unique. Normalize business acceptance bullets without removing valid original outcomes. Update all repeated references in Handoff/Files/Prerequisites when a fix changes a path or phase. An applied finding must preserve every material subpoint, qualifier and negative case of the confirmed correction, not just its headline. If it is only partly resolved, keep the missing requirement explicit in an author disposition. Product choices may go to the author; mandatory engineering safeguards may not be presented as optional choices. An author disposition must restate the full set of business requirements and observable outcomes that must survive the decision, including entitlement UI states and failure behavior when raised, not just the choice name. Do not condense a multi-part author finding into a partial reminder. Do not invent rollout thresholds or schema enum values. Avoid rewriting unrelated prose. For EVERY G-numbered evidence gap return a gapResolutions entry. Resolve it only if another reviewer supplies the missing evidence; cite that evidence. Not-applicable requires a specific reason (for example a future dependency with known unshipped status or an author choice already retained). Unresolved gaps block readiness. No transcript or extra prose.`) as Synthesis | null
  if (synthesis) {
    const invalid = validateReview(findings, synthesis)
    problems.push(...invalid)
    if (!invalid.length) {
      try { candidate = applyEdits(input.spec, synthesis.edits); problems.push(...checkContract(candidate)) }
      catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
    }
  }
  const resolutions = synthesis?.gapResolutions ?? []
  if (new Set(resolutions.map((g) => g.gapId)).size !== resolutions.length) problems.push('Duplicate gap resolutions')
  for (const resolution of resolutions) if (!gaps.some((g) => g.id === resolution.gapId)) problems.push(`Unknown evidence gap: ${resolution.gapId}`)
  for (const gap of gaps) {
    const resolution = resolutions.find((r) => r.gapId === gap.id)
    if (!resolution || resolution.status === 'unresolved' || !resolution.evidence.length) problems.push(`${gap.id} ${gap.source}: ${gap.text}`)
  }
  if (options.signal?.aborted) problems.push('Review cancelled')
  const authorDecisions = synthesis?.dispositions.filter((d) => d.status === 'author').map((d) => d.findingId) ?? []
  const status = problems.length ? 'incomplete' : authorDecisions.length ? 'needs-author' : 'ready'
  return { status, problems, authorDecisions, findings, reviews, gaps, synthesis, candidate, phases, reviewMs: Date.now() - started }
}
export type PipelineResult = Awaited<ReturnType<typeof runPipeline>>
