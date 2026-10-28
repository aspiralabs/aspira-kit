// Step 10 (F30, F31): the repository work before the first review, and the release row after the
// review loop. The Playbook's order (playbook.ts:129-133): repo docs in the same PR, the product's
// open release page, the Notion pages to propagate; then the merge phase (merge.ts) merges and
// moves the card to Ready: Implementation. No stage here merges or makes that move.
//
// - step10Stage: a subagent updates the repo docs the change made untrue (the Playbook's list) and
//   writes the "Docs to propagate" section on the ticket (or "none"), replacing an existing one.
//   On its answer the driver adds one changeset at the fixed path .changeset/<id>-<slug>.md when a
//   package in a changesets `fixed` group changed on the branch (patch, A17; a file already there is
//   rewritten, so a rerun never adds a second), commits the docs and the changeset citing the ticket
//   and pushes through Step 8's guard, before the first pr-reviewer step.
// - releaseRowStage: after the review loop, when aspira.json names `releases`, a subagent finds the
//   open release page and drafts the customer line for the row that links this card and PR. The
//   line is refused while it names a ticket ID or a package (REL-004); an accepted line is written
//   by updating the row that already links the card, or by adding it once. With it (KIT-52) the
//   feature's `### <ID> — what it fixed` section under the Features table: the implementor's
//   `## What it fixed` section of implementation.md, verbatim, which the PR body also carries and
//   which becomes the release notes. A log without the section gets no section and a note. Without `releases` the
//   row is skipped and the end of the run says so.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { z } from 'zod'
import { readEffectiveAspira } from '@aspiralabs/ai/common/lib/aspira-config'
import { WHAT_IT_FIXED_MISSING, whatItFixed } from '@aspiralabs/ai/common/lib/pr-body'
import { slug } from '@aspiralabs/ai/common/lib/ticket'
import type { Phase, PhaseContext, PhaseResult } from '#build-feature/driver.ts'
import type { Pending, RunState } from '#build-feature/run-state.ts'
import { baseBranchOf, isExcludedPath, pushGuarded } from '#build-feature/step8.ts'
import { GIT_ARGS, parseStatus, shown, system, type System, type SystemOptions } from '#build-feature/system.ts'

/** The Status Steps 9 and 10 run in. */
const IN_REVIEW = 'In Review: Implementation'

/** The repository docs Step 10 keeps true (playbook.ts:130). */
export const REPO_DOCS = ['AGENTS.md', 'PRODUCT.md', 'docs/general/FEATURES.md', 'README.md', 'DEPLOYMENT.md', 'RELEASE.md'] as const

/** The changeset path for a ticket: one fixed file, so a rerun rewrites it rather than adding another. */
export const changesetPath = (id: string, title: string): string => `.changeset/${id.toLowerCase()}${slug(title) === '' ? '' : `-${slug(title)}`}.md`

const recordSchema = z.object({ pushed: z.boolean().default(false), commit: z.string().nullable().default(null) })
type Step10Record = z.infer<typeof recordSchema>
const recordOf = (state: RunState): Step10Record => {
  const parsed = recordSchema.safeParse(state.phases.step10 ?? {})
  return parsed.success ? parsed.data : recordSchema.parse({})
}
const withRecord = (state: RunState, patch: Partial<Step10Record>): RunState => ({ ...state, phases: { ...state.phases, step10: { ...recordOf(state), ...patch } } })

const optionsOf = (context: PhaseContext): SystemOptions => ({ cwd: context.repo, env: context.env })

const stopped = (state: RunState, message: string, action: string, command?: string): PhaseResult => ({ kind: 'stop', state, message, failure: { action, message, ...(command === undefined ? {} : { command }) } })

// ---------------------------------------------------------------------------------------------
// The changeset.
// ---------------------------------------------------------------------------------------------

const changesetConfigSchema = z.looseObject({ fixed: z.array(z.array(z.string())).default([]) })

/** The name in the nearest package.json above a file, or null when none is found below the repository root. */
async function packageOf(repo: string, file: string): Promise<string | null> {
  let dir = dirname(file)
  while (dir !== '.' && dir !== '' && dir !== '/') {
    const manifest = join(repo, dir, 'package.json')
    if (existsSync(manifest)) {
      const name = await readFile(manifest, 'utf8')
        .then((text) => (JSON.parse(text) as { name?: unknown }).name)
        .catch(() => undefined)
      return typeof name === 'string' ? name : null
    }
    dir = dirname(dir)
  }
  return null
}

