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
//     `.claude/skills/aspira-<step>/.kit-version` is missing or differs from this package's version.
// Span attributes read here: aspira.status, aspira.duration_ms, aspira.orchestration.duration_ms,
// aspira.segment, aspira.not_measured, aspira.gap, aspira.partial, aspira.usage_scope,
// aspira.tokens.input, aspira.tokens.output, aspira.tokens.total, aspira.cost_usd, and a model attribute.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PR_URL, SLUG, cleanup, ofKind, project, worktreeFor, writeStepExport, type Result, type Stage } from './driver.test-helper.ts'
import {
  SLOW,
  VERSION,
  kitVersions,
  RULES_WITH_TELEMETRY,
  at,
  SOURCE,
  high,
  attr,
  numberAttr,
  notMeasured,
  statusOf,
  durationOf,
  tree,
  telemetryDir,
  telemetryFiles,
  readTrace,
  reportUsage,
  summaryWith,
  gatePasses,
  stopWith,
  toReview,
  put,
} from './telemetry.integration.shared.ts'

afterAll(cleanup)

describe('KIT-19 T23 F6 F7 F8 F14: one telemetry file for a build-feature run with a review, a fix and a second review', () => {
  // 09:00 start, Step 10 answered at 09:05 (review 1 printed), review 1 reported at 09:15 (fix printed),
  // fix answered at 09:20 (review 2 printed), review 2 reported at 09:30, Build Summary push answered at 09:40.
  const seen: { runId?: string; files: string[]; trace: Awaited<ReturnType<typeof readTrace>>; telemetry?: Stage; attached: string | null } = { files: [], trace: tree([]), attached: null }

  beforeAll(async () => {
    const h = await project({ status: 'In Review: Implementation', pr: PR_URL, existingPr: PR_URL, pushed: true, files: { ...SOURCE, ...kitVersions() } })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    h.setNow(at('09:00:00'))
    const first = await h.advance({}, await h.start())
    h.setNow(at('09:05:00'))
    const review = await toReview(h, first)
    h.setNow(at('09:15:00'))
    const subagents = [
      { label: 'Read the diff', startedAt: at('09:06:00'), endedAt: at('09:09:00'), totalTokens: 3000, toolUses: 7, wallMs: 180000 },
      { label: 'Check the tests', startedAt: at('09:09:00'), endedAt: at('09:12:00'), totalTokens: 2000, toolUses: 5, wallMs: 180000 },
    ]
    await reportUsage(h, review.stage, 'complete', { tokens: 4000, wallMs: 600000, toolUses: 3, subagents }, { findings: high(1) })
    const fixStage = await h.advance()
    h.setNow(at('09:20:00'))
    await h.write('src/a.ts', 'export const a = 2\n')
    await h.answer(fixStage.stage, { decisions: [], usage: { tokens: 400, wallMs: 300000 } })
    const second = await h.advance()
    h.setNow(at('09:30:00'))
    await reportUsage(h, second.stage, 'complete', { tokens: 3000, wallMs: 600000 }, { findings: [] })
    const telemetry = await h.advance({ summary: summaryWith(h, RULES_WITH_TELEMETRY, at('09:40:00')) })
    if (telemetry.stage?.stage === 'telemetry') {
      seen.telemetry = telemetry.stage
      await h.answer(telemetry.stage, { attached: true, blockId: 'b1' })
      await h.next()
    }
    seen.runId = h.runId
    seen.files = await telemetryFiles(h.folder)
    seen.trace = await readTrace(h.folder, h.runId)
    const record = await readFile(join(h.folder, '.local/telemetry/attached', `${h.runId}.json`), 'utf8').catch(() => null)
    const parsed = record === null ? null : z.looseObject({ blockId: z.string() }).safeParse(JSON.parse(record))
    seen.attached = parsed?.success === true ? parsed.data.blockId : null
  }, SLOW)

  it('leaves exactly one <runId>.json in telemetry/ and no file for any other run id', () => {
    expect(seen.files).toEqual([`${seen.runId}.json`])
  })

  it('makes the root duration the step spans plus the orchestration time, which is the sum of its segments', () => {
    const { root, steps, orchestration, childrenOf } = seen.trace
    const segments = childrenOf(orchestration).filter((span) => attr(span, 'aspira.segment') === true)
    expect({
      root: durationOf(root),
      steps: steps.map((span) => durationOf(span)),
      orchestration: numberAttr(orchestration, 'aspira.orchestration.duration_ms'),
      segments: segments.reduce((total, span) => total + (durationOf(span) ?? 0), 0),
    }).toEqual({ root: 2_400_000, steps: [600_000, 600_000], orchestration: 1_200_000, segments: 1_200_000 })
  })

  it('places the fix under the orchestration segment it ran in, not under the orchestration span or a step', () => {
    const { spans, parentOf, orchestration, steps } = seen.trace
    const fixes = spans.filter((span) => span.name === 'fix')
    const parent = fixes[0] === undefined ? undefined : parentOf(fixes[0])
    expect({ fixes: fixes.length, segment: attr(parent, 'aspira.segment'), orchestration: parent !== undefined && parent === orchestration, step: steps.some((span) => span === parent), parentDuration: durationOf(parent) }).toEqual({
      fixes: 1,
      segment: true,
      orchestration: false,
      step: false,
      parentDuration: 300_000,
    })
  })

  it('lists the orchestration span’s tokens as not measured and gives it a duration', () => {
    const { orchestration } = seen.trace
    expect({ tokens: notMeasured(orchestration).some((key) => key.includes('tokens')), duration: typeof numberAttr(orchestration, 'aspira.orchestration.duration_ms') }).toEqual({ tokens: true, duration: 'number' })
  })

  it('prints a telemetry stage that writes only to the ticket, and records the block the session attached', () => {
    expect({ notion: seen.telemetry?.notion, attached: seen.attached }).toEqual({ notion: [{ op: 'write', target: 'ticket' }], attached: 'b1' })
  })
})

