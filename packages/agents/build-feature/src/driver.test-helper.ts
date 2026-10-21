// Test-only support for the build-feature driver tests (seam S1: the driver CLI `scripts/local.ts <ID>`
// as `build-feature.sh local` runs it, observed through the JSON stage it prints and the files it
// writes under `.work/<id>-<slug>/`). Nothing here mocks a module the kit owns (TEST-007): the
// project is a real temp git repository with a bare origin, `git` is the real binary behind a
// wrapper that only logs its arguments, `gh` is a fake executable on PATH (the system boundary),
// time is injected through BUILD_FEATURE_NOW, and the answers the session would get from the
// Notion MCP (card resolution, notion-get-self, pulled pages) are written as stage answer files.
// NOTION_TOKEN and NOTION_API_KEY are never passed to the driver.
//
// The stage contract these tests pin (the driver prints exactly one JSON object per call):
//   { stage, runId, nonce?, output?, ... }  stage is one of resolve, approval, overrides, worktree,
//   step, ask, move, set-pr, gate, step10, fix, release-row, summary, telemetry, end. A stage that needs an answer has a
//   `nonce` and an `output` path; the session writes `{ nonce, ...answer }` as JSON to `output`
//   and calls the driver again with `--run <runId>`. A call without `--run` is a new invocation
//   (a run start, refused while a run is in progress unless `--force-run`).
//   - resolve: answer { found, id, title, url, status, pr, dev } or { error }. A resolve printed
//     right before a move carries `move: { from, to }`.
//   - approval: answer { notionUserId, name, at } or { error }.
//   - overrides: `pages: { <step>: <path> }`; the session writes each pulled decisions page there.
//   - worktree: { worktree, branch }; the session moves into `worktree`; with an output it answers {}
//     and calls again with --run from there, without one (no runId) it reruns the command there.
//   - resolve answers carry the card's `type` (Feature, Bug, Chore), which names the worktree (F50).
//   - step: also { mode: 'local' | 'cloud', cwd } (F2).
//   - step: { step, command, model }; answer the step report { step, status, resultLine, usage }.
//   - ask: { question }; answer { answer }.
//   - move: { from, to }; answer { done: true }.  set-pr: { url }; answer { done: true }.
//   - gate: { commands, run, unset }; `run[i]` is `commands[i]` behind `env -u` for every credential
//     in `unset` (AVA3.1); the session runs `run[i]` and answers { results: [{ command, exitCode,
//     output }] } keyed by `commands[i]`. In cloud mode, when the gate scripts in the app's
//     package.json differ from origin/main, an `ask` stage (phase gate) comes first; the answer
//     "run" goes on to the gate stage, anything else stops the run.
//   - step10: answer { docs, docsToPropagate }.  fix: { findings }; answer { decisions, usage }.
//   - release-row: answer { customerLine, existingRow } to the draft stage; a re-printed stage
//     carries `error` when the draft was refused; the write stage carries `write: { action }`.
//   - summary: `path` (build-summary.md); first with `rules` (where the session writes the fetched
//     Feature Board page), then with `push` (null, or { action, page }); answer { pushed } or { error }.
//   - telemetry (KIT-19): { files }; printed after the summary push when the rules list the run
//     telemetry file; answer { attached: true, blockId } or { error }.
//   - step commands end with `--parent-run <runId>:<nonce>`; every step skill's .kit-version must be
//     this package's version (project() commits them on main; `kitVersion` changes or omits them).
//   - end: { stopped, message, resume? }; the message's last line is the resume command on a stop.
//   Stages that act on Notion list the actions as `notion: [{ op: 'read' | 'write', target, page? }]`.
// The origin is compared as configured (`git config remote.origin.url`, here the GitHub URL);
// fetches and pushes reach the bare repository through git's insteadOf.
//
// The project is laid out as GIT-002 leaves it (F50): the main checkout at `<tmp>/repo` on main, and
// the ticket's worktree at `<tmp>/repo/.worktrees/<TYPE>-KIT-11` on the ticket branch, which is
// where the driver runs (`h.repo`). `layout: 'checkout'` leaves out the worktree, so the driver
// runs from the main checkout and makes the worktree itself; `h.cd(dir)` moves the session there.
// `mode: 'cloud'` calls the driver with --cloud (F2, KIT-51). `pnpm` is a fake on PATH that logs its
// working directory and arguments.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { usageSchema } from '#src/run-state.ts'

