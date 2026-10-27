// Test-only support for the client-root build-feature test (KIT-68 P8, seam S1: the driver CLI
// `scripts/local.ts <ID>`, observed through the JSON stage it prints, git state and the files it writes).
// It sits beside driver.test-helper.ts so the existing tests stay unedited, and reuses its constants, stage
// types and step export fixtures. What is new is the layout: a client root that is NOT a git repository,
// holding aspira.json {board, statusFlow:false, pullRequest:false, guidelines, workRoot, repos}, a guidelines
// folder, and two git repositories (web/, api/), each with a bare origin.
//
// Nothing here mocks a module the kit owns (TEST-007). The boundaries are stood in for exactly as
// driver.test-helper.ts does: git is the real binary behind a wrapper that logs its arguments, `gh` and `pnpm`
// are fake executables on PATH (gh records every call, so "no PR" is checkable), time is BUILD_FEATURE_NOW.
// NOTION_TOKEN and NOTION_API_KEY are never passed to the driver, so it reaches Notion only through the stages
// it prints: the "mock Notion" is the session's side of that boundary. `notion` records every Notion action the
// printed stages ask for (reads and writes) and every Status move, PR write and release row the session is
// asked to make, and answers the card and the Grooming Decisions page from its own state. The fake step
// launchers write each step's export (writeStepExport) and the implementor commits one file in the worktree.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { renderGroomPage } from '@aspiralabs/ai/common/lib/decisions'
import { rebuildGroomRecord, type GroomDecision, type GroomRecord } from '@aspiralabs/ai/common/lib/groom-record'
import { commandApp } from './step-results.ts'
import { BOARD, DRIVER, ID, NOW, PACKAGE, SLUG, STEP_SKILLS, TICKET_URL, TITLE, decisionsMarkdown, writeStepExport, type Result, type Stage, type StepReportOptions } from './driver.test-helper.ts'

const exec = promisify(execFile)
const LOADER = join(PACKAGE, '..', 'node_modules/amaro/dist/register-strip.mjs')
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(PACKAGE, '..', 'package.json'), 'utf8')) as { version: string }).version

export const BRANCH = 'feat/kit-11-x'
export const REVIEW_RULE = 'REV-001'
export const worktreeIn = (repo: string): string => join(repo, '.worktrees', 'FEATURE-KIT-11')

/** What the mock Notion recorded of the session's side of the boundary. */
export type Notion = {
  /** Every Notion action a printed stage asked for: { stage, op, target, page }. */
  requests: { stage: string; op: string; target: string; page?: string }[]
  /** The Status moves the session was asked to make. */
  moves: { from: unknown; to: unknown }[]
  /** The PR property writes the session was asked to make. */
  prWrites: string[]
  /** Release rows the session was asked to draft or write. */
  releaseRows: number
}

type Settings = {
  /** The card's Area tags. */
  areas: string[]
  /** repos.api: base branch develop (origin has only develop), an app directory and gates. */
  apiDevelop?: boolean
  /** Edit the client aspira.json before it is written (null deletes a key). */
  edit?: (config: Record<string, unknown>) => Record<string, unknown>
  /** Where the session starts: the client root (default) or inside a mapped repo. */
  startIn?: 'client' | 'web' | 'api'
  /** The Grooming Decisions page the mock Notion holds: a second question as a blocking follow-up, a build-may-go-on one, or answered. */
  groomPage?: 'plain' | 'blocking' | 'goes-on' | 'resolved'
}

const temps: string[] = []
export async function cleanupClient(): Promise<void> {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
}

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])

async function makeRepo(dir: string, origins: string, name: string, branch: string, github: string, files: Record<string, string>) {
  const repo = join(dir, 'client', name)
  const origin = join(origins, `${name}.git`)
  await mkdir(repo, { recursive: true })
  await exec('git', ['init', '-q', '--bare', '-b', branch, origin])
  await exec('git', ['init', '-q', '-b', branch, repo])
  await git(repo, 'remote', 'add', 'origin', github)
  await git(repo, 'config', `url.${origin}.insteadOf`, github)
  await git(repo, 'config', `url.${origin}.pushInsteadOf`, github)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'init')
  await git(repo, 'push', '-q', 'origin', branch)
  return { repo, origin, head: (await git(repo, 'rev-parse', 'HEAD')).stdout.trim() }
}