// ---------------------------------------------------------------------------------------------
// T24: --parent-run on the printed step command only.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T25 F6 F22: a run refuses before its first step when the step skills are from another kit version', () => {
  it('exits 1 naming both versions, with no step stage and no step record, when a step skill is from kit 0.0.1', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    await h.write('.claude/skills/aspira-planner/.kit-version', '0.0.1\n')
    const result = await h.advance({}, await h.start())
    const steps = existsSync(join(h.stateDir, 'state.json')) ? ((await h.state()).steps ?? []) : []
    expect({ code: result.code, said: result.text.includes(`step skills are from kit 0.0.1, the driver is ${VERSION}: run kit init`), stepStages: ofKind(h.stages, 'step').length, steps }).toEqual({
      code: 1,
      said: true,
      stepStages: 0,
      steps: [],
    })
  }, SLOW)

  it('exits 1 naming the missing .kit-version, with no step stage and no step record, when a step skill has none', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    await rm(join(h.repo, '.claude/skills/aspira-planner/.kit-version'), { force: true })
    const result = await h.advance({}, await h.start())
    const steps = existsSync(join(h.stateDir, 'state.json')) ? ((await h.state()).steps ?? []) : []
    expect({ code: result.code, named: result.text.includes('aspira-planner/.kit-version'), stepStages: ofKind(h.stages, 'step').length, steps }).toEqual({ code: 1, named: true, stepStages: 0, steps: [] })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T26: cloud steps read their agent's usage file when the step is accepted.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T27 F9 F22: an earlier run state and step reports in three shapes', () => {
  const EARLIER = 'run-20261011T090000Z'
  const OLD_STATE = {
    runs: [{ runId: EARLIER, command: '/aspira-build-feature KIT-11 --local', startedAt: '2026-10-11T09:00:00.000Z', endedAt: '2026-10-11T10:00:00.000Z', ended: 'stopped', mode: 'local', end: { message: 'stopped by hand', stopped: true } }],
    inProgress: null,
    approvals: [{ runId: EARLIER, notionUserId: 'user-1', name: 'Ada Approver', at: '2026-10-11T09:00:00.000Z', command: '/aspira-build-feature KIT-11 --local' }],
    moves: [],
    steps: [{ step: 'groomer', runId: EARLIER, command: '/aspira-groomer KIT-11 --local --take-recommended', status: 'confirmed', startedAt: '2026-10-11T09:00:00.000Z', endedAt: '2026-10-11T09:30:00.000Z', usage: { tokens: 700, wallMs: 1800000 }, resultLine: 'groomer: confirmed', nonce: '00000000-0000-4000-8000-000000000000' }],
    takenKeys: [],
    asked: [],
    reviews: [],
    remaining: [],
    failure: null,
    step8: { pushed: false, prUrl: null, prPropertySet: false, moved: false },
    step10: { committed: false, changeset: null, docsToPropagate: null, releaseRow: null },
    pending: null,
    card: null,
    overrides: [],
    queue: [],
    afterAsks: null,
    phases: {},
  }
  const seen: { after: string[]; runId?: string; files: string[]; trace: Awaited<ReturnType<typeof readTrace>>; implementorStatus?: unknown } = { after: [], files: [], trace: tree([]) }
  const label = (result: Result) => (result.stage?.stage === 'step' ? String(result.stage.step) : String(result.stage?.stage ?? 'no stage'))

  beforeAll(async () => {
    const h = await project({ status: 'Ready: Idea', files: kitVersions() })
    await put(join(h.stateDir, 'state.json'), `${JSON.stringify(OLD_STATE, null, 2)}\n`)
    h.setNow(at('10:00:00'))
    const writer = await h.advance({}, await h.start())
    h.setNow(at('10:10:00'))
    await reportUsage(h, writer.stage, 'ready', {
      tokens: 2000,
      wallMs: 600000,
      toolUses: 12,
      model: 'anthropic/claude-opus-5.5',
      subagents: [
        { label: 'Explore the repository at /Users/x/repo', startedAt: at('10:01:00'), endedAt: at('10:04:00'), totalTokens: 3000, toolUses: 20, wallMs: 180000, model: 'anthropic/claude-sonnet-5' },
        { label: 'Draft the spec', startedAt: at('10:05:00'), endedAt: at('10:08:00'), totalTokens: 1500, toolUses: 3, wallMs: 180000 },
      ],
    })
    const planner = await h.advance()
    seen.after.push(label(planner))
    h.setNow(at('10:20:00'))
    await reportUsage(h, planner.stage, 'ready', { tokens: 1000, wallMs: 540000 })
    const implementor = await h.advance()
    seen.after.push(label(implementor))
    h.setNow(at('10:30:00'))
    await reportUsage(h, implementor.stage, 'complete', { tokens: 'lots', subagents: [{ label: 'lane A', totalTokens: 10 }, { label: 'lane B', totalTokens: 'many' }] })
    // With no gate commands in the fixture, the step after the implementor is the code-analyzer (as driver test T26 pins).
    const next = await h.advance()
    seen.after.push(label(next))
    seen.implementorStatus = ((await h.state()).steps ?? []).find((record) => record.step === 'implementor')?.status
    h.setNow(at('10:40:00'))
    await stopWith(h)
    seen.runId = h.runId
    seen.files = await telemetryFiles(h.folder)
    seen.trace = await readTrace(h.folder, h.runId)
  }, SLOW)

  it('loads the earlier state and goes on after every report', () => {
    expect(seen.after).toEqual(['planner', 'implementor', 'code-analyzer'])
  })

  it('puts each reported subagent once under its step with the start and end the session recorded', () => {
    const { step, childrenOf } = seen.trace
    expect(childrenOf(step('spec-writer')).map((span) => ({ name: span.name, start: span.startTimeUnixNano, end: span.endTimeUnixNano }))).toEqual([
      { name: 'subagent-1', start: '1791799260000000000', end: '1791799440000000000' },
      { name: 'subagent-2', start: '1791799500000000000', end: '1791799680000000000' },
    ])
  })

  it('gives the {tokens, wallMs} step span its total tokens and duration, with input, output, tool calls and cost not measured', () => {
    const span = seen.trace.step('planner')
    const missing = notMeasured(span)
    expect({ total: numberAttr(span, 'aspira.tokens.total'), duration: durationOf(span), missing: ['input', 'output', 'tool', 'cost'].map((part) => missing.some((key) => key.includes(part))) }).toEqual({
      total: 1000,
      duration: 600_000,
      missing: [true, true, true, true],
    })
  })

  it('marks the malformed usage step gap invalid and keeps its status', () => {
    expect({ gap: attr(seen.trace.step('implementor'), 'aspira.gap'), status: seen.implementorStatus }).toEqual({ gap: 'invalid', status: 'ready' })
  })

  it('writes no telemetry file for the earlier run', () => {
    expect(seen.files).toEqual([`${seen.runId}.json`])
  })
})

