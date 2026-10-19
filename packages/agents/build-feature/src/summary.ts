// The Build Summary: a pure renderer from the run state (cumulative over every run of the ticket,
// A16) to markdown, written to `.work/<id>-<slug>/build-summary.md`. Sections always appear in the
// same order (F38): status and where the card ended (blocking items first); decisions taken for
// you; tests written; deviations and assumptions; cost and time; run telemetry (KIT-19);
// architecture; step timeline.
// Empty sections say "None yet." (F41). Mermaid diagrams render as diagrams on the Notion page
// (F39). Untrusted fragments (a card's title, a command's output) are redacted and escaped one at
// a time through redact.ts before they are woven into this module's own markdown (SEC-010): the
// composed document is never redacted whole, which would also mangle its own headings, code
// fences and Mermaid blocks.

import { compareIds } from '@aspiralabs/agent-common/lib/decisions'
import { redact, tail } from '@aspiralabs/agent-common/lib/redact'
import { allowedPath } from '@aspiralabs/agent-common/lib/repository'
import { SEVERITIES } from '@aspiralabs/agent-common/lib/severity'
import { orderedTaken } from '#src/decisions.ts'
import { gateSummaryLines } from '#src/gate.ts'
import { MODELS, type ModelName } from '#src/models.ts'
import { modeLine, RESUME, STEPS } from '#src/route.ts'
import type { RunState, StepRecord } from '#src/run-state.ts'
import { tableRows, type Cell } from '#src/telemetry.ts'

export type BuildSummaryTicket = { id: string; title: string; url: string }
/** A run state as a caller hands it to the renderer: the fields this module never reads (card, overrides, queue, afterAsks, phases) are optional, since a run that stopped before its first resolution, or a hand-built fixture, may not carry them. */
export type SummaryRunState = Omit<RunState, 'card' | 'overrides' | 'queue' | 'afterAsks' | 'phases'> & Partial<Pick<RunState, 'card' | 'overrides' | 'queue' | 'afterAsks' | 'phases'>>
export type RenderBuildSummaryInput = {
  ticket: BuildSummaryTicket
  state: SummaryRunState
  repo: string
  /** aspira.json `app`, when the project names one: redaction also scrubs this directory's own `.env*` values. */
  app?: string
  /** plan.json, read by the driver next to the run state; absent until the planner has run. */
  plan?: unknown
  /** The files changed on the branch; when absent, every planned task's own `changes` paths stand in for it. */
  changedFiles?: readonly string[]
  /** When the summary is rendered (the summary stage's time), the end of the Run telemetry table; absent, the run's end or its last step's. */
  now?: string
}

const NONE = ['None yet.']

/** A `## <heading>` section: a blank line, then the body, each line already laid out. */
function section(heading: string, lines: readonly string[]): string {
  return `## ${heading}\n\n${lines.join('\n')}\n`
}

const fence = (language: string, body: string): string => `\`\`\`${language}\n${body}\n\`\`\``

// ---------------------------------------------------------------------------------------------
// Plan shapes, read defensively: plan.json is parsed JSON, not validated again here.
// ---------------------------------------------------------------------------------------------

type PlanTask = { id: string; title: string; dependsOn: string[]; files: string[] }
type PlanTest = { id: string; path: string }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function planTasks(plan: unknown): PlanTask[] {
  const tasks = record(plan)?.tasks
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((raw) => {
    const task = record(raw)
    const id = typeof task?.id === 'string' ? task.id : null
    if (task === null || id === null) return []
    const title = typeof task.title === 'string' ? task.title : id
    const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.filter((value): value is string => typeof value === 'string') : []
    const changes = Array.isArray(task.changes) ? task.changes : []
    const files = changes.flatMap((change) => {
      const path = record(change)?.path
      return typeof path === 'string' ? [path] : []
    })
    return [{ id, title, dependsOn, files }]
  })
}

function planTests(plan: unknown): PlanTest[] {
  const tests = record(plan)?.tests
  if (!Array.isArray(tests)) return []
  return tests.flatMap((raw) => {
    const test = record(raw)
    const id = typeof test?.id === 'string' ? test.id : null
    const path = typeof test?.path === 'string' ? test.path : null
    return id === null || path === null ? [] : [{ id, path }]
  })
}

// ---------------------------------------------------------------------------------------------
// Ordering shared by the cost table and the step timeline: start time, then Playbook order.
// ---------------------------------------------------------------------------------------------

const stepRank = (step: string): number => {
  const index = (STEPS as readonly string[]).indexOf(step)
  return index === -1 ? STEPS.length : index
}

