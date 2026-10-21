// The Build Summary renderer (the exported renderBuildSummary), from literal run-state fixtures:
// redaction and quoting of command output and card text, the fixed section order, the ordering of
// blocking findings and the timeline, Mermaid sections, and the cost table with missing usage.
// KIT-11 plan P5: T37-T39. The run-state shape is the one P9's runStateSchema records.

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { renderBuildSummary } from '#src/summary.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function repo(env: Record<string, string> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-summary-')))
  temps.push(dir)
  const lines = Object.entries(env).map(([name, value]) => `${name}=${value}`)
  if (lines.length > 0) await writeFile(join(dir, '.env.local'), `${lines.join('\n')}\n`)
  return dir
}

const RUN = 'run-20261012T090000Z'
const ticket = (title = 'X') => ({ id: 'KIT-11', title, url: 'https://app.notion.com/p/kit-11-x-0000000000000000000000000011' })
const decision = (id: string, question: string) => ({ id, question, options: ['Option A', 'Option B'], recommended: 'Option A', reasoning: 'It matches the code', whyYours: 'It changes the product', decidedBy: 'agent' as const, answer: 'Option A' })
const step = (name: string, startedAt: string, endedAt: string, usage: { tokens: number | null; wallMs: number | null } | null, status = 'complete') => ({ step: name, runId: RUN, command: `/aspira-${name} KIT-11 --local`, status, startedAt, endedAt, usage })

/** A run state as the driver records it; every collection empty unless the test fills it. */
function runState(fill: Record<string, unknown> = {}) {
  return {
    runs: [{ runId: RUN, command: '/aspira-build-feature KIT-11', startedAt: '2026-10-12T09:00:00.000Z', endedAt: '2026-10-12T12:00:00.000Z', ended: 'stopped', mode: 'local' as const, autonomous: false }],
    inProgress: null,
    approvals: [{ runId: RUN, notionUserId: 'user-1', name: 'Ada Approver', at: '2026-10-12T09:00:00.000Z', command: '/aspira-build-feature KIT-11' }],
    moves: [],
    steps: [],
    takenKeys: [],
    asked: [],
    reviews: [],
    remaining: [],
    failure: null,
    step8: { pushed: false, prUrl: null, prPropertySet: false, moved: false },
    step10: { committed: false, changeset: null, docsToPropagate: null, releaseRow: null },
    pending: null,
    ...fill,
  }
}

const PLAN = {
  summary: 'Build X.',
  tasks: [
    { id: 'P1', title: 'Write the tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/feature.test.ts', symbols: ['feature'], instructions: 'Add it.', evidence: ['src/app.ts:1'] }], commands: [], outcome: 'Red.' },
    { id: 'P2', title: 'Build it', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/feature.ts', symbols: ['feature'], instructions: 'Add it.', evidence: ['src/app.ts:1'] }], commands: [], outcome: 'Green.' },
  ],
  tests: [{ id: 'T1', kind: 'unit', path: 'src/feature.test.ts', featureIds: ['F1'], setup: 'none', action: 'call it', assertions: ['it works'] }],
  checks: [],
  decisions: [],
  gaps: [],
}