const exec = promisify(execFile)

export const PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)))
export const DRIVER = join(PACKAGE, 'scripts/local.ts')
const LOADER = join(PACKAGE, 'node_modules/amaro/dist/register-strip.mjs')

export const ID = 'KIT-11'
export const TITLE = 'X'
export const SLUG = 'kit-11-x'
export const BRANCH = 'feat/kit-11-x'
export const BOARD = 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad'
export const TICKET_URL = 'https://app.notion.com/p/kit-11-x-0000000000000000000000000011'
export const RELEASES = 'https://app.notion.com/p/releases-000000000000000000000000000r'
export const GITHUB = 'https://github.com/aspiralabs/fixture.git'
export const REPOSITORY = 'aspiralabs/fixture'
export const PR_URL = 'https://github.com/aspiralabs/fixture/pull/7'
export const RESUME = '/aspira-build-feature KIT-11'
export const RESUME_CLOUD = '/aspira-build-feature KIT-11 --cloud'
/** The card's Type to the worktree name and branch prefix (GIT-001, GIT-002). */
export const TYPES: Record<string, { dir: string; prefix: string }> = { Feature: { dir: 'FEATURE', prefix: 'feat' }, Bug: { dir: 'BUG', prefix: 'fix' }, Chore: { dir: 'CHORE', prefix: 'chore' } }
export const branchFor = (type: string): string => `${TYPES[type]!.prefix}/kit-11-x`
export const worktreeFor = (main: string, type = 'Feature'): string => join(main, '.worktrees', `${TYPES[type]!.dir}-KIT-11`)
export const NOW = '2026-10-12T09:00:00.000Z'
export const APPROVER = { notionUserId: 'user-1', name: 'Ada Approver', at: NOW }

/** The Feature Board rules page as the session fetches it; BOARD-003 without and with the Build Summary title. */
export const BOARD_RULES_WITHOUT_SUMMARY = '# Feature Board\n\n**BOARD-003 — MUST** push outputs as child pages under fixed titles: Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review, Grooming Decisions.\n'
export const BOARD_RULES_WITH_SUMMARY = '# Feature Board\n\n**BOARD-003 — MUST** push outputs as child pages under fixed titles: Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review, Grooming Decisions, Build Summary.\n'
/** BOARD-003 with the run telemetry file block (the KIT-19 amendment), for project({ rules }). */
export const BOARD_RULES_WITH_TELEMETRY =
  '# Feature Board\n\n**BOARD-003 — MUST** push outputs as child pages under fixed titles: Spec, Spec Reviewed, Spec Review Decisions, Plan, Implementation, PR Review, Grooming Decisions, Build Summary. Every /aspira-* run on the ticket may also append one run telemetry file block, holding its <run-id>.json, at the end of the ticket page body.\n'

/** This package's version: what kit init writes into every step skill's .kit-version. */
const PACKAGE_VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))).version
/** The seven step skills, whose .kit-version the driver checks before a run's first step (KIT-19). */
export const STEP_SKILLS = ['groomer', 'spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer']

export type Stage = { stage: string; runId?: string; nonce?: string; output?: string; [key: string]: unknown }
export type Result = { code: number; stage: Stage | null; text: string }
export type Card = { found: boolean; status: string; pr: string | null; dev: string | null; title: string; type: string | null }
/** A step or fix report's usage, in the driver's own usageSchema shape. */
export type Usage = z.infer<typeof usageSchema>
export type DecisionFixture = { id: string; question: string; options: string[]; recommended: string; reasoning: string; whyYours: string; decidedBy: 'open' | 'author' | 'agent'; answer: string | null }
export type Handler = (stage: Stage) => Promise<'return' | void>

/** A decision an agent took to keep going, in the shape review.json and plan.json record it. */
export const taken = (id: string, question: string, options = ['Option A', 'Option B']): DecisionFixture => ({
  id,
  question,
  options,
  recommended: options[0]!,
  reasoning: 'It matches how the code already behaves',
  whyYours: 'It changes what the product does',
  decidedBy: 'agent',
  answer: options[0]!,
})

