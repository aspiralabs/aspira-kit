// Test-only support shared by the implementor --local driver's own tests (local-branch.test.ts,
// export-record.test.ts, verify-pr-url.test.ts): a real temp git repository, a ticket.md as the
// session's resolve would leave it, a reviewed plan fixture, and the driver (scripts/local.ts) run as
// a real child process, observed through the JSON it prints to stdout (TEST-003, TEST-007). Nothing
// here mocks a module the kit owns. NOTION_TOKEN, NOTION_API_KEY and AI_GATEWAY_API_KEY are stripped
// from every environment the driver runs in.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderTicketMd, workFolderName, type TicketRecord } from '@aspiralabs/agent-common/lib/ticket'

const exec = promisify(execFile)

export const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
export const DRIVER = join(PACKAGE, 'scripts/local.ts')

export const ID = 'KIT-2'
export const TITLE = 'Every skill writes a progress note'
export const TICKET_TYPE = 'Feature'
/**
 * ticketBranch(ID, TITLE, TICKET_TYPE) (GIT-001), hardcoded rather than imported: `ticketBranch`
 * lives in `@aspiralabs/build-feature`, which this package does not (and must not) depend on.
 */
export const BRANCH = 'feat/kit-2-every-skill-writes-a-progress-note'
export const FOLDER_NAME = workFolderName({ id: ID, title: TITLE })
export const TICKET_URL = 'https://app.notion.com/p/kit-2-0000000000000000000000000002'
export const BOARD = 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad'
export const REPOSITORY = 'aspiralabs/kit'

const temps: string[] = []
export async function cleanup(): Promise<void> {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
}

export const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
export const head = async (cwd: string): Promise<string> => (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim()

/** A real git checkout, with aspira.json at its root, on `branch` (default: the ticket's own branch). */
export async function repo(options: { branch?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'implementor-driver-'))
  temps.push(dir)
  const root = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', options.branch ?? BRANCH, root])
  await writeFile(join(root, 'aspira.json'), `${JSON.stringify({ board: BOARD, repository: REPOSITORY }, null, 2)}\n`)
  await writeFile(join(root, 'README.md'), '# kit\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-qm', 'init')
  return root
}

/** ticket.md as the session's resolve action would have written it (ticket.ts's renderTicketMd). */
export async function writeTicket(root: string, options: { status: string; pr?: string; dev?: string; title?: string }): Promise<string> {
  const folder = join(root, '.work', FOLDER_NAME)
  await mkdir(folder, { recursive: true })
  const record: TicketRecord = {
    id: ID,
    title: options.title ?? TITLE,
    url: TICKET_URL,
    status: options.status,
    type: TICKET_TYPE,
    area: [],
    pulledAt: new Date().toISOString(),
    idea: 'Build it.',
    pages: {},
    ...(options.dev === undefined ? {} : { dev: options.dev }),
    ...(options.pr === undefined ? {} : { pr: options.pr }),
  }
  await writeFile(join(folder, 'ticket.md'), renderTicketMd(record))
  return folder
}

/** A reviewed plan (plan.review/) the implementor consumes: one task touching `app` (default packages/a). */
export async function writePlan(folder: string, options: { repoCommit?: string; app?: string } = {}): Promise<void> {
  const app = options.app ?? 'packages/a'
  const dir = join(folder, 'plan.review')
  await mkdir(join(dir, 'trace'), { recursive: true })
  await writeFile(join(dir, 'plan.reviewed.md'), '# Plan\n\nAdd a.\n')
  await writeFile(join(dir, 'trace/review.json'), JSON.stringify({ status: 'ready', problems: [], decisions: [], ...(options.repoCommit === undefined ? {} : { repoCommit: options.repoCommit }) }, null, 2))
  await writeFile(
    join(dir, 'trace/plan.json'),
    JSON.stringify(
      {
        summary: 'Add a.',
        tasks: [{ id: 'P1', title: 'Add a', kind: 'implementation', featureIds: ['F1'], dependsOn: [], testIds: [], changes: [{ operation: 'create', path: `${app}/src/index.ts`, symbols: ['a'], instructions: 'Add it.', evidence: ['e'] }], commands: [], outcome: 'done' }],
        tests: [],
        checks: [],
        decisions: [],
        gaps: [],
      },
      null,
      2,
    ),
  )
}