function orderedSteps(steps: readonly StepRecord[]): StepRecord[] {
  return [...steps].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || stepRank(a.step) - stepRank(b.step))
}

function rankSeverity(severity: string): number {
  const index = (SEVERITIES as readonly string[]).indexOf(severity)
  return index === -1 ? SEVERITIES.length : index
}

function orderedRemaining(remaining: RunState['remaining']): RunState['remaining'] {
  return [...remaining].sort((a, b) => rankSeverity(a.severity) - rankSeverity(b.severity) || compareIds(a.id, b.id))
}

// ---------------------------------------------------------------------------------------------
// Status: blocking items first, then the refused step, the failed action, the resume command and
// the approval record.
// ---------------------------------------------------------------------------------------------

async function statusLines(input: RenderBuildSummaryInput, resume: string): Promise<string[]> {
  const { state, repo, app } = input
  const lines: string[] = []
  const run = state.runs.at(-1)
  if (run?.end !== undefined) lines.push(run.end.message, '')
  else if (run !== undefined) lines.push(`Run ${run.runId} is in progress.`, '')
  const card = state.card ?? null
  if (card !== null) lines.push(`Card: ${card.status} (${card.url})`, '')
  if (run !== undefined) lines.push(modeLine(run.mode), ...(run.worktree === undefined ? [] : [`Worktree: ${run.worktree}`]), '')
  const gate = gateSummaryLines(state)
  if (gate.length > 0) lines.push(...gate, '')
  const remaining = orderedRemaining(state.remaining)
  if (remaining.length > 0) {
    lines.push('Remaining findings:', '')
    for (const finding of remaining) lines.push(`- ${finding.id} (${finding.severity}): ${await redact(finding.title, repo, { app })}`)
    lines.push('')
  }
  const refused = state.steps.find((step) => step.status === 'refused')
  if (refused !== undefined) lines.push(`${refused.step} refused at its Status gate (${refused.runId}).`, '')
  if (state.failure !== null) {
    const failure = state.failure
    const parts = [failure.action, ...(failure.command === undefined ? [] : [`\`${failure.command}\``]), ...(failure.exitCode === undefined ? [] : [`exit ${failure.exitCode}`])]
    lines.push(`Failed: ${parts.join(', ')}${failure.message === undefined ? '' : `: ${await redact(failure.message, repo, { app })}`}`, '')
    if (failure.output !== undefined) lines.push(fence('text', await redact(tail(failure.output), repo, { app })), '')
  }
  for (const approval of state.approvals) lines.push(`Run-start approval for ${approval.runId}: ${approval.name}${approval.notionUserId === undefined ? '' : ` (${approval.notionUserId})`} at ${approval.at}, by "${approval.command}".`)
  if (state.approvals.length > 0) lines.push('')
  if (run?.end?.stopped === true) lines.push(`Resume: ${resume}`)
  return lines.length === 0 ? NONE : lines
}

// ---------------------------------------------------------------------------------------------
// Decisions taken for you: post-Ready: Plan first, then Playbook order, then numeric id; plus
// what was asked in chat.
// ---------------------------------------------------------------------------------------------

async function decisionLines(state: SummaryRunState, repo: string, app: string | undefined): Promise<string[]> {
  const taken = orderedTaken(state.takenKeys)
  const lines: string[] = []
  for (const entry of taken) {
    const question = await redact(entry.decision.question, repo, { app })
    const answer = await redact(entry.decision.answer ?? entry.decision.recommended, repo, { app })
    lines.push(`- \`${entry.key}\`: ${question} Taken: ${answer}.`)
  }
  if (state.asked.length > 0) {
    lines.push('', '### Asked in chat', '')
    for (const asked of state.asked) {
      const question = await redact(asked.question.replaceAll('\n', ' '), repo, { app })
      const answer = asked.answer === null ? '(no answer)' : await redact(asked.answer, repo, { app })
      lines.push(`- ${asked.step}: ${question} Answer: ${answer}`)
    }
  }
  return lines.length === 0 ? NONE : lines
}

// ---------------------------------------------------------------------------------------------
// Tests written: the planner's test checklist, narrowed to the test files actually on the branch
// when that list is known (A12).
// ---------------------------------------------------------------------------------------------

function testsWrittenLines(plan: unknown, changedFiles: readonly string[] | undefined): string[] {
  const tests = planTests(plan)
  const written = changedFiles === undefined ? tests : tests.filter((test) => changedFiles.includes(test.path))
  return written.length === 0 ? NONE : written.map((test) => `- \`${test.path}\` (${test.id})`)
}

