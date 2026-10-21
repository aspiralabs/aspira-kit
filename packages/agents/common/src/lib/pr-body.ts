// The PR body every build renders from implementation.md (F3, F42, F43; KIT-52): `## What it fixed`
// (the implementor's own plain-English summary, lifted verbatim from the log; it is also the release
// page's section for the feature and becomes the release notes), then `## Summary` (a file tree of the branch's changed files), `## Evidence` (per feature ID, every
// implementation.md task that names it, with that task's red and green evidence, tailed and
// redacted) and `## Merge Danger` (one-way when the build added a native dependency or touched a
// migration, else two-way), then the decisions taken for the human, the run's notice and a link to
// the ticket. implementation.md's own shape (the `## Tasks` pipe table and its
// `### <id> — red → green evidence` subsections) is the implementor's SKILL.md template
// (packages/agents/implementor/agent/skills/aspira-implementor/SKILL.md, section 7); this module
// parses exactly that, nothing more general. Every untrusted fragment (a task's red or green
// output) is redacted on its own, scoped to `app`, before it is woven into the body: redacting the
// whole rendered document would also mangle this module's own headings and code fences (SEC-010).

import { redact, redactSecrets, tail } from './redact.ts'

export type PrBodyTicket = { id: string; title: string; url: string }

/** One app's code-analyzer result, as rounds.json records it: only `reasonCode: 'no-analyzers'` changes what Evidence says. */
export type PrBodyAnalyzer = { app: string; status: string; reasonCode?: string | null }

/** A decision taken for the human, in the shape build-feature's and the implementor's `taken` records already carry. */
export type PrBodyTakenDecision = { key: string; decision: { question: string; answer: string | null; recommended: string } }

export type PrBodyInput = {
  ticket: PrBodyTicket
  /** The implementor's progress log (`plan.review/implementation.md` or the ticket's `implementation/implementation.md`), read as text. */
  implementationMd: string
  /** The branch's changed files, repository-relative, from the base branch to HEAD. */
  changedFiles: string[]
  analyzers: PrBodyAnalyzer[]
  /** Decisions taken for the human after Ready: Plan (the implementor's assumptions, a fix step's own decisions), in report order. */
  taken?: PrBodyTakenDecision[]
  /** A run-mode notice (same-session versus cloud), printed once after the decisions. */
  notice?: string
  /** The closing line, after the notice. Defaults to a plain link to `ticket.url`; a caller with its own page to point to (build-feature's Build Summary) passes its own line naming `ticket.url`. */
  footer?: string
  repo: string
  /** The app directory (aspira.json `app`) to also read `.env*` files from when redacting; omitted means the repository root alone. */
  app?: string
}

type TaskRow = { id: string; features: string[]; word: 'red' | 'green' | 'none' }

/** The text between a `## <heading>` line and the next `## ` heading (or the end), excluding both heading lines. */
function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

/** The text between a `### <id> — red → green evidence` heading and the next `### ` heading (or the end of `tasksSection`). */
function subsectionBody(tasksSection: string, id: string): string {
  const lines = tasksSection.split('\n')
  const heading = `### ${id} — red → green evidence`
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('### ')) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

/** The `## Tasks` pipe table's data rows: id, the Features column split on commas, and which evidence (if any) the row's last column names. */
function parseTasksTable(tasksSection: string): TaskRow[] {
  const rows = tasksSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
  // Row 0 is the header, row 1 the `| --- | ... |` separator.
  return rows.slice(2).map((row) => {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const [id = '', featuresCell = '', , , , evidenceCell = 'none'] = cells
    const features = featuresCell
      .split(',')
      .map((feature) => feature.trim())
      .filter((feature) => feature.length > 0 && feature !== '—' && feature !== '-')
    const word = evidenceCell.toLowerCase()
    return { id, features, word: word === 'red' || word === 'green' ? word : 'none' }
  })
}

