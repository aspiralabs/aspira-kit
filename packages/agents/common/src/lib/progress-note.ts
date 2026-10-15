// `.work/<id>-<slug>/progress.md`: the one file a fresh session (or a human) reads to know where a
// ticket stands and what to do next, instead of re-reading the whole run folder (F14-F21). Every
// `--local` driver stage writes it; `nextAction` is the pure template picker behind its Next action
// block, built only from validated parts (never a trace's free text, which could be an injection
// attempt or a secret) and redacted before it ever reaches disk.

import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commandFor, nextStep, PLAYBOOK, type PlaybookRow } from '@aspiralabs/kit/playbook'
import { redact } from './redact.ts'
import { step8Commands } from './step-commands.ts'
import type { ReasonCode, RunStatus } from './run-status.ts'
import type { Skill } from './ticket.ts'

/** The note's file name, inside the ticket's working folder. */
export const PROGRESS_NOTE_FILE = 'progress.md'

/** build-feature's own marker (relative to the ticket folder): present with no `end` while a run drives this ticket through several skills in one session. */
export const BUILD_FEATURE_ACTIVE = '.local/build-feature/active.json'

/** The Next action block: one Step line, zero or more Do lines (human actions only), one or more Run lines in run order, and one Session line. */
export type NextAction = { step: string; do: string[]; run: string[]; session: string }

/** The note's content, before redaction and the build-feature override. */
export type ProgressNote = {
  id: string
  title: string
  skill: Skill
  runId: string
  runStatus: RunStatus
  status: string
  expectedStatus: string | null
  outputs: string[]
  completed: string[]
  decisions: string[]
  openIssues: string[]
  nextAction: NextAction | null
}

const NOTHING_TO_DO = 'Nothing to do right now.'

/** The launcher form of a skill's command: the script path, `local <id>`, and the flags the slash command carried, minus `--local` (implied by `local`). */
function launcherCommand(skill: string, id: string, extraFlags = ''): string {
  return `.claude/skills/aspira-${skill}/scripts/${skill}.sh local ${id}${extraFlags}`.trim()
}

/** A Playbook row's command, translated into the launcher form a session runs directly, with a reminder to read that skill's SKILL.md first (never "the Skill tool"). */
export function launcherFor(command: string, id: string): string {
  const name = /^\/aspira-([a-z-]+)\s/.exec(command)?.[1]
  if (name === undefined) return ''
  return `${launcherCommand(name, id)} (read .claude/skills/aspira-${name}/SKILL.md first)`
}

/** The Playbook's row for a live board Status, as a NextAction (F3, F44): the slash command as Run, the launcher form as Session. */
function playbookAction(id: string, boardStatus: string): NextAction {
  const row: PlaybookRow | null = nextStep(boardStatus)
  if (row === null) return { step: `${boardStatus}: no Playbook row for this Status`, do: [], run: [], session: '' }
  if (row.command === null) return { step: row.step, do: [`${row.who}, by hand.`], run: [], session: '' }
  const command = commandFor(row, id) ?? ''
  return { step: row.step, do: [], run: [command], session: launcherFor(row.command, id) }
}

/**
 * The step after a verified ready run, for a live board Status (F19): the Status's own Playbook
 * row when it already has a command, or, for a human-only row ("move the card", "approve it"), the
 * next row's command, since the human's own move is implied and the useful information is what
 * runs once they make it.
 */
function followingPlaybookAction(id: string, liveStatus: string): NextAction {
  const wanted = liveStatus.trim().toLowerCase()
  const index = PLAYBOOK.findIndex((row) => row.statuses.some((status) => status.toLowerCase() === wanted))
  if (index === -1) return playbookAction(id, liveStatus)
  const row = PLAYBOOK[index]!
  if (row.command !== null) return playbookAction(id, liveStatus)
  const after = PLAYBOOK[index + 1]
  if (after === undefined || after.command === null) return { step: row.step, do: [`${row.who}, by hand.`], run: [], session: '' }
  return { step: after.step, do: [], run: [commandFor(after, id) ?? ''], session: launcherFor(after.command, id) }
}

