// The Build Summary renderer (the exported renderBuildSummary), from literal run-state fixtures:
// redaction and quoting of command output and card text, the fixed section order, the ordering of
// blocking findings and the timeline, Mermaid sections, and the cost table with missing usage.
// KIT-11 plan P5: T37-T39. The run-state shape is the one P9's runStateSchema records.

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderBuildSummary } from '#src/summary.ts'

const temps: string[] = []
afterEach(async () => {
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
    runs: [{ runId: RUN, command: '/aspira-build-feature KIT-11 --local', startedAt: '2026-10-12T09:00:00.000Z', endedAt: '2026-10-12T12:00:00.000Z', ended: 'stopped' }],
    inProgress: null,
    approvals: [{ runId: RUN, notionUserId: 'user-1', name: 'Ada Approver', at: '2026-10-12T09:00:00.000Z', command: '/aspira-build-feature KIT-11 --local' }],
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