/** A task's red fragment (the command and the fenced block after it, tailed to 20 lines) from its subsection, or null when the subsection has none. */
function redFragment(body: string): { command: string; fragment: string } | null {
  const commandMatch = /^- red: `([^`]+)`/m.exec(body)
  if (commandMatch === null) return null
  const fenceMatch = /```[a-zA-Z]*\n([\s\S]*?)\n```/.exec(body)
  return { command: commandMatch[1]!, fragment: tail(fenceMatch?.[1] ?? '', 20) }
}

/** A task's green command and exit code from its subsection, or null when the subsection has none. */
function greenLine(body: string): { command: string; code: string } | null {
  const match = /^- green: `([^`]+)` exited (\d+)/m.exec(body)
  return match === null ? null : { command: match[1]!, code: match[2]! }
}

/** `## Evidence`: every feature any task names, each with its red and green evidence (or "no recorded red run"), then one line per no-analyzers app. */
export async function evidenceByFeature(implementationMd: string, analyzers: readonly PrBodyAnalyzer[], repo: string, app: string | undefined): Promise<string> {
  const tasksSection = sectionBody(implementationMd, '## Tasks')
  const tasks = parseTasksTable(tasksSection)
  const features: string[] = []
  for (const task of tasks) for (const feature of task.features) if (!features.includes(feature)) features.push(feature)

  const lines: string[] = []
  for (const feature of features) {
    lines.push(`### ${feature}`, '')
    const named = tasks.filter((task) => task.features.includes(feature))
    let hasRed = false
    for (const task of named) {
      if (task.word !== 'red') continue
      const body = subsectionBody(tasksSection, task.id)
      const red = redFragment(body)
      if (red === null) continue
      hasRed = true
      lines.push(`- red (${task.id}): \`${red.command}\``, '', '```text', await redact(red.fragment, repo, { app }), '```', '')
    }
    if (!hasRed) lines.push('- no recorded red run', '')
    for (const task of named) {
      if (task.word !== 'green') continue
      const body = subsectionBody(tasksSection, task.id)
      const green = greenLine(body)
      if (green === null) continue
      lines.push(`- green (${task.id}): \`${green.command}\` exited ${green.code}`, '')
    }
  }
  for (const analyzer of analyzers) {
    if (analyzer.reasonCode === 'no-analyzers') lines.push(`- ${analyzer.app}: no static analysis ran (no analyzer configured for this app).`, '')
  }
  return lines.join('\n').trimEnd()
}

/** `## Merge Danger`: one-way when `## Dependencies added` flags a native addition or a changed path sits under a `migrations` directory, else two-way. */
export function mergeDanger(implementationMd: string, changedFiles: readonly string[]): string {
  const dependencies = sectionBody(implementationMd, '## Dependencies added')
  const native = /native:\s*true/i.test(dependencies)
  const migration = changedFiles.some((file) => /(^|\/)migrations\//.test(file))
  if (native || migration) {
    const why = native && migration ? 'it adds a native dependency and touches a migration' : native ? 'it adds a native dependency' : 'it touches a migration'
    return `This is a **one-way door**: ${why}, so merging it cannot be cleanly reverted without a follow-up native build or migration.`
  }
  return 'This is a **two-way door**: reverting it is a plain code revert, with no native build or migration to follow up.'
}

/** The `## What it fixed` placeholder when implementation.md has no such section, or an empty one: visible in the PR, never silently dropped. */
export const WHAT_IT_FIXED_MISSING = '_Not written: the implementation log (`plan.review/implementation.md` in the ticket folder) has no `## What it fixed` section (implementor SKILL.md, section 6 step 7). Add it there and rerun Step 8 so this description and the release page carry it; it becomes the release notes._'

/** `## What it fixed`: the implementor's summary section of implementation.md, verbatim (markdown kept, secrets redacted), or the placeholder. */
export async function whatItFixed(implementationMd: string, repo: string, app: string | undefined): Promise<string> {
  const body = sectionBody(implementationMd, '## What it fixed').trim()
  if (body === '') return WHAT_IT_FIXED_MISSING
  // An unclosed code fence in the section would swallow every section after it: close it.
  const fences = (body.match(/^\s*```/gm) ?? []).length
  return redactSecrets(fences % 2 === 1 ? `${body}\n\`\`\`` : body, repo, { app })
}

/** `## Summary`: every changed file, as a sorted bullet list (a minimal file tree: build-feature and spec-reviewer render the fuller one for the card). */
export function fileTree(changedFiles: readonly string[]): string {
  if (changedFiles.length === 0) return 'No files changed.'
  return [...changedFiles].sort((a, b) => a.localeCompare(b)).map((file) => `- \`${file}\``).join('\n')
}

/** The PR body: What it fixed (verbatim from implementation.md), then Summary, Evidence and Merge Danger from implementation.md and the branch diff, the decisions taken for the human, the run's notice, and a link to the ticket. */
export async function renderPrBody(input: PrBodyInput): Promise<string> {
  const { ticket, implementationMd, changedFiles, analyzers, taken = [], notice, footer, repo, app } = input
  const lines: string[] = []
  lines.push('## What it fixed', '', await whatItFixed(implementationMd, repo, app), '')
  lines.push('## Summary', '', fileTree(changedFiles), '')
  lines.push('## Evidence', '', await evidenceByFeature(implementationMd, analyzers, repo, app), '')
  lines.push('## Merge Danger', '', mergeDanger(implementationMd, changedFiles), '')
  if (taken.length > 0) {
    lines.push('## Decisions taken for you', '')
    for (const entry of taken) {
      const question = await redact(entry.decision.question, repo, { app })
      const answer = await redact(entry.decision.answer ?? entry.decision.recommended, repo, { app })
      lines.push(`- \`${entry.key}\`: ${question} Taken: ${answer}.`)
    }
    lines.push('')
  }
  if (notice !== undefined) lines.push(notice, '')
  lines.push(footer ?? `See the ticket: ${ticket.url}`)
  return `${lines.join('\n')}\n`
}