/** The checkbox file a step writes as trace/decisions.md (literal, as renderDecisions lays it out). */
export function decisionsMarkdown(decisions: readonly DecisionFixture[], tick: Record<string, string> = {}): string {
  const lines = ['# Decisions', '', `${decisions.length} decisions: 0 open · ${decisions.length} answered`, '']
  for (const decision of decisions) {
    const ticked = tick[decision.id] ?? decision.answer ?? decision.recommended
    lines.push(`## ${decision.id} — ${decision.question}`, '')
    for (const option of decision.options) {
      const note = option === decision.recommended ? ` _(recommended, taken by the agent: ${decision.reasoning})_` : ''
      lines.push(`- [${option === ticked ? 'x' : ' '}] ${option}${note}`)
    }
    lines.push('', `Why it is yours to decide: ${decision.whyYours}`, '')
  }
  return lines.join('\n')
}

/** A pr-reviewer findings.md with the given entries, each citing its file. */
export function findingsMarkdown(entries: { id: string; severity: 'critical' | 'high' | 'medium' | 'low'; title: string; file: string }[]): string {
  const lines = ['# Findings: aspiralabs/fixture#7', 'Reviewed: base `aaaaaaa` → head `bbbbbbb`', '']
  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    const under = entries.filter((entry) => entry.severity === severity)
    if (under.length === 0) continue
    lines.push(`## ${severity[0]!.toUpperCase()}${severity.slice(1)}`, '')
    for (const entry of under) {
      lines.push(`### [${entry.id}] ${entry.title}`, `**What this means:** ${entry.title}.`, '', `- Location: \`${entry.file}:1\``, '- Fix: change it.', '')
    }
  }
  return lines.join('\n')
}

type ProjectOptions = {
  /** aspira.json contents; null leaves the file out. Default: board and repository. */
  aspira?: Record<string, unknown> | null
  /** The card's Status at the start. */
  status: string
  pr?: string | null
  /** The branch the checkout is on. Default feat/kit-11-x; 'main' commits the build on main. */
  branch?: string
  /** Put the fake gh on PATH. Default true. */
  gh?: boolean
  /** A PR gh already knows for the branch. */
  existingPr?: string
  /** Push the branch to origin at setup. */
  pushed?: boolean
  /** Extra files committed on the branch with the build commit. */
  files?: Record<string, string>
  /** Files committed on main in the initial commit (so a new worktree from origin/main has them). */
  mainFiles?: Record<string, string>
  /** The card's Type. Default Feature; null leaves it empty. */
  type?: string | null
  /** 'worktree' (default): the driver runs in the ticket's worktree. 'checkout': only the main checkout on main, no worktree yet. */
  layout?: 'worktree' | 'checkout'
  /** 'local' (default) calls the driver with no mode flag; 'cloud' with --cloud (KIT-51). */
  mode?: 'local' | 'cloud'
  /** Extra variables in the session's environment (such as a fake credential the gate must strip). */
  env?: Record<string, string>
  /**
   * The kit version kit init leaves in every step skill's `.claude/skills/aspira-<step>/.kit-version`,
   * committed on main (so every worktree has it). Default: this package's version; null leaves the files out.
   */
  kitVersion?: string | null
  /** The Feature Board rules page the default summary handler writes. Default: BOARD_RULES_WITHOUT_SUMMARY. */
  rules?: string
}

// Removed once per file (afterAll), never per test: tests in a file run concurrently, so one
// test's cleanup must not delete a fixture another test is still using.
const temps: string[] = []
export async function cleanup(): Promise<void> {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
}

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])

export type Project = Awaited<ReturnType<typeof project>>