// ---------------------------------------------------------------------------------------------
// T28: run boundaries.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T28 F13: one file per run id, written once when that run ends', () => {
  const seen: { first?: string; second?: string; afterFirst: string[]; afterSecond: string[]; before: string; afterFinish: string; secondSteps: string[] } = { afterFirst: [], afterSecond: [], before: '', afterFinish: '', secondSteps: [] }

  beforeAll(async () => {
    const h = await project({ status: 'Ready: Idea', files: kitVersions() })
    h.setNow(at('09:00:00'))
    const writer = await h.advance({}, await h.start())
    h.setNow(at('09:10:00'))
    await h.report(writer.stage, 'ready')
    const planner = await h.advance()
    h.setNow(at('09:20:00'))
    await h.report(planner.stage, 'ready')
    await h.next()
    h.setNow(at('09:30:00'))
    await stopWith(h)
    seen.first = h.runId
    seen.afterFirst = await telemetryFiles(h.folder)
    const file = join(telemetryDir(h.folder), `${seen.first}.json`)
    seen.before = await readFile(file, 'utf8').catch(() => '')
    h.setNow(at('09:40:00'))
    await h.finish()
    seen.afterFinish = await readFile(file, 'utf8').catch(() => '')
    h.setNow(at('10:00:00'))
    const implementor = await h.advance({}, await h.start())
    h.setNow(at('10:10:00'))
    await h.report(implementor.stage, 'complete')
    await h.next()
    h.setNow(at('10:20:00'))
    await stopWith(h)
    seen.second = h.runId
    seen.afterSecond = await telemetryFiles(h.folder)
    seen.secondSteps = (await readTrace(h.folder, seen.second)).steps.map((span) => span.name)
  }, SLOW)

  it('writes one file for a run continued with --run across steps', () => {
    expect(seen.afterFirst).toEqual([`${seen.first}.json`])
  })

  it('writes a second file under a new run id holding only the resumed run’s steps', () => {
    expect({ fresh: seen.second !== seen.first, files: seen.afterSecond, steps: seen.secondSteps }).toEqual({ fresh: true, files: [`${seen.first}.json`, `${seen.second}.json`].sort(), steps: ['implementor'] })
  })

  it('leaves the file’s bytes unchanged on --finish of the ended run', () => {
    expect({ written: seen.before !== '', unchanged: seen.afterFinish === seen.before }).toEqual({ written: true, unchanged: true })
  })

  it('writes the replaced run’s file, root status replaced, when --force-run replaces a run in progress', async () => {
    const h = await project({ status: 'Ready: Plan', files: kitVersions() })
    h.setNow(at('09:00:00'))
    await h.advance({}, await h.start())
    const replaced = h.runId
    h.setNow(at('10:00:00'))
    await h.start(['--force-run'])
    const trace = await readTrace(h.folder, replaced)
    expect({ files: await telemetryFiles(h.folder), status: attr(trace.root, 'aspira.status') }).toEqual({ files: [`${replaced}.json`], status: 'replaced' })
  }, SLOW)

  it('writes a run that moved into the worktree only in the worktree’s ticket folder, leaving no file or marker in the main checkout', async () => {
    const h = await project({ status: 'Ready: Spec', layout: 'checkout', mainFiles: kitVersions() })
    const mainFolder = h.folder
    await mkdir(mainFolder, { recursive: true })
    await writeFile(join(mainFolder, 'spec.md'), '# X\n\n## Acceptance criteria\n\n- [ ] F1: it works.\n')
    h.setNow(at('09:00:00'))
    const moved = await h.advance({}, await h.start())
    h.cd(String(moved.stage?.worktree ?? worktreeFor(h.main)))
    await h.answer(moved.stage, {})
    const step = await h.advance()
    h.setNow(at('09:10:00'))
    await h.report(step.stage, 'ready')
    await h.next()
    h.setNow(at('09:20:00'))
    await stopWith(h)
    const markers = existsSync(join(mainFolder, '.local')) ? (await readdir(join(mainFolder, '.local'), { recursive: true })).filter((path) => path.endsWith('.pending')) : []
    expect({ worktree: h.folder === join(worktreeFor(h.main), '.work', SLUG), main: await telemetryFiles(mainFolder), markers, files: await telemetryFiles(h.folder) }).toEqual({
      worktree: true,
      main: [],
      markers: [],
      files: [`${h.runId}.json`],
    })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T29, T30: attach failures and the BOARD-003 gate.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T29 F16: a telemetry failure never changes how the run ends', () => {
  it('ends the run as it would have, adding the Telemetry not attached line, when the attach fails', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage, 'ready')
    await h.next()
    const telemetry = await stopWith(h, { summary: summaryWith(h, RULES_WITH_TELEMETRY) })
    if (telemetry.stage?.stage === 'telemetry') await h.answer(telemetry.stage, { error: 'upload failed' })
    const end = telemetry.stage?.stage === 'telemetry' ? await h.next() : telemetry
    const run = ((await h.state()).runs ?? []).find((record) => record.runId === h.runId)
    const message = String(end.stage?.message ?? '')
    expect({ telemetry: telemetry.stage?.stage, end: end.stage?.stage, notice: message.includes('Telemetry not attached: upload failed; the file is at'), file: message.includes(`${h.runId}.json`), ended: run?.ended, stopped: end.stage?.stopped }).toEqual({
      telemetry: 'telemetry',
      end: 'end',
      notice: true,
      file: true,
      ended: 'stopped',
      stopped: true,
    })
  }, SLOW)

  it('still writes the file of a run stopped with no aspira.json, saying it was not attached, with no telemetry stage', async () => {
    const h = await project({ status: 'Ready: Spec', aspira: null, files: kitVersions() })
    const end = await h.advance({}, await h.start())
    expect({ end: end.stage?.stage, files: await telemetryFiles(h.folder), telemetry: ofKind(h.stages, 'telemetry').length, notice: String(end.stage?.message ?? '').includes('Telemetry not attached') }).toEqual({
      end: 'end',
      files: [`${h.runId}.json`],
      telemetry: 0,
      notice: true,
    })
  }, SLOW)
})