/** A --guidelines snapshot so the knowledge stage needs no live Notion pages. */
export async function writeGuidelines(root: string): Promise<string> {
  const file = join(root, 'guidelines.md')
  await writeFile(file, '<!-- Required reading · 1 page · fetched 2026-10-14T00:00:00.000Z -->\n\n# Agent Instructions\n\nMUST read this in full.\n')
  return file
}

export type DriverResult = { code: number; stdout: string; stderr: string; json: Record<string, unknown> | null }

/** Runs scripts/local.ts as a real child process (Node's own type stripping; no shell launcher). */
export async function runDriver(args: string[], options: { cwd: string; env?: Record<string, string | undefined> }): Promise<DriverResult> {
  const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, AI_GATEWAY_API_KEY: _gateway, ...rest } = process.env
  const env = { ...rest, ...options.env }
  const outcome = await exec(process.execPath, ['--experimental-strip-types', DRIVER, ...args], { cwd: options.cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  )
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(outcome.stdout)
    if (parsed !== null && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch {
    json = null
  }
  return { ...outcome, json }
}

export const readTicketFile = (folder: string): Promise<string> => readFile(join(folder, 'ticket.md'), 'utf8')

/**
 * The orchestrator's own outputs for a one-task, one-wave, no-worker plan, so a single driver call
 * (everything else already on disk) walks the whole --local build straight through to its end,
 * exactly as a real session's replies would, with no live model call (TEST-007).
 */
async function writeOrchestratorOutputs(folder: string, commit: string): Promise<void> {
  const outputs = join(folder, 'plan.review/implementation.local/outputs')
  await mkdir(outputs, { recursive: true })
  await writeFile(join(outputs, 'parallelize.json'), JSON.stringify({ waves: [{ lanes: [{ id: 'L1', tasks: ['P1'], worker: false, writeScope: ['packages/a/src/index.ts'], rules: [], ui: '' }] }], inferredEdges: [], notes: '' }, null, 2))
  await writeFile(join(outputs, 'wave-1.json'), JSON.stringify({ status: 'committed', commit, tasks: [{ id: 'P1', status: 'done' }], notes: '' }, null, 2))
  await writeFile(
    join(outputs, 'verification.json'),
    JSON.stringify(
      { status: 'done', features: [{ id: 'F1', tasks: ['P1'], tests: [], passing: true }], deviations: [], blockers: [], assumptions: [], dependenciesAdded: [], notesRewritten: [], slopEntries: [], slopJustification: 'None: no bugs were found and fixed.' },
      null,
      2,
    ),
  )
  await writeFile(join(folder, 'plan.review/implementation.md'), '## Dependencies added\n\nNone.\n\n## Mid-build notes\n\nNone.\n\n## Proposed Slop Repo entries\n\nNone: no bugs were found and fixed.\n')
}

/**
 * A full --local build driven to its end with no live model call: a repo on BRANCH with an app
 * directory added after `C0`, a ticket already claimed into In Progress: Implementation, a reviewed
 * plan whose repoCommit is C0, and every orchestrator output already on disk. The resolve round-trip
 * every --local call needs once is already spent, so the next driver call runs the whole build and
 * exports it (`export const ... finishes the real pipeline, not a hand-written fixture`).
 */
export async function buildReady(options: { app?: string } = {}): Promise<{ root: string; folder: string; commit: string; guidelines: string }> {
  const app = options.app ?? 'packages/a'
  const root = await repo()
  const c0 = await head(root)
  await mkdir(join(root, app, 'src'), { recursive: true })
  await writeFile(join(root, app, 'package.json'), JSON.stringify({ name: app.split('/').at(-1) }, null, 2))
  await git(root, 'add', '.')
  await git(root, 'commit', '-qm', `${app}: scaffold`)
  const folder = await writeTicket(root, { status: 'In Progress: Implementation', dev: 'Claude' })
  await writePlan(folder, { repoCommit: c0, app })
  const commit = await head(root)
  await writeOrchestratorOutputs(folder, commit)
  const guidelines = await writeGuidelines(root)
  await runDriver(['--repo', root, '--ticket', ID, '--guidelines', guidelines], { cwd: root })
  // The resolve round-trip's "session" rewrites ticket.md, making it current for the next call.
  await writeFile(join(folder, 'ticket.md'), await readTicketFile(folder))
  await runDriver(['--repo', root, '--ticket', ID, '--guidelines', guidelines], { cwd: root })
  return { root, folder, commit, guidelines }
}