/** Resume the exact launcher command a run already in progress used (the board stage, or a run whose exit the session is waiting on). */
function continueAction(id: string, skill: Skill): NextAction {
  const command = launcherCommand(skill, id)
  return { step: `${skill} is running, or it stopped: rerun it`, do: [], run: [command], session: command }
}

export type RunActionInput = {
  kind: 'run'
  id: string
  skill: Skill
  runStatus: RunStatus
  reasonCode?: ReasonCode | null
  /** A trace's free text (a decision's reason, an error line): read only by a human from Open issues, never built into a command. */
  reason?: string | null
  /** Whether the board-end actions for a ready run were confirmed by the verify step. */
  verified?: boolean
  /** The ticket's live Status (ticket.md), for a verified ready run's Playbook lookup. */
  liveStatus?: string
  /** The app directories this build touched (changedApps), for the implementor/code-analyzer's Step 7 / Step 8 choice. */
  apps?: readonly string[]
  /** Which of `apps` the code analyzer already finished for this ticket and head (analyzedApps). */
  analyzedApps?: readonly string[]
  /** Step 8: the card title, branch and PR body file step8Commands needs. */
  title?: string
  branch?: string
  prBodyFile?: string
  paths?: readonly string[]
}

function runAction(input: RunActionInput): NextAction {
  const { id, skill, runStatus, reasonCode = null } = input
  const launcher = (extra = '') => launcherCommand(skill, id, extra)
  if (runStatus === 'needs-author') {
    if (skill === 'groomer') {
      if (reasonCode === 'paused') return { step: `Grooming stopped at the human's request; run ${skill} again to resume from the page.`, do: [], run: [launcher()], session: launcher() }
      return { step: 'Answer the open questions, then rerun the groomer', do: ['Answer the open questions on the Grooming Decisions page (groom/trace/decisions.md).'], run: [launcher()], session: launcher() }
    }
    return { step: `${skill}: answer the open decisions, then rerun it`, do: [`Answer the open decisions ${skill} left, then rerun it.`], run: [launcher()], session: launcher() }
  }
  if (runStatus === 'refused') {
    if (reasonCode === 'plan-drift') return { step: 'Step 5: plan (the repository moved since the plan was made; re-plan it)', do: [], run: ['/aspira-planner <ID> --local'.replace('<ID>', id)], session: launcherCommand('planner', id) }
    return { step: `${skill} refused; fix the blocker named in its report, then rerun it`, do: [`Fix the blocker ${skill} named.`], run: [launcher()], session: launcher() }
  }
  if (runStatus === 'incomplete') return { step: `${skill} ended incomplete: rerun the stage`, do: [], run: [launcher()], session: launcher() }
  if (runStatus === 'blocked') return { step: `${skill} is blocked: fix the blocker, then rerun it`, do: [], run: [launcher()], session: launcher() }
  // ready
  if (input.verified === false) {
    const verify = launcher(' --verify')
    return { step: `Verify the board actions ${skill} asked for`, do: [], run: [verify], session: verify }
  }
  if (skill === 'implementor' || skill === 'code-analyzer') {
    const apps = input.apps ?? []
    const analyzed = new Set(input.analyzedApps ?? [])
    const remaining = apps.filter((app) => !analyzed.has(app))
    if (remaining.length > 0) {
      const app = remaining[0]!
      return { step: 'Step 7: static analysis', do: [], run: [`/aspira-code-analyzer ${id} --app ${app} --local`], session: launcherCommand('code-analyzer', id, ` --app ${app}`) }
    }
    if (input.title !== undefined && input.branch !== undefined && input.prBodyFile !== undefined) {
      const built = step8Commands({ id, title: input.title }, input.branch, input.paths ?? [], input.prBodyFile)
      const commands = built.ok ? built.commands : []
      return { step: 'Step 8: open the pull request', do: [], run: commands, session: commands.join(' && ') }
    }
    return { step: 'Step 8: open the pull request', do: ['Push the branch, open the PR, set the PR property and move the card.'], run: [], session: '' }
  }
  if (input.liveStatus !== undefined) return followingPlaybookAction(id, input.liveStatus)
  return { step: 'Done', do: [], run: [], session: '' }
}