/** The fixed-group packages the branch changed, from .changeset/config.json; empty when the repository has no changesets. */
export async function changedFixedPackages(repo: string, files: readonly string[]): Promise<string[]> {
  const raw = await readFile(join(repo, '.changeset/config.json'), 'utf8').catch(() => null)
  if (raw === null) return []
  let config: z.infer<typeof changesetConfigSchema>
  try {
    config = changesetConfigSchema.parse(JSON.parse(raw))
  } catch {
    return []
  }
  const fixed = new Set(config.fixed.flat())
  const names = new Set<string>()
  for (const file of files) {
    if (isExcludedPath(file) || file.startsWith('.changeset/')) continue
    const name = await packageOf(repo, file)
    if (name !== null && fixed.has(name)) names.add(name)
  }
  return [...names].sort()
}

/** The changeset text: every changed fixed-group package at patch (A17), the ticket's title as the summary. */
export const changesetText = (packages: readonly string[], id: string, title: string): string => `---\n${packages.map((name) => `"${name}": patch`).join('\n')}\n---\n\n${title.trim() === '' ? id : title.trim()} (${id})\n`

// ---------------------------------------------------------------------------------------------
// Step 10's repository work.
// ---------------------------------------------------------------------------------------------

/** A repository-relative path a subagent reports; never absolute and never above the root. */
const repoPath = z
  .string()
  .min(1)
  .transform((path) => normalize(path).replace(/^\.\//, ''))
  .refine((path) => !path.startsWith('/') && !path.startsWith('..'), { message: 'is not a path inside the repository' })

const step10Answer = z.object({ nonce: z.string(), docs: z.array(repoPath), docsToPropagate: z.string().trim().min(1) })

/** The Step 10 subagent stage, or nothing when this ticket's Step 10 commit is already on the branch. */
export async function step10Stage(context: PhaseContext, state: RunState, sys: System = system): Promise<PhaseResult> {
  if (context.card.status !== IN_REVIEW) return { kind: 'done', state }
  if (state.step10.committed) {
    if (recordOf(state).pushed) return { kind: 'done', state }
    const pushed = await pushGuarded(context, state, sys)
    if (!pushed.ok) return { kind: 'stop', state, message: pushed.message, failure: pushed.failure }
    return { kind: 'done', state: withRecord(pushed.value, { pushed: true }) }
  }
  const changeset = changesetPath(context.id, context.card.title)
  return {
    kind: 'stage',
    state,
    stage: 'step10',
    body: {
      docs: [...REPO_DOCS],
      changeset,
      notion: [
        { op: 'read', target: 'ticket' },
        { op: 'write', target: 'ticket' },
      ],
      instructions: [
        `Step 10 for ${context.id}, before the first review. In ${context.repo}, update only what this change made untrue in ${REPO_DOCS.join(', ')} (and the app's own copies of them); change no code and do not commit or push.`,
        `Then list the Notion pages the change made untrue and write them on ${context.id} as a section titled "Docs to propagate" (or the single word "none"), replacing that section when it is already there; change nothing else on the card and never move it.`,
        `The driver writes the changeset (${changeset}) itself, commits and pushes. Write {"nonce", "docs": [<repository-relative paths you changed>], "docsToPropagate": "<the list as written, or none>"} to the output file.`,
      ].join(' '),
    },
  }
}

/** The Step 10 answer: write the changeset, commit it with the docs citing the ticket, push through the guard. */
async function step10Accept(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>, sys: System = system): Promise<PhaseResult> {
  const parsed = step10Answer.safeParse(answer)
  if (!parsed.success) return stopped(state, `the Step 10 answer at ${pending.output} is not what the stage asked for: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; ')}`, 'step10')
  const options = optionsOf(context)
  const packages = await changedFixedPackages(context.repo, await sys.gitBranchFiles(options, baseBranchOf(context.aspira)))
  const changeset = packages.length === 0 ? null : changesetPath(context.id, context.card.title)
  if (changeset !== null) {
    await mkdir(dirname(join(context.repo, changeset)), { recursive: true })
    await writeFile(join(context.repo, changeset), changesetText(packages, context.id, context.card.title))
  }
  const status = await sys.gitStatus(options)
  if (status.code !== 0) return stopped(state, `the run could not read the working tree after Step 10: ${status.stderr.trim()}`, 'git status', shown('git', GIT_ARGS.status))
  const changed = parseStatus(status.stdout)
    .map((entry) => entry.path)
    .filter((path) => !isExcludedPath(path))
  const allowed = new Set([...parsed.data.docs, ...(changeset === null ? [] : [changeset])])
  const outside = changed.filter((path) => !allowed.has(path))
  if (outside.length > 0) return stopped(state, `Step 10 left changes outside the docs it reported and the changeset: ${outside.join(', ')}. Nothing was committed or pushed; commit or remove them, then resume`, 'step10')
  let next: RunState = { ...state, step10: { ...state.step10, changeset, docsToPropagate: parsed.data.docsToPropagate } }
  if (changed.length > 0) {
    const message = `${context.id}: Step 10 docs${changeset === null ? '' : ' and changeset'}`
    const committed = await sys.gitCommit(options, changed, message)
    if (committed.code !== 0) return stopped(next, `the Step 10 commit failed: ${(committed.stderr.trim() || committed.stdout.trim()).slice(-2000)}`, 'commit', shown('git', ['commit', '-m', message, '--', ...changed]))
    const head = await sys.gitHead(options)
    next = withRecord(next, { commit: head.code === 0 ? head.stdout.trim() : null })
  }
  next = { ...next, step10: { ...next.step10, committed: true } }
  const pushed = await pushGuarded(context, next, sys)
  if (!pushed.ok) return { kind: 'stop', state: withRecord(next, { pushed: false }), message: pushed.message, failure: pushed.failure }
  return { kind: 'done', state: withRecord(pushed.value, { pushed: true }) }
}

/** The driver's Step 10 phase (PHASE_MODULES.step10). */
export const step10Phase: Phase = {
  next: (context, state) => step10Stage(context, state),
  accept: (context, state, pending, answer) => step10Accept(context, state, pending, answer),
}

// ---------------------------------------------------------------------------------------------
// The release row.
// ---------------------------------------------------------------------------------------------

const TICKET_ID = /\b[A-Z]+-\d+\b/
const PACKAGE_NAME = /@[\w.-]+\/[\w.-]+/

/** REL-004: the customer line says what users can now do; no ticket ID and no package name. */
export function validateCustomerLine(line: string): { ok: true; line: string } | { ok: false; reason: string } {
  const text = line.trim()
  if (text === '') return { ok: false, reason: 'the customer line is empty' }
  const ticket = TICKET_ID.exec(text)?.[0]
  if (ticket !== undefined) return { ok: false, reason: `the customer line names the ticket ID ${ticket}; REL-004: say what users can now do, with no ticket IDs or internal names` }
  const name = PACKAGE_NAME.exec(text)?.[0]
  if (name !== undefined) return { ok: false, reason: `the customer line names the package ${name}; REL-004: say what users can now do, with no ticket IDs or internal names` }
  return { ok: true, line: text }
}

export const RELEASE_SKIPPED = 'Release row skipped: aspira.json names no `releases` page, so add the customer line, the card and the PR to the open release page by hand (REL-002).'

const draftAnswer = z.object({ nonce: z.string(), customerLine: z.string(), existingRow: z.boolean() })

/** The feature's section for the release page (KIT-52): the heading `### <ID> — what it fixed` and the log's section verbatim, or null when the log has none. */
export async function whatItFixedSection(folder: string, id: string, repo: string, app?: string): Promise<{ heading: string; text: string } | null> {
  const log = await readFile(join(folder, 'plan.review/implementation.md'), 'utf8').catch(() => '')
  const text = await whatItFixed(log, repo, app)
  if (text === WHAT_IT_FIXED_MISSING) return null
  return { heading: `### ${id} — what it fixed`, text }
}
const writeAnswer = z.union([z.object({ nonce: z.string(), done: z.literal(true) }), z.object({ nonce: z.string(), error: z.string().min(1) })])

function draftStage(context: PhaseContext, state: RunState, releases: string, error?: string): PhaseResult {
  const pr = state.step8.prUrl ?? context.card.pr
  return {
    kind: 'stage',
    state,
    stage: 'release-row',
    body: {
      part: 'draft',
      releases,
      card: context.card.url,
      pr,
      ...(error === undefined ? {} : { error }),
      notion: [{ op: 'read', target: 'release-page' }],
      instructions: [
        ...(error === undefined ? [] : [`Your last draft was refused: ${error}.`]),
        `Find the open release page under ${releases} (read only for now) and look for a Features row that links ${context.card.url} or ${pr ?? 'this PR'}.`,
        'Draft the customer line for this change: what users can now do, in one sentence, with no ticket IDs and no package or internal names (REL-004).',
        'Write {"nonce", "customerLine", "existingRow": <true when a row already links this card>} to the output file. Change nothing on the page yet.',
      ].join(' '),
    },
    data: { part: 'draft', releases },
  }
}

/** The release-row stage after the review loop, or nothing when it is written or aspira.json names no releases. */
export async function releaseRowStage(context: PhaseContext, state: RunState): Promise<PhaseResult> {
  if (context.card.status !== IN_REVIEW) return { kind: 'done', state }
  // statusFlow false (KIT-68): the client's board has no release flow, so no release row.
  if (readEffectiveAspira(context.repo).config.statusFlow === false) return { kind: 'done', state }
  const releases = context.aspira.releases
  if (releases === undefined || releases.trim() === '') return { kind: 'done', state, note: RELEASE_SKIPPED }
  if (state.step10.releaseRow !== null) return { kind: 'done', state }
  return draftStage(context, state, releases)
}

async function releaseRowAccept(context: PhaseContext, state: RunState, pending: Pending, answer: Record<string, unknown>): Promise<PhaseResult> {
  const releases = String(pending.data?.releases ?? context.aspira.releases ?? '')
  if (pending.data?.part === 'write') {
    const action = String(pending.data.action)
    const parsed = writeAnswer.safeParse(answer)
    if (!parsed.success || 'error' in parsed.data) return stopped(state, `the release row could not be written: ${parsed.success && 'error' in parsed.data ? parsed.data.error : 'the answer did not say it was done'}`, 'release-row')
    return { kind: 'done', state: { ...state, step10: { ...state.step10, releaseRow: action } } }
  }
  const parsed = draftAnswer.safeParse(answer)
  if (!parsed.success) return draftStage(context, state, releases, 'the answer was not {"customerLine", "existingRow"}')
  const line = validateCustomerLine(parsed.data.customerLine)
  if (!line.ok) return draftStage(context, state, releases, line.reason)
  const action = parsed.data.existingRow ? 'update' : 'add'
  const pr = state.step8.prUrl ?? context.card.pr
  const section = await whatItFixedSection(context.folder, context.id, context.repo, context.aspira.app)
  const sectionInstruction = section === null ? ' The implementation log has no `## What it fixed` section, so add no section for this feature.' : ` Then paste the "whatItFixed" text verbatim under the Features table as the feature's own section: it starts with its own heading "${section.heading}", so add no heading of your own, and replace the section with that heading when one is already there.`
  return {
    kind: 'stage',
    state,
    stage: 'release-row',
    body: {
      part: 'write',
      releases,
      write: { action, customerLine: line.line, card: context.card.url, pr, ...(section === null ? {} : { whatItFixed: `${section.heading}\n\n${section.text}` }) },
      notion: [{ op: 'write', target: 'release-page' }],
      instructions:
        action === 'update'
          ? `On the open release page under ${releases}, update the Features row that links ${context.card.url}: set its customer line to the "customerLine" given, and link the card and ${pr ?? 'the PR'}. Add no second row.${sectionInstruction} Merge nothing and move no card. Write {"nonce", "done": true}, or {"nonce", "error"}, to the output file.`
          : `On the open release page under ${releases}, add one Features row with the "customerLine" given, linking ${context.card.url} and ${pr ?? 'the PR'}, unless a row linking the card appeared meanwhile (then update that one).${sectionInstruction} Merge nothing and move no card. Write {"nonce", "done": true}, or {"nonce", "error"}, to the output file.`,
    },
    data: { part: 'write', releases, action },
  }
}

/** The driver's release-row phase (PHASE_MODULES['release-row']). */
export const releaseRowPhase: Phase = {
  next: releaseRowStage,
  accept: releaseRowAccept,
}