export async function project(options: ProjectOptions) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-')))
  temps.push(dir)
  const main = join(dir, 'repo')
  const origin = join(dir, 'origin.git')
  const bin = join(dir, 'bin')
  const ghDir = join(dir, 'gh')
  const gitLog = join(dir, 'git.log')
  const pnpmLog = join(dir, 'pnpm.log')
  await mkdir(join(ghDir, 'calls'), { recursive: true })
  await mkdir(bin)
  await writeFile(gitLog, '')
  await writeFile(pnpmLog, '')

  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin])
  await exec('git', ['init', '-q', '-b', 'main', main])
  await git(main, 'remote', 'add', 'origin', GITHUB)
  await git(main, 'config', `url.${origin}.insteadOf`, GITHUB)
  await git(main, 'config', `url.${origin}.pushInsteadOf`, GITHUB)
  const aspira = options.aspira === undefined ? { board: BOARD, repository: REPOSITORY } : options.aspira
  if (aspira !== null) await writeFile(join(main, 'aspira.json'), `${JSON.stringify(aspira, null, 2)}\n`)
  await mkdir(join(main, 'src'))
  await writeFile(join(main, 'README.md'), '# Fixture\n')
  await writeFile(join(main, 'src/app.ts'), 'export const app = 1\n')
  const kitVersion = options.kitVersion === undefined ? PACKAGE_VERSION : options.kitVersion
  const kitFiles = kitVersion === null ? {} : Object.fromEntries(STEP_SKILLS.map((step) => [`.claude/skills/aspira-${step}/.kit-version`, `${kitVersion}\n`]))
  for (const [path, content] of Object.entries({ ...kitFiles, ...options.mainFiles })) {
    await mkdir(dirname(join(main, path)), { recursive: true })
    await writeFile(join(main, path), content)
  }
  await git(main, 'add', '.')
  await git(main, 'commit', '-qm', 'init')
  await git(main, 'push', '-q', 'origin', 'main')
  const type = options.type === undefined ? 'Feature' : options.type
  const branch = options.branch ?? BRANCH
  let repo = main
  if (options.layout !== 'checkout') {
    // GIT-002: the ticket's worktree under .worktrees/, excluded locally.
    repo = worktreeFor(main, type ?? 'Feature')
    await writeFile(join(main, '.git/info/exclude'), '.worktrees/\n')
    if (branch === 'main') {
      await git(main, 'switch', '-q', '--detach')
      await git(main, 'worktree', 'add', '-q', repo, 'main')
    } else await git(main, 'worktree', 'add', '-q', '-b', branch, repo, 'main')
    await writeFile(join(repo, 'src/feature.ts'), 'export const feature = 1\n')
    for (const [path, content] of Object.entries(options.files ?? {})) {
      await mkdir(dirname(join(repo, path)), { recursive: true })
      await writeFile(join(repo, path), content)
    }
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'KIT-11: build')
    if (options.pushed === true) await git(repo, 'push', '-q', 'origin', `${branch}:${branch}`)
  }
  const base = (await git(main, 'rev-parse', 'main')).stdout.trim()

  let folder = join(repo, '.work', SLUG)
  let stateDir = join(folder, '.local', 'build-feature')
  await mkdir(folder, { recursive: true })

  // git: the real binary, behind a wrapper that logs each call's arguments (unit separator between them).
  const realGit = (await exec('/usr/bin/which', ['git'])).stdout.trim()
  await writeFile(join(bin, 'git'), `#!/bin/bash\n{ printf '%s\\x1f' "$@"; printf '\\n'; } >> "$GIT_LOG"\nexec ${realGit} "$@"\n`, { mode: 0o755 })
  // gh: records every call (arguments, and the body it was given) and answers like gh does.
  if (options.gh !== false) await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  // Without gh: shadow any gh the machine has on /usr/bin (CI runners ship one) with a stub that
  // fails like a missing command, so the test does not depend on the machine.
  else await writeFile(join(bin, 'gh'), '#!/bin/bash\necho "gh: command not found" >&2\nexit 127\n', { mode: 0o755 })
  if (options.existingPr !== undefined) await writeFile(join(ghDir, 'pr'), `${options.existingPr}\n`)
  // pnpm: logs where it ran and its arguments, and succeeds.
  await writeFile(join(bin, 'pnpm'), `#!/bin/bash\nprintf '%s %s\\n' "$PWD" "$*" >> "$PNPM_LOG"\n`, { mode: 0o755 })
  await symlink(process.execPath, join(bin, 'node'))

  const card: Card = { found: true, status: options.status, pr: options.pr ?? null, dev: 'user-1', title: TITLE, type }
  const local = options.mode !== 'cloud'
  const stages: Stage[] = []
  const answered: { stage: Stage; answer: Record<string, unknown> }[] = []
  let runId: string | undefined
  let now = NOW
  let lastText = ''

  const env = (): NodeJS.ProcessEnv => {
    const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, ...rest } = process.env
    return { ...rest, PATH: `${bin}:/usr/bin:/bin`, HOME: dir, GIT_LOG: gitLog, PNPM_LOG: pnpmLog, GH_DIR: ghDir, GH_CREATED_URL: PR_URL, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', BUILD_FEATURE_NOW: now, BUILD_FEATURE_AGENT_DIR: '', ...options.env }
  }

  async function call(args: string[]): Promise<Result> {
    const outcome = await exec(process.execPath, ['--import', LOADER, DRIVER, ID, ...(local ? [] : ['--cloud']), '--repo', repo, ...args], { cwd: repo, env: env() }).then(
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
    }
    return { code: outcome.code, stage, text: `${outcome.stdout}\n${outcome.stderr}` }
  }

  const h = {
    dir,
    main,
    get repo() {
      return repo
    },
    origin,
    get folder() {
      return folder
    },
    get stateDir() {
      return stateDir
    },
    base,
    card,
    stages,
    answered,
    get runId() {
      return runId
    },
    setNow(value: string) {
      now = value
    },
    /** The session moves into `dir` (the worktree a worktree stage names): later calls run there. */
    cd(target: string) {
      repo = target
      folder = join(repo, '.work', SLUG)
      stateDir = join(folder, '.local', 'build-feature')
    },
    /** Every pnpm call: `<cwd> <args>`. */
    pnpmCalls: async () => (await readFile(pnpmLog, 'utf8')).split('\n').filter((line) => line !== ''),
    /** A new invocation: `/aspira-build-feature KIT-11` as the human typed it. */
    start: (extra: string[] = []) => call(extra),
    /** The session calling the driver again within the run. */
    next: (extra: string[] = []) => call(runId === undefined ? extra : ['--run', runId, ...extra]),
    /** End the run where it is (`--finish`). */
    finish: () => call(runId === undefined ? ['--finish'] : ['--run', runId, '--finish']),

    async answer(stage: Stage | null | undefined, answer: Record<string, unknown>, nonce = stage?.nonce) {
      if (stage === null || stage === undefined) throw new Error(`expected a stage to answer; the driver printed none:\n${lastText.slice(-2000)}`)
      if (typeof stage.output !== 'string') throw new Error(`the ${stage.stage} stage names no output file: ${JSON.stringify(stage)}`)
      await mkdir(dirname(stage.output), { recursive: true })
      const body = { nonce, ...answer }
      await writeFile(stage.output, JSON.stringify(body, null, 2))
      answered.push({ stage, answer: body })
    },

    resolution: (): Record<string, unknown> => (card.found ? { found: true, id: ID, title: card.title, url: TICKET_URL, status: card.status, pr: card.pr, dev: card.dev, type: card.type } : { found: false, id: ID }),

    /**
     * Answer the stages the session performs without a model (resolve, approval, overrides, move,
     * set-pr, summary) until a step, ask, gate, step10, fix, release-row or end stage, which it returns.
     */
    async advance(handlers: Partial<Record<string, Handler>> = {}, from?: Result): Promise<Result> {
      let result = from ?? (await h.next())
      for (let turn = 0; turn < 80; turn += 1) {
        const stage = result.stage
        if (stage === null) return result
        const custom = handlers[stage.stage]
        if (custom !== undefined) {
          if ((await custom(stage)) === 'return') return result
        } else if (stage.stage === 'resolve') await h.answer(stage, h.resolution())
        else if (stage.stage === 'approval') await h.answer(stage, { ...APPROVER })
        else if (stage.stage === 'overrides') await h.pull(stage)
        else if (stage.stage === 'move') {
          card.status = String(stage.to)
          await h.answer(stage, { done: true })
        } else if (stage.stage === 'set-pr') {
          card.pr = String(stage.url)
          await h.answer(stage, { done: true })
        } else if (stage.stage === 'summary') {
          if (typeof stage.rules === 'string') {
            await mkdir(dirname(stage.rules), { recursive: true })
            await writeFile(stage.rules, options.rules ?? BOARD_RULES_WITHOUT_SUMMARY)
            await h.answer(stage, {})
          } else await h.answer(stage, { pushed: stage.push !== null && stage.push !== undefined })
        } else return result
        result = await h.next()
      }
      throw new Error(`the driver did not reach a stage the test handles; last: ${JSON.stringify(result.stage)}`)
    },

    /** Answer an overrides stage with each page as the step left it locally, or as the test ticked it. */
    async pull(stage: Stage, pulled: Record<string, string> = {}) {
      const pages = (stage.pages ?? {}) as Record<string, string>
      for (const [step, path] of Object.entries(pages)) {
        const local = DECISIONS_FILE[step]
        const text = pulled[step] ?? (local !== undefined && existsSync(join(folder, local)) ? await readFile(join(folder, local), 'utf8') : '# Decisions\n')
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      }
      await h.answer(stage, {})
    },

    /** Stop the run where it is and answer the summary stages, returning the end stage. */
    async stop(): Promise<Result> {
      return h.advance({}, await h.finish())
    },

    /** Write a step's export fixture as the step would leave it, then the step report, and move the card as the step would. */
    async report(stage: Stage | null | undefined, status: string, options: StepReportOptions = {}) {
      if (stage === null || stage === undefined || stage.stage !== 'step') throw new Error(`expected a step stage to report on, got ${JSON.stringify(stage ?? null)}; driver output:\n${lastText.slice(-2000)}`)
      const step = String(stage.step)
      await writeStepExport(folder, repo, step, status, options)
      if (options.card !== undefined) Object.assign(card, options.card)
      else if (SUCCESS[step]?.status === status && SUCCESS[step].card !== undefined) card.status = SUCCESS[step].card
      await h.answer(stage, { step, status, resultLine: options.resultLine ?? `${step}: ${status}`, usage: options.usage === undefined ? { tokens: 1000, wallMs: 60000 } : options.usage })
    },

    async state(): Promise<Record<string, unknown> & { runs?: Record<string, unknown>[]; approvals?: Record<string, unknown>[]; moves?: Record<string, unknown>[]; steps?: Record<string, unknown>[] }> {
      return JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as Record<string, unknown>
    },
    summary: () => readFile(join(folder, 'build-summary.md'), 'utf8').catch(() => ''),
    prBody: () => readFile(join(stateDir, 'pr-body.md'), 'utf8').catch(() => ''),

    /** Every gh call, with the body it was given (from --body-file or --body). */
    async ghCalls(): Promise<{ args: string[]; body: string | null }[]> {
      const calls = join(ghDir, 'calls')
      const names = (await readdir(calls)).sort((a, b) => Number(a) - Number(b))
      return Promise.all(
        names.map(async (name) => ({
          args: (await readFile(join(calls, name, 'args'), 'utf8')).split('\n').filter((line) => line !== ''),
          body: await readFile(join(calls, name, 'body'), 'utf8').catch(() => null),
        })),
      )
    },
    /** Every git call the driver made, as argument lists. */
    async gitCalls(): Promise<string[][]> {
      return (await readFile(gitLog, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('\x1f').filter((arg) => arg !== ''))
    },
    /** The branch head on the bare origin, or null when origin has no such branch. */
    async originHead(name = BRANCH): Promise<string | null> {
      return exec('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(
        ({ stdout }) => stdout.trim(),
        () => null,
      )
    },
    /** The files in a commit range of the local repository. */
    async filesSince(from: string, to = 'HEAD'): Promise<string[]> {
      const { stdout } = await git(repo, 'log', '--name-only', '--format=', `${from}..${to}`)
      return stdout.split('\n').filter((line) => line !== '')
    },
    git: (...args: string[]) => git(repo, ...args),
    async write(path: string, content: string) {
      await mkdir(dirname(join(repo, path)), { recursive: true })
      await writeFile(join(repo, path), content)
    },
  }
  return h
}