// ---------------------------------------------------------------------------------------------
// Deviations and assumptions: a taken decision the author later overrode is a real deviation from
// what the run did; everything else this run assumed is already listed under its decisions.
// ---------------------------------------------------------------------------------------------

function deviationLines(state: SummaryRunState): string[] {
  const overrides = state.overrides ?? []
  if (overrides.length === 0) return NONE
  return overrides.map((override) => `- \`${override.key}\` changed from ${override.from ?? 'no answer'} to ${override.to} (found in ${override.foundIn}).`)
}

// ---------------------------------------------------------------------------------------------
// Cost and time: tokens and wall time per step, from what each subagent reported; a step that
// reported none shows "not reported", and the total and the dollar estimate are then labelled
// partial and name the steps they exclude (F40). The dollar figure is a blended list-price
// estimate per model tier: Opus 5.5 alone named here when the input/output split is known.
// ---------------------------------------------------------------------------------------------

/** List price per million tokens, blended across input and output, by the model tier a step runs on. */
const PRICE_PER_MTOK: Readonly<Record<ModelName, number>> = { fable: 30, opus: 15, sonnet: 6, haiku: 3 }

function modelOf(step: string): ModelName | undefined {
  return (MODELS as Partial<Record<string, ModelName>>)[step]
}

function fmtWall(wallMs: number): string {
  const totalSeconds = Math.round(wallMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

function costLines(steps: readonly StepRecord[]): string[] {
  if (steps.length === 0) return NONE
  const lines: string[] = []
  let totalTokens = 0
  let totalCost = 0
  const missing: string[] = []
  for (const step of orderedSteps(steps)) {
    if (step.usage === null || step.usage.tokens === null) {
      missing.push(step.step)
      lines.push(`- ${step.step} (${step.runId}): not reported`)
      continue
    }
    const model = modelOf(step.step)
    const tokens = step.usage.tokens
    const cost = model === undefined ? 0 : (tokens * PRICE_PER_MTOK[model]) / 1_000_000
    totalTokens += tokens
    totalCost += cost
    const wall = step.usage.wallMs === null ? 'wall time not reported' : fmtWall(step.usage.wallMs)
    lines.push(`- ${step.step} (${step.runId}): ${tokens.toLocaleString('en-US')} tokens, ${wall}${model === undefined ? '' : ` (${model})`}, ~$${cost.toFixed(2)}`)
  }
  const partial = missing.length > 0 ? ` (partial, excludes ${missing.join(', ')})` : ''
  lines.push('', `Total: ${totalTokens.toLocaleString('en-US')} tokens${partial}; ~$${totalCost.toFixed(2)} — an estimate of session usage at list prices.`)
  return lines
}

// ---------------------------------------------------------------------------------------------
// Run telemetry (KIT-19 F15, F21): the current run's steps with their children, Orchestration with
// the run's fixes, and the Total to the summary stage, from the same span tree as the telemetry
// file (telemetry.ts). Every cell is a closed-set label, a number, "not measured" or "(partial)"
// (SEC-010): no free text from the run state reaches the table.
// ---------------------------------------------------------------------------------------------

/** A duration as 1h2m3s, 10m0s or 45s. */
function fmtDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

const NOT_MEASURED = 'not measured'

function fmtCell(cell: Cell, format: (value: number) => string): string {
  if (cell.value === null) return NOT_MEASURED
  return `${format(cell.value)}${cell.partial ? ' (partial)' : ''}`
}

const fmtCount = (value: number): string => Math.round(value).toLocaleString('en-US')
const fmtCost = (value: number): string => `$${Number(value.toFixed(4))}`

/** The end of the table when the caller gives no time: the run's end, else its last step's, else its start. */
function tableEnd(state: SummaryRunState, runId: string, startedAt: string, endedAt: string | null): string {
  const lastStep = state.steps
    .filter((step) => step.runId === runId)
    .map((step) => step.endedAt)
    .sort()
    .at(-1)
  return endedAt ?? lastStep ?? startedAt
}

function telemetryLines(state: SummaryRunState, now: string | undefined): string[] {
  const run = state.runs.at(-1)
  if (run === undefined) return NONE
  const rows = tableRows(state, run.runId, now ?? tableEnd(state, run.runId, run.startedAt, run.endedAt))
  const lines = [`Run ${run.runId}, to the summary stage.`, '', '| Span | Duration | Input tokens | Output tokens | Total tokens | Tool calls | Reported cost |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const entry of rows) {
    const label = entry.depth === 0 ? entry.label : `&nbsp;&nbsp;↳ ${entry.label}`
    lines.push(`| ${label} | ${fmtDuration(entry.durationMs)} | ${fmtCell(entry.input, fmtCount)} | ${fmtCell(entry.output, fmtCount)} | ${fmtCell(entry.total, fmtCount)} | ${fmtCell(entry.toolCalls, fmtCount)} | ${fmtCell(entry.cost, fmtCost)} |`)
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// Architecture: a flowchart from the plan's tasks and their dependencies, with each task's changed
// files narrowed to the ones actually on the branch when that is known (A11).
// ---------------------------------------------------------------------------------------------

/**
 * A fragment made safe inside a quoted Mermaid label in a fenced block: redact.ts first (SEC-010),
 * then every backtick, double quote and backslash (redact's own markdown escapes) dropped and every
 * line break folded to a space, so the label can neither close its quotes nor the fence.
 */
const mermaidText = (text: string): string => text.replace(/[`"\\]/g, '').replace(/\s*[\r\n]+\s*/g, ' ')
const mermaidLabel = async (text: string, repo: string, app: string | undefined): Promise<string> => mermaidText(await redact(text, repo, { app }))

/** A task id as a Mermaid node id: the id itself when it is a plain word, else a generated one. */
const nodeId = (id: string, index: number): string => (/^\w+$/.test(id) ? id : `t${index}`)

async function architectureLines(plan: unknown, changedFiles: readonly string[] | undefined, repo: string, app: string | undefined): Promise<string[]> {
  const tasks = planTasks(plan)
  if (tasks.length === 0) return NONE
  const nodes = new Map(tasks.map((task, index) => [task.id, nodeId(task.id, index)]))
  const body: string[] = ['flowchart TD']
  for (const task of tasks) body.push(`  ${nodes.get(task.id)!}["${await mermaidLabel(`${task.id}: ${task.title}`, repo, app)}"]`)
  for (const task of tasks) {
    for (const dependsOn of task.dependsOn) {
      const from = nodes.get(dependsOn)
      if (from !== undefined) body.push(`  ${from} --> ${nodes.get(task.id)!}`)
    }
  }
  let index = 0
  for (const task of tasks) {
    const files = (changedFiles === undefined ? task.files : task.files.filter((file) => changedFiles.includes(file))).filter(allowedPath)
    for (const file of files) {
      const node = `f${index}`
      index += 1
      body.push(`  ${node}["${await mermaidLabel(file, repo, app)}"]`, `  ${nodes.get(task.id)!} --> ${node}`)
    }
  }
  return [fence('mermaid', body.join('\n'))]
}

// ---------------------------------------------------------------------------------------------
// Step timeline: a Mermaid gantt from the recorded step start and end times, in the same order as
// the cost table.
// ---------------------------------------------------------------------------------------------

const fmtDate = (iso: string): string => iso.replace(/\.\d+Z$/, '').replace(/Z$/, '')

function timelineLines(steps: readonly StepRecord[]): string[] {
  if (steps.length === 0) return NONE
  const body: string[] = ['gantt', '  dateFormat YYYY-MM-DDTHH:mm:ss', '  title Step timeline']
  for (const step of orderedSteps(steps)) body.push(`  ${mermaidText(step.step)} : ${fmtDate(step.startedAt)}, ${fmtDate(step.endedAt)}`)
  return [fence('mermaid', body.join('\n'))]
}

// ---------------------------------------------------------------------------------------------
// The renderer.
// ---------------------------------------------------------------------------------------------

/** The Build Summary for this run state, cumulative over every run of the ticket (A16). Pure: no writes, no Notion calls. */
export async function renderBuildSummary(input: RenderBuildSummaryInput): Promise<string> {
  const { ticket, state, repo, app, plan, changedFiles, now } = input
  const mode = state.runs.at(-1)?.mode ?? 'local'
  const resume = RESUME(ticket.id, mode)
  const title = await redact(ticket.title, repo, { app })
  const header = `# Build Summary: ${ticket.id}${title === '' ? '' : ` ${title}`}`
  const sections = [
    section('Status', await statusLines(input, resume)),
    section('Decisions taken for you', await decisionLines(state, repo, app)),
    section('Tests written', testsWrittenLines(plan, changedFiles)),
    section('Deviations and assumptions', deviationLines(state)),
    section('Cost and time', costLines(state.steps)),
    section('Run telemetry', telemetryLines(state, now)),
    section('Architecture', await architectureLines(plan, changedFiles, repo, app)),
    section('Step timeline', timelineLines(state.steps)),
    mode === 'local' ? 'Reviews ran in the same session as the build, not as a separate pass.' : "Each step and each review ran as that step's own agent run, not in this session.",
  ]
  return `${header}\n\n${sections.join('\n')}\n`
}