export type NextActionInput = { kind: 'playbook'; id: string; boardStatus: string } | { kind: 'continue'; id: string; skill: Skill } | RunActionInput

/** The Next action for a ticket, picked by run status, reason code and skill alone (TEST-006): never a trace's free text, which could be attacker- or secret-controlled. */
export function nextAction(input: NextActionInput): NextAction {
  if (input.kind === 'playbook') return playbookAction(input.id, input.boardStatus)
  if (input.kind === 'continue') return continueAction(input.id, input.skill)
  return runAction(input)
}

const section = (title: string, lines: readonly string[]): string => `## ${title}\n\n${lines.length === 0 ? '' : `${lines.map((line) => `- ${line}`).join('\n')}\n`}`

function nextActionBlock(action: NextAction | null): string {
  if (action === null) return `## Next action\n\n${NOTHING_TO_DO}\n`
  const lines = [`Step: ${action.step}`, ...action.do.map((line) => `Do: ${line}`), ...action.run.map((line) => `Run: ${line}`), `Session: ${action.session}`]
  return `## Next action\n\n${lines.join('\n')}\n`
}

/** The note's markdown, before redaction. `outputs` is pre-filtered to the paths that exist. */
export function renderProgressNote(note: ProgressNote, writtenAt: string): string {
  const ticket = [
    `ID: ${note.id}`,
    `Skill: ${note.skill}`,
    `Run id: ${note.runId}`,
    `Run status: ${note.runStatus}`,
    `Status: ${note.status}`,
    ...(note.expectedStatus === null ? [] : [`Expected Status: ${note.expectedStatus}`]),
    `Written: ${writtenAt}`,
  ]
  return [`# ${note.id}: ${note.title}`, '', `## Ticket`, '', ticket.join('\n'), '', section('Outputs', note.outputs), section('Completed', note.completed), section('Decisions', note.decisions), section('Open issues', note.openIssues), nextActionBlock(note.nextAction)].join('\n')
}

/** Every free-text field in a note (never a path, a command or a fixed label): redacted the same way a report header is. */
async function redactNote(note: ProgressNote, repo: string, options: { app?: string; extra?: readonly string[] }): Promise<ProgressNote> {
  const one = (text: string) => redact(text, repo, options)
  return {
    ...note,
    completed: await Promise.all(note.completed.map(one)),
    decisions: await Promise.all(note.decisions.map(one)),
    openIssues: await Promise.all(note.openIssues.map(one)),
  }
}

/** The paths of `outputs` that exist under `folder`, in the given order. */
async function existingOutputs(folder: string, outputs: readonly string[]): Promise<string[]> {
  const checked = await Promise.all(outputs.map(async (path) => ((await access(join(folder, path)).then(() => true, () => false)) ? path : null)))
  return checked.filter((path): path is string => path !== null)
}

type BuildFeatureActive = { runId: string; mode: 'local' | 'cloud'; end: string | null }