export type StepReportOptions = {
  usage?: Usage
  resultLine?: string
  card?: Partial<Card>
  /** Decisions the step took (or, for the implementor, assumptions). */
  decisions?: DecisionFixture[]
  /** Replace the decisions output with this raw value (an invalid output). */
  rawDecisions?: unknown
  /** code-analyzer: the files it edited (written to the working tree). Default ['src/app.ts']. */
  edited?: string[]
  /** code-analyzer: the app directory its export lands under (its --app). Default '.'. */
  app?: string
  /** implementor: the app directories its record says it changed (KIT-39). */
  apps?: string[]
  /** pr-reviewer: the findings of this review. */
  findings?: Parameters<typeof findingsMarkdown>[0]
  /** spec-writer: whether spec.reviewed/ holds the current spec.md. Default true. */
  covers?: boolean
  /** implementor: the verification status. Default 'done'. */
  verification?: string
}

/** Where each step's own decisions file lies, relative to the ticket folder. */
export const DECISIONS_FILE: Record<string, string> = {
  groomer: 'groom/trace/decisions.md',
  'spec-writer': 'spec.reviewed/trace/decisions.md',
  planner: 'plan.review/trace/decisions.md',
  implementor: 'plan.review/trace/decisions.md',
}

/** The status a step reports when it finished well, and where it leaves the card. */
const SUCCESS: Record<string, { status: string; card?: string }> = {
  groomer: { status: 'confirmed', card: 'Shortlist' },
  'spec-writer': { status: 'ready', card: 'In Review: Spec' },
  planner: { status: 'ready', card: 'In Review: Plan' },
  implementor: { status: 'complete', card: 'In Progress: Implementation' },
  'code-analyzer': { status: 'clean' },
  'pr-reviewer': { status: 'complete' },
}

