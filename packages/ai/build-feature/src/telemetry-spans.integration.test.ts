// Run telemetry for /aspira-build-feature (KIT-19 plan P7: T23-T31) at seam S1: the driver CLI
// `scripts/local.ts <ID>` as `build-feature.sh local` runs it, through driver.test-helper.ts
// project(), observed through the stages it prints and the files it leaves in the ticket folder:
// `telemetry/<run-id>.json` (OTLP JSON), `.local/telemetry/` (run-id markers and the attach record),
// state.json and build-summary.md. Only the boundaries are stood in for (TEST-007): a real temp git
// repository with a bare origin, a fake gh on PATH, time through BUILD_FEATURE_NOW (setNow), the
// Notion answers the session would write as stage answer files, and the step agents' usage files
// written as literal fixtures with their modification time set inside (or outside) the step.
// NOTION_TOKEN is never passed to the driver.
//
// The stage contract added here (beside the one driver.test-helper.ts describes):
//   - step: the printed `command` (and the command in the step prompt) ends with
//     `--parent-run <runId>:<nonce>`; nothing stored keeps it.
//   - telemetry: printed after the Build Summary push when the fetched board rules list the run
//     telemetry file on the BOARD-003 line; `notion: [{ op: 'write', target: 'ticket' }]`; the session
//     answers { attached: true, blockId } or { error }. The attach is recorded at
//     `.local/telemetry/attached/<runId>.json` ({ runId, blockId }).
//   - end: a telemetry file that is not attached adds `Telemetry not attached: <reason>; the file is at <path>`.
//   - a run refuses (exit 1, no stage) before its first step when a step skill's
//     `<HOME>/.claude/skills/aspira-<step>/.kit-version` is missing or differs from this package's version.
// Span attributes read here: aspira.status, aspira.duration_ms, aspira.orchestration.duration_ms,
// aspira.segment, aspira.not_measured, aspira.gap, aspira.partial, aspira.usage_scope,
// aspira.tokens.input, aspira.tokens.output, aspira.tokens.total, aspira.cost_usd, and a model attribute.

import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PR_URL, cleanup, project, writeStepExport } from './driver.test-helper.ts'
import {
  SLOW,
  kitVersions,
  at,
  SOURCE,
  high,
  type Span,
  valueOf,
  attr,
  notMeasured,
  durationOf,
  readTrace,
  reportUsage,
  gatePasses,
  stopWith,
  toReview,
  put,
  usageJson,
  usageLines,
} from './telemetry.integration.shared.ts'

afterAll(cleanup)