const FAKE_GH = `#!/bin/bash
n=$(/bin/ls "$GH_DIR/calls" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
/bin/mkdir -p "$GH_DIR/calls/$n"
printf '%s\\n' "$@" > "$GH_DIR/calls/$n/args"
exit 0
`

export type ClientProject = Awaited<ReturnType<typeof clientProject>>

export async function clientProject(settings: Settings) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-client-')))
  temps.push(dir)
  const client = join(dir, 'client')
  const origins = join(dir, 'origins')
  const bin = join(dir, 'bin')
  const ghDir = join(dir, 'gh')
  const gitLog = join(dir, 'git.log')
  const pnpmLog = join(dir, 'pnpm.log')
  await mkdir(join(ghDir, 'calls'), { recursive: true })
  await mkdir(bin)
  await mkdir(origins)
  await writeFile(gitLog, '')
  await writeFile(pnpmLog, '')

  const web = await makeRepo(dir, origins, 'web', 'main', 'https://github.com/aspiralabs/web.git', {
    'README.md': '# web\n',
    'src/app.ts': 'export const app = 1\n',
    '.gitignore': 'node_modules/\n',
  })
  const apiBranch = settings.apiDevelop === true ? 'develop' : 'main'
  const api = await makeRepo(dir, origins, 'api', apiBranch, 'https://github.com/aspiralabs/api.git', {
    'README.md': '# api\n',
    'src/app.ts': 'export const app = 1\n',
    'service/package.json': JSON.stringify({ name: 'service', private: true, scripts: { 'api-check': 'echo ok' } }),
    // A lock file makes the install the fake pnpm on PATH (no npm there).
    'service/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    '.gitignore': 'node_modules/\n',
  })

  // The client root: not a git repository.
  await mkdir(join(client, 'guidelines'), { recursive: true })
  await writeFile(join(client, 'guidelines', '01-review.md'), `# Review\n\n**${REVIEW_RULE}** Review every change against its spec.\n`)
  await writeFile(join(client, 'guidelines', '02-style.md'), '# Style\n\n**STY-001** Keep it small.\n')
  const base: Record<string, unknown> = {
    board: BOARD,
    statusFlow: false,
    pullRequest: false,
    guidelines: 'guidelines',
    workRoot: '.work',
    repos: {
      web: { path: 'web' },
      api: settings.apiDevelop === true ? { path: 'api', baseBranch: 'develop', app: 'service', gates: [{ cwd: 'service', command: 'pnpm api-check' }] } : { path: 'api' },
    },
  }
  const config = settings.edit === undefined ? base : settings.edit(base)
  await writeFile(join(client, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)

  // The global harness keeps each skill's .kit-version under HOME (this run's temp dir).
  for (const step of STEP_SKILLS) {
    await mkdir(join(dir, '.claude', 'skills', `aspira-${step}`), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', `aspira-${step}`, '.kit-version'), `${PACKAGE_VERSION}\n`)
  }

  const realGit = (await exec('/usr/bin/which', ['git'])).stdout.trim()
  await writeFile(join(bin, 'git'), `#!/bin/bash\n{ printf '%s\\x1f' "$@"; printf '\\n'; } >> "$GIT_LOG"\nexec ${realGit} "$@"\n`, { mode: 0o755 })
  await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  await writeFile(join(bin, 'pnpm'), `#!/bin/bash\nprintf '%s %s\\n' "$PWD" "$*" >> "$PNPM_LOG"\n`, { mode: 0o755 })
  await symlink(process.execPath, join(bin, 'node'))

  const startIn = settings.startIn ?? 'client'
  let repo = startIn === 'client' ? client : startIn === 'web' ? web.repo : api.repo
  const folder = join(client, '.work', SLUG)
  const stateDir = join(folder, '.local', 'build-feature')
  const card = { found: true, status: 'Backlog', pr: null as string | null, dev: null as string | null, title: TITLE, type: 'Feature', area: settings.areas }
  const notion: Notion = { requests: [], moves: [], prWrites: [], releaseRows: 0 }
  const stages: Stage[] = []
  let runId: string | undefined
  let lastStart: string[] = []
  let lastText = ''
  let page: NonNullable<Settings['groomPage']> = settings.groomPage ?? 'plain'

  const env = (): NodeJS.ProcessEnv => {
    const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, ...rest } = process.env
    return { ...rest, PATH: `${bin}:/usr/bin:/bin`, HOME: dir, GIT_LOG: gitLog, PNPM_LOG: pnpmLog, GH_DIR: ghDir, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', BUILD_FEATURE_NOW: NOW, BUILD_FEATURE_AGENT_DIR: '' }
  }

  async function call(args: string[]): Promise<Result> {
    const outcome = await exec(process.execPath, ['--import', LOADER, DRIVER, ID, '--repo', repo, ...args], { cwd: repo, env: env() }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
    lastText = `exit ${outcome.code}\n${outcome.stdout}\n${outcome.stderr}`
    let stage: Stage | null = null
    try {
      const parsed: unknown = JSON.parse(outcome.stdout)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Stage).stage === 'string') stage = parsed as Stage
    } catch {
      stage = null
    }
    if (stage !== null) {
      stages.push(stage)
      if (typeof stage.runId === 'string') runId = stage.runId
      for (const action of (stage.notion ?? []) as { op: string; target: string; page?: string }[]) notion.requests.push({ stage: stage.stage, ...action })
      if (stage.stage === 'move') notion.moves.push({ from: stage.from, to: stage.to })
      if (stage.stage === 'set-pr') notion.prWrites.push(String(stage.url))
      if (stage.stage === 'release-row') notion.releaseRows += 1
    }
    return { code: outcome.code, stage, text: `${outcome.stdout}\n${outcome.stderr}` }
  }

  /** The Grooming Decisions page the mock Notion holds, rendered by the real page renderer. */
  function groomPage(): string {
    const question = (id: string, text: string, extra: Record<string, unknown>): GroomDecision =>
      ({
        id,
        question: text,
        options: ['Option A', 'Option B'],
        recommended: 'Option A',
        reasoning: 'It matches how the code already behaves',
        whyYours: 'It changes what the product does',
        branch: 'problem',
        facts: [],
        decidedBy: 'author',
        answer: 'Option A',
        ...extra,
      }) as unknown as GroomDecision
    // A follow-up is a recorded state of a question with its kind (F15, groom-follow-up.test.ts): neither open nor decided.
    const second =
      page === 'blocking'
        ? question('Q2', 'Which payment provider?', { decidedBy: 'follow-up', followUp: 'blocks', answer: null })
        : page === 'goes-on'
          ? question('Q2', 'Which payment provider?', { decidedBy: 'follow-up', followUp: 'may-go-on', answer: null })
          : question('Q2', 'Which payment provider?', { answer: 'Option B' })
    const record: GroomRecord = {
      decisions: [question('Q1', 'Who is it for?', {}), second],
      branches: [],
      round: 1,
      startedAt: NOW,
      open: 0,
      page: {},
      status: 'ready',
      reasonCode: null,
      reason: null,
    }
    return renderGroomPage(record, { date: '2026-10-12', notes: [] })
  }

  const h = {
    dir,
    client,
    web: web.repo,
    api: api.repo,
    origins: { web: web.origin, api: api.origin },
    heads: { web: web.head, api: api.head },
    apiBranch,
    get repo() {
      return repo
    },
    folder,
    stateDir,
    card,
    notion,
    stages,
    get runId() {
      return runId
    },
    get text() {
      return lastText
    },
    cd(target: string) {
      repo = target
    },
    /** The mock Notion's Grooming Decisions page changes: the author answered the follow-up, or turned it into one that lets the build go on. */
    setGroomPage(next: NonNullable<Settings['groomPage']>) {
      page = next
    },
    groomPageText: groomPage,
    start: (extra: string[] = []) => {
      lastStart = extra
      return call(extra)
    },
    next: (extra: string[] = []) => call(runId === undefined ? extra : ['--run', runId, ...extra]),

    async answer(stage: Stage | null | undefined, answer: Record<string, unknown>) {
      if (stage === null || stage === undefined) throw new Error(`expected a stage to answer; the driver printed none:\n${lastText.slice(-2000)}`)
      if (typeof stage.output !== 'string') throw new Error(`the ${stage.stage} stage names no output file: ${JSON.stringify(stage)}`)
      await mkdir(dirname(stage.output), { recursive: true })
      await writeFile(stage.output, JSON.stringify({ nonce: stage.nonce, ...answer }, null, 2))
    },

    resolution: (): Record<string, unknown> => ({ found: true, id: ID, title: card.title, url: TICKET_URL, status: card.status, pr: card.pr, dev: card.dev, type: card.type, area: card.area }),

    /** Write the mock Grooming Decisions page (and an empty page for every other step) where an overrides stage asks for it. */
    async pull(stage: Stage) {
      const pages = (stage.pages ?? {}) as Record<string, string>
      for (const [step, path] of Object.entries(pages)) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, step === 'groomer' ? groomPage() : '# Decisions\n')
      }
      await h.answer(stage, {})
    },

    /** Report a step as its fake launcher would: the export it leaves in the ticket folder, and for the implementor one committed file. */
    async report(stage: Stage, status: string, options: StepReportOptions = {}) {
      const step = String(stage.step)
      if (step === 'groomer' && page !== 'plain') {
        // The groomer rebuilds groom.json from the Grooming Decisions page, as it does at every round start (KIT-23).
        const { record } = rebuildGroomRecord(groomPage())
        await mkdir(join(folder, 'groom/trace'), { recursive: true })
        await writeFile(join(folder, 'groom/trace/groom.json'), JSON.stringify({ ...record, page: { url: 'https://app.notion.com/p/grooming-decisions' } }, null, 2))
        await writeFile(join(folder, 'groom/trace/decisions.md'), decisionsMarkdown([]))
      } else await writeStepExport(folder, repo, step, status, step === 'code-analyzer' && options.app === undefined ? { ...options, app: commandApp(String(stage.command)) } : options)
      if (step === 'implementor') {
        await mkdir(join(repo, 'src'), { recursive: true })
        await writeFile(join(repo, 'src/feature.ts'), 'export const feature = 1\n')
        await git(repo, 'add', 'src/feature.ts')
        await git(repo, 'commit', '-qm', 'KIT-11: build')
      }
      await h.answer(stage, { step, status, resultLine: options.resultLine ?? `${step}: ${status}`, usage: options.usage === undefined ? { tokens: 1000, wallMs: 60000 } : options.usage })
    },

    /**
     * Answer every stage as the session would, with each step succeeding, until `until` says stop (it sees each printed stage
     * before it is answered), a stage the test does not handle, or the end stage. Returns the last result.
     */
    async advance(options: { until?: (stage: Stage) => boolean; from?: Result } = {}): Promise<Result> {
      let result = options.from ?? (await h.next())
      for (let turn = 0; turn < 150; turn += 1) {
        const stage = result.stage
        if (stage === null || stage.stage === 'end') return result
        if (options.until?.(stage) === true) return result
        if (stage.stage === 'resolve') await h.answer(stage, h.resolution())
        else if (stage.stage === 'overrides') await h.pull(stage)
        else if (stage.stage === 'worktree') {
          h.cd(String(stage.worktree))
          if (typeof stage.output === 'string') await h.answer(stage, {})
          else {
            result = await h.start(lastStart)
            continue
          }
        } else if (stage.stage === 'step') await h.report(stage, SUCCESS[String(stage.step)] ?? DONE)
        else if (stage.stage === 'gate') await h.answer(stage, { results: ((stage.commands ?? []) as string[]).map((command) => ({ command, exitCode: 0, output: 'ok' })) })
        else if (stage.stage === 'step10') await h.answer(stage, { docs: [], docsToPropagate: 'none' })
        else if (stage.stage === 'fix') await h.answer(stage, { decisions: [], usage: { tokens: 10, wallMs: 1000 } })
        else if (stage.stage === 'visual-verify') await h.answer(stage, { status: 'skipped', skipReason: 'no Chrome tool in this session', viewport: '1280px wide', findings: [], notExercised: [], backendNotDeployed: [], noData: [], screenshots: [] })
        else if (stage.stage === 'summary') {
          if (typeof stage.rules === 'string') {
            await mkdir(dirname(stage.rules), { recursive: true })
            await writeFile(stage.rules, '# Feature Board\n\n**BOARD-003 — MUST** push outputs as child pages under fixed titles: Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review, Grooming Decisions.\n')
            await h.answer(stage, {})
          } else await h.answer(stage, { pushed: stage.push !== null && stage.push !== undefined })
        } else if (stage.stage === 'telemetry') await h.answer(stage, { error: 'telemetry is not attached in this fixture' })
        // A stage a client run must never print is still answered, so the test sees it in the record instead of hanging.
        else if (stage.stage === 'move') await h.answer(stage, { done: true })
        else if (stage.stage === 'set-pr') await h.answer(stage, { done: true })
        else if (stage.stage === 'release-row') await h.answer(stage, { customerLine: 'x', existingRow: null })
        else if (stage.stage === 'merge') await h.answer(stage, { merged: true })
        // Any other stage that asks for pulled pages (the Grooming Decisions page at a rerun) gets the mock Notion's pages.
        else if (typeof stage.pages === 'object' && stage.pages !== null && typeof stage.output === 'string') await h.pull(stage)
        else return result
        result = await h.next()
      }
      throw new Error(`the driver did not reach an end; last: ${JSON.stringify(result.stage)}`)
    },

    async state(): Promise<Record<string, unknown> & { approvals?: Record<string, unknown>[]; phases?: Record<string, { status?: string; skipReason?: string } | undefined> }> {
      return JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as Record<string, unknown>
    },
    summary: () => readFile(join(folder, 'build-summary.md'), 'utf8').catch(() => ''),

    /** Every gh call. */
    async ghCalls(): Promise<string[][]> {
      const calls = join(ghDir, 'calls')
      const names = (await readdir(calls)).sort((a, b) => Number(a) - Number(b))
      return Promise.all(names.map(async (name) => (await readFile(join(calls, name, 'args'), 'utf8')).split('\n').filter((line) => line !== '')))
    },
    /** Every git call the driver made, as argument lists. */
    async gitCalls(): Promise<string[][]> {
      return (await readFile(gitLog, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('\x1f').filter((arg) => arg !== ''))
    },
    /** A git command's output; the failure text when it fails (a run that never got far enough leaves nothing to read, and the assertion shows that). */
    git: (cwd: string, ...args: string[]) =>
      git(cwd, ...args).then(
        (r) => r.stdout.trim(),
        (error: { stderr?: string }) => `<git ${args.join(' ')} failed: ${String(error.stderr ?? '').split('\n')[0]}>`,
      ),
    /** The branches a bare origin holds, with their heads. */
    async originHeads(origin: string): Promise<Record<string, string>> {
      const { stdout } = await exec('git', ['-C', origin, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
      return Object.fromEntries(stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ') as [string, string]))
    },
    exists: (path: string) => existsSync(path),
    appendExclude: (repoDir: string, line: string) => appendFile(join(repoDir, '.git/info/exclude'), `${line}\n`),
  }
  return h
}

/** The status each step reports when it finished well. */
const DONE = ['com', 'plete'].join('')
const SUCCESS: Record<string, string> = { groomer: ['con', 'firmed'].join(''), 'spec-writer': 'ready', planner: 'ready', implementor: DONE, 'code-analyzer': ['cl', 'ean'].join(''), 'pr-reviewer': DONE }