const SPEC = '# X\n\n## Acceptance criteria\n\n- [ ] F1: it works.\n'

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** The export a step leaves in the ticket folder: literal fixtures in each step's own shape. */
export async function writeStepExport(folder: string, repo: string, step: string, status: string, options: StepReportOptions = {}): Promise<void> {
  const decisions = options.decisions ?? []
  const decisionsOut = options.rawDecisions === undefined ? decisions : options.rawDecisions
  switch (step) {
    case 'groomer': {
      const record = {
        decisions: decisions.map((decision) => ({ ...decision, id: decision.id.startsWith('Q') ? decision.id : `Q${decision.id.replace(/\D/g, '')}`, branch: 'problem', facts: [] })),
        branches: [],
        round: 1,
        startedAt: NOW,
        open: status === 'needs-author' ? 1 : 0,
        page: { url: 'https://app.notion.com/p/grooming-decisions' },
        status,
      }
      await put(join(folder, 'groom/trace/groom.json'), JSON.stringify(options.rawDecisions === undefined ? record : { ...record, decisions: options.rawDecisions }, null, 2))
      await put(join(folder, DECISIONS_FILE.groomer!), decisionsMarkdown(decisions))
      return
    }
    case 'spec-writer': {
      // The one spec step (KIT-48): the reviewer's layout under spec.reviewed/, and spec.md beside it.
      await put(join(folder, 'spec.reviewed/trace/review.json'), JSON.stringify({ mode: 'local', status, problems: [], authorDecisions: decisionsOut }, null, 2))
      await put(join(folder, 'spec.reviewed/trace/decisions.md'), decisionsMarkdown(decisions))
      await put(join(folder, 'spec.md'), SPEC)
      if (options.covers !== false) await put(join(folder, 'spec.reviewed/spec.reviewed.md'), SPEC)
      return
    }
    case 'planner': {
      await put(join(folder, 'plan.review/trace/review.json'), JSON.stringify({ mode: 'local', status, problems: [] }, null, 2))
      await put(join(folder, 'plan.review/trace/plan.json'), JSON.stringify({ summary: 'Build X.', tasks: [{ id: 'P1', title: 'Build X', kind: 'implementation', featureIds: ['F1'], dependsOn: [], testIds: [], changes: [{ operation: 'create', path: 'src/feature.ts', symbols: ['feature'], instructions: 'Add it.', evidence: ['src/app.ts:1'] }], commands: [], outcome: 'X works.' }], tests: [], checks: [], decisions: decisionsOut, gaps: [] }, null, 2))
      await put(join(folder, 'plan.review/plan.reviewed.md'), '# Implementation plan\n')
      await put(join(folder, DECISIONS_FILE.planner!), decisionsMarkdown(decisions))
      return
    }
    case 'implementor': {
      const assumptions = decisions.map(({ question, options: choices, recommended, reasoning, whyYours }) => ({ question, options: choices, recommended, reasoning, whyYours }))
      const exported = status === 'complete' ? 'complete' : 'incomplete'
      await put(join(folder, 'plan.review/trace/implementation-local.json'), JSON.stringify({ mode: 'local', status: exported, ...(options.apps === undefined ? {} : { apps: options.apps }), verification: { status: options.verification ?? (status === 'complete' ? 'done' : status), assumptions: options.rawDecisions === undefined ? assumptions : options.rawDecisions } }, null, 2))
      await put(join(folder, DECISIONS_FILE.implementor!), decisionsMarkdown(decisions.map((decision, index) => ({ ...decision, id: `A${index + 1}` }))))
      return
    }
    case 'code-analyzer': {
      const edited = options.edited ?? ['src/app.ts']
      for (const path of edited) await put(join(repo, path), `export const app = 2 // analyzer fix in ${path}\n`)
      const out = join(repo, options.app ?? '.', '.static-analysis')
      await put(join(out, 'diagnostics.json'), JSON.stringify({ status, remaining: [], initial: [] }, null, 2))
      await put(join(out, 'rounds.json'), JSON.stringify({ mode: 'local', status, editedFiles: edited, rounds: [] }, null, 2))
      await put(join(out, 'report.md'), `# Static analysis\n\nStatus: ${status}\n`)
      return
    }
    case 'pr-reviewer': {
      await put(join(folder, 'pr-review/findings.md'), findingsMarkdown(options.findings ?? []))
      await put(join(folder, 'pr-review/review.md'), '# Review\n')
      // KIT-2 P23: step-results.ts now reads the pr-reviewer's status from its own trace file
      // (RUN_RECORDS['pr-reviewer']), like every other step, instead of trusting the report alone.
      await put(join(folder, 'pr-review/trace/review.json'), JSON.stringify({ mode: 'local', status, problems: [] }, null, 2))
      return
    }
    default:
      throw new Error(`no export fixture for step ${step}`)
  }
}