describe('KIT-19 T30 F14: the attach follows BOARD-003 and happens once per run', () => {
  it('prints no telemetry stage and says the file was not attached when BOARD-003 does not list the run telemetry file', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    const step = await h.advance({}, await h.start())
    await h.report(step.stage, 'ready')
    await h.next()
    const end = await stopWith(h)
    expect({ end: end.stage?.stage, telemetry: ofKind(h.stages, 'telemetry').length, notice: String(end.stage?.message ?? '').includes('Telemetry not attached'), files: await telemetryFiles(h.folder) }).toEqual({
      end: 'end',
      telemetry: 0,
      notice: true,
      files: [`${h.runId}.json`],
    })
  }, SLOW)

  it('writes the file but prints no telemetry stage for a run whose attach is already recorded', async () => {
    const h = await project({ status: 'Ready: Spec', files: kitVersions() })
    const step = await h.advance({}, await h.start())
    await put(join(h.folder, '.local/telemetry/attached', `${h.runId}.json`), JSON.stringify({ runId: h.runId, blockId: 'b0' }))
    await h.report(step.stage, 'ready')
    await h.next()
    const end = await stopWith(h, { summary: summaryWith(h, RULES_WITH_TELEMETRY) })
    expect({ end: end.stage?.stage, telemetry: ofKind(h.stages, 'telemetry').length, files: await telemetryFiles(h.folder) }).toEqual({ end: 'end', telemetry: 0, files: [`${h.runId}.json`] })
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// T31: a partial code-analyzer step.
// ---------------------------------------------------------------------------------------------

describe('KIT-19 T31 F20: status words map to the OTLP status code', () => {
  const seen: { trace: Awaited<ReturnType<typeof readTrace>>; end?: string } = { trace: tree([]) }

  beforeAll(async () => {
    const h = await project({ status: 'In Progress: Implementation', files: kitVersions() })
    await writeStepExport(h.folder, h.repo, 'implementor', 'complete')
    const step = await h.advance({ gate: gatePasses(h) }, await h.start())
    await h.report(step.stage, 'partial')
    const end = await h.advance()
    seen.end = end.stage?.stage
    seen.trace = await readTrace(h.folder, h.runId)
  }, SLOW)

  it('records the code-analyzer step that ended partial (now incomplete, KIT-2) as aspira.status incomplete with code ERROR', () => {
    const span = seen.trace.step('code-analyzer')
    expect({ status: attr(span, 'aspira.status'), code: statusOf(span) }).toEqual({ status: 'incomplete', code: 'ERROR' })
  })

  it('gives the root span of a run that ended stopped the code ERROR', () => {
    expect({ end: seen.end, status: attr(seen.trace.root, 'aspira.status'), code: statusOf(seen.trace.root) }).toEqual({ end: 'end', status: 'stopped', code: 'ERROR' })
  })
})