describe('KIT-19 T26 F10 F11 F12: cloud step spans carry the numbers of their own usage file', () => {
  it('gives the spec-writer step span the summed tokens and gateway cost of its trace/usage.json, partial with a usage scope', async () => {
    const h = await project({ status: 'Ready: Idea', mode: 'cloud', files: kitVersions() })
    h.setNow(at('09:00:00'))
    const step = await h.advance({}, await h.start())
    h.setNow(at('09:10:00'))
    await reportUsage(h, step.stage, 'ready', null)
    await put(
      join(h.folder, 'spec.reviewed/trace/usage.json'),
      usageJson([
        { phase: 'explore', model: 'anthropic/claude-opus-5.5', input: 1000, output: 200, cost: 0.02, tools: 2 },
        { phase: 'explore', model: 'anthropic/claude-opus-5.5', input: 500, output: 100, cost: '0.01', tools: 1 },
        { phase: 'draft', model: 'anthropic/claude-sonnet-5', input: 2000, output: 800, cost: 0.03, tools: 0 },
      ]),
      at('09:05:00'),
    )
    await h.next()
    await stopWith(h)
    const trace = await readTrace(h.folder, h.runId)
    const span = trace.step('spec-writer')
    expect({
      input: trace.sum(span, 'aspira.tokens.input'),
      output: trace.sum(span, 'aspira.tokens.output'),
      cost: trace.sum(span, 'aspira.cost_usd'),
      partial: attr(span, 'aspira.partial'),
      scoped: trace.subtree(span).some((each) => typeof attr(each, 'aspira.usage_scope') === 'string'),
    }).toEqual({ input: 3500, output: 1100, cost: 0.06, partial: true, scoped: true })
  }, SLOW)

  it('gives the code-analyzer step span the summed tokens and cost of its .static-analysis/usage.json', async () => {
    const h = await project({ status: 'In Progress: Implementation', mode: 'cloud', files: kitVersions() })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    h.setNow(at('09:00:00'))
    const step = await h.advance({ gate: gatePasses(h) }, await h.start())
    h.setNow(at('09:10:00'))
    await reportUsage(h, step.stage, 'clean', null)
    const turn = (round: number, input: number, output: number, cost: number) => ({ round, batch: 1, model: 'anthropic/claude-sonnet-5', turn: round, startedMs: round * 1000, durationMs: 900, status: 'completed', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }, providerMetadata: { gateway: { cost } }, text: 'fixed it', toolCalls: [] })
    await put(join(h.repo, '.static-analysis/usage.json'), JSON.stringify({ scope: 'fix calls', model: 'anthropic/claude-sonnet-5', turns: [turn(1, 400, 50, 0.004), turn(2, 600, 70, 0.006)] }), at('09:05:00'))
    await h.next()
    await stopWith(h)
    const trace = await readTrace(h.folder, h.runId)
    const span = trace.step('code-analyzer')
    expect({ stage: step.stage?.step, input: trace.sum(span, 'aspira.tokens.input'), output: trace.sum(span, 'aspira.tokens.output'), cost: trace.sum(span, 'aspira.cost_usd') }).toEqual({ stage: 'code-analyzer', input: 1000, output: 120, cost: 0.01 })
  }, SLOW)

  it('gives each pr-reviewer step span its own review’s usage.jsonl numbers and the model from pr-reviewer’s model map', async () => {
    const h = await project({ status: 'In Review: Implementation', mode: 'cloud', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, ...kitVersions() } })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const usage = join(h.folder, 'pr-review/usage.jsonl')
    h.setNow(at('09:00:00'))
    const first = await h.advance({}, await h.start())
    h.setNow(at('09:05:00'))
    const review = await toReview(h, first)
    h.setNow(at('09:15:00'))
    await reportUsage(h, review.stage, 'complete', null, { findings: high(1) })
    await put(
      usage,
      usageLines([
        { agent: 'ava', input: 100, output: 10, startedAt: at('09:06:00'), at: at('09:06:30') },
        { agent: 'quinn', input: 200, output: 20, startedAt: at('09:07:00'), at: at('09:07:30') },
      ]),
      at('09:14:00'),
    )
    const fixStage = await h.advance()
    h.setNow(at('09:20:00'))
    await h.write('src/a.ts', 'export const a = 2\n')
    await h.answer(fixStage.stage, { decisions: [], usage: { tokens: 400, wallMs: 300000 } })
    const second = await h.advance()
    h.setNow(at('09:30:00'))
    await reportUsage(h, second.stage, 'complete', null, { findings: [] })
    await put(
      usage,
      usageLines([
        { agent: 'ava', input: 1000, output: 100, startedAt: at('09:21:00'), at: at('09:21:30') },
        { agent: 'quinn', input: 2000, output: 200, startedAt: at('09:22:00'), at: at('09:22:30') },
      ]),
      at('09:29:00'),
    )
    await h.advance()
    const trace = await readTrace(h.folder, h.runId)
    const reviews = trace.steps.filter((span) => span.name === 'pr-reviewer')
    const models = (span: Span | undefined) => trace.subtree(span).flatMap((each) => each.attributes.filter((attribute) => attribute.key.includes('model')).map((attribute) => valueOf(attribute.value)))
    expect({
      inputs: reviews.map((span) => trace.sum(span, 'aspira.tokens.input')),
      outputs: reviews.map((span) => trace.sum(span, 'aspira.tokens.output')),
      models: reviews.map((span) => ['anthropic/claude-opus-5.5', 'openai/gpt-6-luna'].every((model) => models(span).includes(model))),
    }).toEqual({ inputs: [300, 3000], outputs: [30, 300], models: [true, true] })
  }, SLOW)

  it('gives the implementor span a duration and lists its tokens, tool calls and cost as not measured', async () => {
    const h = await project({ status: 'Ready: Plan', mode: 'cloud', files: kitVersions() })
    h.setNow(at('09:00:00'))
    const step = await h.advance({}, await h.start())
    h.setNow(at('09:10:00'))
    await reportUsage(h, step.stage, 'complete', null)
    await h.next()
    await stopWith(h)
    const trace = await readTrace(h.folder, h.runId)
    const span = trace.step('implementor')
    const missing = notMeasured(span)
    expect({ duration: durationOf(span), tokens: missing.some((key) => key.includes('tokens')), toolCalls: missing.some((key) => key.includes('tool')), cost: missing.some((key) => key.includes('cost')) }).toEqual({
      duration: 600_000,
      tokens: true,
      toolCalls: true,
      cost: true,
    })
  }, SLOW)

  it('times a planner span only, with gap stale when its usage.json was written before the step and gap missing when there is none', async () => {
    const outcomes = []
    for (const variant of ['stale', 'missing'] as const) {
      const h = await project({ status: 'Ready: Spec', mode: 'cloud', files: kitVersions() })
      h.setNow(at('09:00:00'))
      const step = await h.advance({}, await h.start())
      h.setNow(at('09:10:00'))
      await reportUsage(h, step.stage, 'ready', null)
      if (variant === 'stale') await put(join(h.folder, 'plan.review/trace/usage.json'), usageJson([{ phase: 'plan', model: 'anthropic/claude-opus-5.5', input: 900, output: 90, cost: 0.02, tools: 1 }]), at('08:00:00'))
      await h.next()
      await stopWith(h)
      const trace = await readTrace(h.folder, h.runId)
      const span = trace.step('planner')
      outcomes.push({ gap: attr(span, 'aspira.gap'), duration: durationOf(span), tokens: trace.sum(span, 'aspira.tokens.input') })
    }
    expect(outcomes).toEqual([
      { gap: 'stale', duration: 600_000, tokens: 0 },
      { gap: 'missing', duration: 600_000, tokens: 0 },
    ])
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T27: state and step reports written before this change.
// ---------------------------------------------------------------------------------------------