const FAKE_GH = `#!/bin/bash
n=$(/bin/ls "$GH_DIR/calls" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
call="$GH_DIR/calls/$n"
/bin/mkdir -p "$call"
printf '%s\\n' "$@" > "$call/args"
args=("$@")
json=""; jq=""
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    --body-file|-F) /bin/cat "\${args[$((i + 1))]}" > "$call/body" ;;
    --body|-b) printf '%s' "\${args[$((i + 1))]}" > "$call/body" ;;
    --json) json=1 ;;
    --jq|-q) jq=1 ;;
  esac
done
pr=""
[ -f "$GH_DIR/pr" ] && pr=$(/bin/cat "$GH_DIR/pr")
case "$1 $2" in
  "pr list")
    if [ -z "$pr" ]; then [ -n "$json" ] && [ -z "$jq" ] && echo '[]'; exit 0; fi
    if [ -n "$jq" ]; then echo "$pr"
    elif [ -n "$json" ]; then printf '[{"url":"%s","number":7,"state":"OPEN","isDraft":true,"headRefName":"feat/kit-11-x"}]\\n' "$pr"
    else printf '7\\tKIT-11: X\\tfeat/kit-11-x\\tOPEN\\n'; fi ;;
  "pr create")
    echo "$GH_CREATED_URL" > "$GH_DIR/pr"
    echo "$GH_CREATED_URL" ;;
  "pr view")
    if [ -z "$pr" ]; then echo 'no pull requests found for branch "feat/kit-11-x"' >&2; exit 1; fi
    if [ -n "$jq" ]; then echo "$pr"
    elif [ -n "$json" ]; then printf '{"url":"%s","number":7,"state":"OPEN","isDraft":true}\\n' "$pr"
    else echo "$pr"; fi ;;
  "repo view") printf '{"nameWithOwner":"aspiralabs/fixture","url":"https://github.com/aspiralabs/fixture"}\\n' ;;
  *) exit 0 ;;
esac
`

/** Stage kinds the run printed, in order. */
export const kinds = (stages: readonly Stage[]): string[] => stages.map((stage) => stage.stage)
/** The stages of one kind. */
export const ofKind = (stages: readonly Stage[], kind: string): Stage[] => stages.filter((stage) => stage.stage === kind)
/** Occurrences of a literal string. */
export const count = (text: string, needle: string): number => text.split(needle).length - 1