async function buildFeatureActive(folder: string): Promise<BuildFeatureActive | null> {
  const text = await readFile(join(folder, BUILD_FEATURE_ACTIVE), 'utf8').catch(() => undefined)
  if (text === undefined) return null
  try {
    const parsed = JSON.parse(text) as BuildFeatureActive
    return parsed.end === null || parsed.end === undefined ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write `.work/<id>-<slug>/progress.md` (F14-F21): outputs filtered to the paths that exist, every
 * free-text field redacted with the app directory's and the repository root's `.env*` values and
 * `notionToken` (the token in use), and, while a build-feature run drives this ticket
 * (`BUILD_FEATURE_ACTIVE` present with no `end`), the Next action replaced by the one command that
 * resumes the whole run, with the step's own continuation demoted to Open issues instead of lost.
 */
export async function writeProgressNote(args: { folder: string; repo: string; app?: string; notionToken?: string; note: ProgressNote }): Promise<void> {
  const outputs = await existingOutputs(args.folder, args.note.outputs)
  const active = await buildFeatureActive(args.folder)
  let note: ProgressNote = { ...args.note, outputs }
  if (active !== null) {
    const demoted = note.nextAction === null ? [] : [`The step's own continuation: ${[`Step: ${note.nextAction.step}`, ...note.nextAction.run.map((line) => `Run: ${line}`)].join('; ')}`]
    const flag = active.mode === 'local' ? ' --local' : ''
    const command = `/aspira-build-feature ${note.id}${flag}`
    note = { ...note, openIssues: [...note.openIssues, ...demoted], nextAction: { step: 'A build-feature run is driving this ticket: resume it, not this step directly.', do: [], run: [command], session: command } }
  }
  const redacted = await redactNote(note, args.repo, { app: args.app, extra: args.notionToken === undefined ? [] : [args.notionToken] })
  const text = renderProgressNote(redacted, new Date().toISOString())
  await writeFile(join(args.folder, PROGRESS_NOTE_FILE), text)
}

/** `## Next action` read back, or null when the section has no `Step:` and no `Run:` line. */
export function parseNextAction(text: string): NextAction | null {
  const start = text.indexOf('## Next action')
  if (start === -1) return null
  const body = text.slice(start + '## Next action'.length)
  const lines = body.split('\n')
  const step = lines.find((line) => line.startsWith('Step: '))?.slice('Step: '.length)
  const run = lines.filter((line) => line.startsWith('Run: ')).map((line) => line.slice('Run: '.length))
  if (step === undefined && run.length === 0) return null
  const doLines = lines.filter((line) => line.startsWith('Do: ')).map((line) => line.slice('Do: '.length))
  const session = lines.find((line) => line.startsWith('Session: '))?.slice('Session: '.length) ?? ''
  return { step: step ?? '', do: doLines, run, session }
}

/** The `## Ticket` section's key: value lines read back, by name. */
export function parseProgressNote(text: string): { id: string; title: string; skill: string; runId: string; runStatus: string; status: string; expectedStatus: string | null } | null {
  const titleMatch = /^# ([^:\n]+): (.*)$/m.exec(text)
  const start = text.indexOf('## Ticket')
  if (titleMatch === null || start === -1) return null
  const end = text.indexOf('## Outputs')
  const section = text.slice(start, end === -1 ? undefined : end)
  const fields: Record<string, string> = {}
  for (const line of section.split('\n')) {
    const match = /^([A-Za-z ]+): (.*)$/.exec(line)
    if (match !== null) fields[match[1]!] = match[2]!
  }
  return {
    id: fields.ID ?? titleMatch[1]!.trim(),
    title: titleMatch[2]!.trim(),
    skill: fields.Skill ?? '',
    runId: fields['Run id'] ?? '',
    runStatus: fields['Run status'] ?? '',
    status: fields.Status ?? '',
    expectedStatus: fields['Expected Status'] ?? null,
  }
}

/** Adds a dated Open issues line and keeps the existing Next action, for a refusal that happens after the ticket already has a finished run's note. Adds the `## Open issues` heading itself when the note (an older one, say) does not have it yet. */
export function appendRefusal(text: string, message: string): string {
  const nextStart = text.indexOf('## Next action')
  if (nextStart === -1) return text
  const dated = `- ${new Date().toISOString().slice(0, 10)}: ${message}\n`
  const openStart = text.indexOf('## Open issues')
  if (openStart === -1 || openStart > nextStart) return `${text.slice(0, nextStart)}## Open issues\n\n${dated}\n${text.slice(nextStart)}`
  const insertAt = text.indexOf('\n\n', openStart) + 2
  return `${text.slice(0, insertAt)}${dated}${text.slice(insertAt)}`
}