/** The `## ` sections in order, each with its heading and body. */
function sections(markdown: string): { heading: string; body: string }[] {
  const parts = markdown.split(/^(?=## )/m).filter((part) => part.startsWith('## '))
  return parts.map((part) => {
    const [heading = '', ...body] = part.split('\n')
    return { heading: heading.slice(3), body: body.join('\n') }
  })
}

const ORDER = [/status/i, /decisions taken for you/i, /tests written/i, /deviations and assumptions/i, /cost and time/i, /architecture/i, /step timeline/i]
const section = (markdown: string, heading: RegExp) => sections(markdown).find((entry) => heading.test(entry.heading))?.body ?? ''

describe('T37 F37: command output and card text are quoted safely', () => {
  const gateOutput = Array.from({ length: 60 }, (_, index) => {
    const n = index + 1
    const line = `gate-out-${String(n).padStart(2, '0')}`
    if (n === 45) return `${line} token ghp_abc123`
    if (n === 50) return `${line} Authorization: Bearer xyz`
    if (n === 55) return `${line} DATABASE_PASSWORD leaked sup3r-s3cret-value`
    return line
  }).join('\n')
  const failed = runState({ failure: { action: 'gate', command: 'pnpm check', exitCode: 1, output: gateOutput } })

  it('quotes only the last 40 lines of a failing command output', async () => {
    const summary = await renderBuildSummary({ ticket: ticket(), state: failed, repo: await repo() })
    const shown = Array.from({ length: 60 }, (_, index) => summary.includes(`gate-out-${String(index + 1).padStart(2, '0')}`))
    expect({ dropped: shown.slice(0, 20).filter(Boolean).length, kept: shown.slice(20).filter(Boolean).length }).toEqual({ dropped: 0, kept: 40 })
  }, 30_000)

  it('shows tokens, bearer values and .env values only as [redacted]', async () => {
    const summary = await renderBuildSummary({ ticket: ticket(), state: failed, repo: await repo({ DATABASE_PASSWORD: 'sup3r-s3cret-value' }) })
    expect({ token: summary.includes('ghp_abc123'), bearer: summary.includes('xyz'), env: summary.includes('sup3r-s3cret-value'), redacted: summary.split('[redacted]').length - 1 >= 3 }).toEqual({ token: false, bearer: false, env: false, redacted: true })
  }, 30_000)

  it('quotes the card title as escaped text, not as HTML or markdown', async () => {
    const summary = await renderBuildSummary({ ticket: ticket('Cart <script>alert(1)</script> **bold**'), state: runState(), repo: await repo() })
    expect({ html: summary.includes('<script>'), markdown: summary.includes('**bold**'), words: summary.includes('script') && summary.includes('bold') }).toEqual({ html: false, markdown: false, words: true })
  }, 30_000)
})

describe('T38 F38 F39: section order, blocking items first, Mermaid sections', () => {
  const filled = runState({
    steps: [
      step('implementor', '2026-10-12T10:00:00.000Z', '2026-10-12T10:40:00.000Z', { tokens: 800, wallMs: 2400000 }),
      step('planner', '2026-10-12T09:00:00.000Z', '2026-10-12T09:20:00.000Z', { tokens: 1200, wallMs: 1200000 }),
      step('code-analyzer', '2026-10-12T11:00:00.000Z', '2026-10-12T11:05:00.000Z', { tokens: 300, wallMs: 300000 }),
    ],
    takenKeys: [
      { key: `planner:${RUN}:D1`, step: 'planner', runId: RUN, decision: decision('D1', 'Should the summary list costs per step?') },
      { key: `implementor:${RUN}:A1`, step: 'implementor', runId: RUN, decision: decision('A1', 'Should the gate run in the app directory?') },
    ],
    reviews: [{ n: 1, headSha: 'bbbbbbb', critical: 1, high: 1, runId: RUN }],
    remaining: [
      { id: 'H2', severity: 'high', title: 'The retry never stops' },
      { id: 'C1', severity: 'critical', title: 'The token is logged' },
    ],
  })
  const render = async () => renderBuildSummary({ ticket: ticket(), state: filled, repo: await repo(), plan: PLAN, changedFiles: ['src/feature.ts', 'src/feature.test.ts'] })

  it('puts the sections in the fixed order', async () => {
    const headings = sections(await render()).map((entry) => entry.heading)
    const at = ORDER.map((pattern) => headings.findIndex((heading) => pattern.test(heading)))
    expect({ found: at.every((index) => index >= 0), ordered: at.every((index, position) => position === 0 || index > at[position - 1]!) }).toEqual({ found: true, ordered: true })
  }, 30_000)

  it('lists C1 before H2 and the timeline rows by start time', async () => {
    const summary = await render()
    const timeline = section(summary, /step timeline/i)
    const rows = ['planner', 'implementor', 'code-analyzer'].map((name) => timeline.indexOf(name))
    expect({ findings: summary.indexOf('C1') >= 0 && summary.indexOf('C1') < summary.indexOf('H2'), timeline: rows.every((index) => index >= 0) && rows[0]! < rows[1]! && rows[1]! < rows[2]! }).toEqual({ findings: true, timeline: true })
  }, 30_000)

  it('renders the architecture and the step timeline as mermaid blocks', async () => {
    const summary = await render()
    expect([/architecture/i, /step timeline/i].map((heading) => section(summary, heading).includes('```mermaid'))).toEqual([true, true])
  }, 30_000)
})

describe('AVA1.1 SEC-010: plan text in the architecture diagram is redacted and stays inside its fence', () => {
  it('redacts a token in a task title or file name and keeps backticks, quotes and newlines from breaking the mermaid fence', async () => {
    const hostile = {
      ...PLAN,
      tasks: [
        { ...PLAN.tasks[0]!, title: 'Break out ```\n## Injected heading\n"quoted" ghp_abc123SECRET' },
        { ...PLAN.tasks[1]!, changes: [{ ...PLAN.tasks[1]!.changes[0]!, path: 'src/ghp_def456SECRET`x`.ts' }] },
      ],
    }
    const summary = await renderBuildSummary({ ticket: ticket(), state: runState(), repo: await repo(), plan: hostile })
    const architecture = section(summary, /architecture/i)
    const fenced = /^```mermaid\n([\s\S]*?)\n```\s*$/.exec(architecture.trim())
    const body = fenced?.[1] ?? ''
    const labelled = body.split('\n').filter((line) => line.includes('["'))
    expect({
      oneFence: fenced !== null && architecture.split('```').length - 1 === 2,
      token: summary.includes('ghp_abc123SECRET') || summary.includes('ghp_def456SECRET'),
      redacted: body.split('[redacted]').length - 1 >= 2,
      injectedHeading: sections(summary).some((entry) => /injected heading/i.test(entry.heading)),
      labelsIntact: labelled.length === 4 && labelled.every((line) => /^ {2}\w+\["[^`"\n]*"\]$/.test(line)),
      label: body.includes('P1: Break out'),
    }).toEqual({ oneFence: true, token: false, redacted: true, injectedHeading: false, labelsIntact: true, label: true })
  }, 30_000)
})

describe('T39 F40 F41: cost and time, and a run with nothing finished', () => {
  it('shows not reported for missing usage, a partial total naming the excluded step, and a labelled estimate', async () => {
    const state = runState({
      steps: [
        step('planner', '2026-10-12T09:00:00.000Z', '2026-10-12T09:01:00.000Z', { tokens: 1200, wallMs: 60000 }),
        step('implementor', '2026-10-12T09:02:00.000Z', '2026-10-12T09:02:30.000Z', { tokens: 800, wallMs: 30000 }),
        step('code-analyzer', '2026-10-12T09:03:00.000Z', '2026-10-12T09:04:00.000Z', null),
      ],
    })
    const cost = section(await renderBuildSummary({ ticket: ticket(), state, repo: await repo() }), /cost and time/i).split('\n')
    expect({
      missing: cost.some((line) => line.includes('code-analyzer') && line.includes('not reported')),
      total: cost.some((line) => /\b2,?000\b/.test(line) && /partial/i.test(line) && line.includes('code-analyzer')),
      estimate: cost.some((line) => line.includes('$') && line.includes('estimate of session usage') && /list price/i.test(line)),
    }).toEqual({ missing: true, total: true, estimate: true })
  }, 30_000)

  it('keeps the status section and marks every other section empty when no step finished', async () => {
    const all = sections(await renderBuildSummary({ ticket: ticket(), state: runState(), repo: await repo() }))
    const others = ORDER.slice(1).map((pattern) => all.find((entry) => pattern.test(entry.heading))?.body.includes('None yet.') ?? false)
    expect({ status: ORDER[0]!.test(all[0]?.heading ?? ''), others }).toEqual({ status: true, others: [true, true, true, true, true, true] })
  }, 30_000)
})

// ---------------------------------------------------------------------------------------------
// KIT-19 plan P7: T21, T22. The Run telemetry table (F15, F21) and the unchanged list-price lines
// (F15, F22). The step records carry the widened usage P9 stores beside today's {tokens, wallMs}:
// `phases` (a cloud step's reduced usage groups: phase, model, inputTokens, outputTokens,
// totalTokens, toolCalls, costUsd, startedAt, endedAt) and `subagents` (a --local step's Agent-tool
// numbers per subagent: label, startedAt, endedAt, totalTokens, toolUses, wallMs). `now` is the
// time the summary stage renders at.
// ---------------------------------------------------------------------------------------------

const EARLIER = 'run-20261011T090000Z'
const SUMMARY_NOW = '2026-10-12T09:30:00.000Z'
const at = (time: string) => `2026-10-12T${time}.000Z`

/** A current run (09:00, still in progress) after an earlier stopped one. */
function telemetryState(steps: unknown[]) {
  return runState({
    runs: [
      { runId: EARLIER, command: '/aspira-build-feature KIT-11', startedAt: '2026-10-11T09:00:00.000Z', endedAt: '2026-10-11T10:00:00.000Z', ended: 'stopped', mode: 'cloud' as const, end: { message: 'stopped', stopped: true } },
      { runId: RUN, command: '/aspira-build-feature KIT-11', startedAt: at('09:00:00'), endedAt: null, ended: null, mode: 'cloud' as const },
    ],
    inProgress: { runId: RUN, startedAt: at('09:00:00') },
    steps,
  })
}

const TELEMETRY_STEPS = [
  { step: 'groomer', runId: EARLIER, command: '/aspira-groomer KIT-11', status: 'confirmed', startedAt: '2026-10-11T09:00:00.000Z', endedAt: '2026-10-11T09:10:00.000Z', usage: { tokens: 700, wallMs: 600000 } },
  {
    step: 'spec-writer',
    runId: RUN,
    command: '/aspira-spec-writer KIT-11',
    status: 'ready',
    startedAt: at('09:00:00'),
    endedAt: at('09:10:00'),
    usage: {
      tokens: 2000,
      wallMs: 600000,
      phases: [
        { phase: 'explore', model: 'anthropic/claude-opus-5.5', inputTokens: 1000, outputTokens: 200, totalTokens: 1200, toolCalls: 2, costUsd: 0.05, startedAt: at('09:00:30'), endedAt: at('09:04:00') },
        { phase: 'draft', model: 'anthropic/claude-sonnet-5', inputTokens: 500, outputTokens: 100, totalTokens: 600, toolCalls: 0, costUsd: null, startedAt: at('09:04:00'), endedAt: at('09:09:00') },
      ],
    },
  },
  { step: 'fix', runId: RUN, command: 'fix subagent for review 1', status: 'complete', startedAt: at('09:10:00'), endedAt: at('09:15:00'), usage: { tokens: 400, wallMs: 300000 } },
  {
    step: 'planner',
    runId: RUN,
    command: '/aspira-planner KIT-11 --take-recommended',
    status: 'ready',
    startedAt: at('09:15:00'),
    endedAt: at('09:25:00'),
    usage: {
      tokens: 5000,
      wallMs: 600000,
      toolUses: 6,
      subagents: [
        { label: 'subagent-1', startedAt: at('09:16:00'), endedAt: at('09:20:00'), totalTokens: 3000, toolUses: 10, wallMs: 240000 },
        { label: 'subagent-2', startedAt: at('09:20:00'), endedAt: at('09:24:00'), totalTokens: 1000, toolUses: 4, wallMs: 240000 },
      ],
    },
  },
]

type TableRow = { label: string; indented: boolean; cells: Record<string, string> }

// A cell's indentation: anything before the label beyond the one space a markdown cell starts with.
const INDENT = /^(?:&nbsp;|&ensp;|&emsp;|[\s\u00a0\u2002\u2003\u21b3\u2514\u251c\u2500\u2022\u00b7>*_-])+/

/** The rows of the Run telemetry table, each with its label, whether it is indented, and its cells by column header. */
function telemetryTable(markdown: string): TableRow[] {
  const lines = section(markdown, /run telemetry/i)
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
  const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  const [header, ...rest] = lines
  if (header === undefined) return []
  const columns = cellsOf(header).map((cell) => cell.trim())
  return rest
    .filter((line) => !/^\|?\s*:?-{3,}/.test(line.trim()))
    .map((line) => {
      const cells = cellsOf(line)
      const raw = (cells[0] ?? '').replace(/^ /, '').trimEnd()
      const label = raw.replace(INDENT, '').trim()
      return { label, indented: label !== raw, cells: Object.fromEntries(columns.map((column, index) => [column, (cells[index] ?? '').trim()])) }
    })
}

const firstWord = (label: string) => label.split(/\s+/)[0] ?? ''
const rowNamed = (rows: readonly TableRow[], name: string) => rows.find((row) => firstWord(row.label) === name)

/** A duration cell such as 10m0s, 1h2m3s or 45s, in milliseconds. */
function durationMs(cell: string | undefined): number | null {
  const match = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?/.exec(cell ?? '')
  if (match === null || match[0].trim() === '') return null
  const [, hours = '0', minutes = '0', seconds = '0'] = match
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Math.round(Number(seconds) * 1000)
}

/** The first number in a cell, without thousands separators or a dollar sign. */
function numberIn(cell: string | undefined): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec((cell ?? '').replace(/[$,]/g, ''))
  return match === null ? null : Number(match[0])
}

async function renderAt(steps: unknown[]) {
  const input = { ticket: ticket(), state: telemetryState(steps), repo: await repo(), now: SUMMARY_NOW }
  return renderBuildSummary(input)
}

describe('KIT-19 T21 F15 F21: the Run telemetry table', () => {
  it('follows Cost and time and lists each step with its children indented, then Orchestration with the fix, then Total', async () => {
    const summary = await renderAt(TELEMETRY_STEPS)
    const headings = sections(summary).map((entry) => entry.heading)
    const rows = telemetryTable(summary)
    expect({
      afterCost: headings.findIndex((heading) => /run telemetry/i.test(heading)) === headings.findIndex((heading) => /cost and time/i.test(heading)) + 1,
      rows: rows.map((row) => firstWord(row.label)),
      indented: rows.filter((row) => row.indented).map((row) => firstWord(row.label)),
    }).toEqual({
      afterCost: true,
      rows: ['spec-writer', 'explore', 'draft', 'planner', 'subagent-1', 'subagent-2', 'Orchestration', 'fix', 'Total'],
      indented: ['explore', 'draft', 'subagent-1', 'subagent-2', 'fix'],
    })
  }, 30_000)

  it('shows the fix once, under Orchestration, and leaves out the earlier run’s step', async () => {
    const rows = telemetryTable(await renderAt(TELEMETRY_STEPS))
    const labels = rows.map((row) => firstWord(row.label))
    expect({ fixes: labels.filter((label) => label === 'fix').length, underOrchestration: labels.indexOf('fix') === labels.indexOf('Orchestration') + 1, groomer: labels.includes('groomer') }).toEqual({
      fixes: 1,
      underOrchestration: true,
      groomer: false,
    })
  }, 30_000)

  it('totals the steps and Orchestration to the summary time, labelled to summary, and sums each span’s own tokens once', async () => {
    const rows = telemetryTable(await renderAt(TELEMETRY_STEPS))
    const total = rowNamed(rows, 'Total')
    expect({
      durations: ['spec-writer', 'planner', 'Orchestration', 'Total'].map((name) => durationMs(rowNamed(rows, name)?.cells.Duration)),
      toSummary: /to summary/i.test(Object.values(total?.cells ?? {}).join(' ')),
      totalTokens: numberIn(total?.cells['Total tokens']),
    }).toEqual({ durations: [600000, 600000, 600000, 1800000], toSummary: true, totalTokens: 13200 })
  }, 30_000)

  it('marks a cost missing a child’s number as (partial) and a cost with no source as not measured', async () => {
    const rows = telemetryTable(await renderAt(TELEMETRY_STEPS))
    const specWriter = rowNamed(rows, 'spec-writer')?.cells['Reported cost'] ?? ''
    expect({ partial: specWriter.includes('(partial)'), value: numberIn(specWriter), planner: rowNamed(rows, 'planner')?.cells['Reported cost'] }).toEqual({ partial: true, value: 0.05, planner: 'not measured' })
  }, 30_000)

  it('shows only Orchestration and Total when the run has no step records', async () => {
    const rows = telemetryTable(await renderAt([]))
    expect(rows.map((row) => firstWord(row.label))).toEqual(['Orchestration', 'Total'])
  }, 30_000)
})

describe('KIT-19 T22 F15 F22: the list-price lines are unchanged for {tokens, wallMs} records', () => {
  // The Cost and time section the renderer produced for these records before KIT-19, pinned byte for byte.
  const PINNED =
    '\n' +
    '- planner (run-20261012T090000Z): 1,200 tokens, 1m0s (opus), ~$0.02\n' +
    '- implementor (run-20261012T090000Z): 800 tokens, 30s (sonnet), ~$0.00\n' +
    '- code-analyzer (run-20261012T090000Z): not reported\n' +
    '- pr-reviewer (run-20261012T090000Z): 1,500 tokens, wall time not reported (sonnet), ~$0.01\n' +
    '- fix (run-20261012T090000Z): 400 tokens, 55s (sonnet), ~$0.00\n' +
    '\n' +
    'Total: 3,900 tokens (partial, excludes code-analyzer); ~$0.03 — an estimate of session usage at list prices.\n' +
    '\n'

  it('renders Cost and time exactly as before', async () => {
    const state = runState({
      steps: [
        step('planner', at('09:00:00'), at('09:01:00'), { tokens: 1200, wallMs: 60000 }),
        step('implementor', at('09:02:00'), at('09:02:30'), { tokens: 800, wallMs: 30000 }),
        step('code-analyzer', at('09:03:00'), at('09:04:00'), null),
        step('pr-reviewer', at('09:05:00'), at('09:07:05'), { tokens: 1500, wallMs: null }),
        step('fix', at('09:07:05'), at('09:08:00'), { tokens: 400, wallMs: 55000 }),
      ],
    })
    const input = { ticket: ticket(), state, repo: await repo(), now: at('09:10:00') }
    expect(section(await renderBuildSummary(input), /cost and time/i)).toBe(PINNED)
  }, 30_000)
})
