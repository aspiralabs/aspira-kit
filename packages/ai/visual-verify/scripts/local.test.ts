// The standalone /aspira-visual-verify run at its seam: scripts/local.ts main(argv), as
// visual-verify.sh runs it, against a temp git repository with an aspira.json and a ticket folder
// under .work/. It observes the exit code, the text main prints and the files it writes. No Notion
// call and no browser: stdout and stderr are the only boundaries stood in for (TEST-007).
// KIT-58 plan P4: T25, T26, T27, T28.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { main } from './local.ts'

const exec = promisify(execFile)
const BOARD = 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad'
const DEV = { cwd: '.', command: 'pnpm dev', url: 'http://localhost:3000' }
const UI_PLAN_PATH = 'src/app/models/page.tsx'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

type Dev = Record<string, unknown>
/** `worktree` puts the repository at <tmp>/.worktrees/<name>; `app` is aspira.json's app folder; `env` is the app's .env.development.local. */
type Options = { dev?: Dev | null; planPath?: string; answer?: unknown; worktree?: string; app?: string; env?: string }

/** A git repository with aspira.json and .work/kit-9-x/ holding a reviewed spec and a plan. */
async function project(options: Options = {}) {
  const main = await realpath(await mkdtemp(join(tmpdir(), 'visual-verify-local-')))
  temps.push(main)
  const repo = options.worktree === undefined ? main : join(main, '.worktrees', options.worktree)
  await mkdir(repo, { recursive: true })
  await exec('git', ['init', '-q', repo])
  const dev = options.dev === undefined ? DEV : options.dev
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD, ...(options.app === undefined ? {} : { app: options.app }), ...(dev === null ? {} : { dev }) }))
  if (options.env !== undefined) {
    await mkdir(join(repo, options.app ?? '.'), { recursive: true })
    await writeFile(join(repo, options.app ?? '.', '.env.development.local'), options.env)
  }
  const folder = join(repo, '.work/kit-9-x')
  await mkdir(join(folder, 'spec.reviewed'), { recursive: true })
  await mkdir(join(folder, 'plan.review/trace'), { recursive: true })
  await writeFile(join(folder, 'spec.reviewed/spec.reviewed.md'), '# Models page\n\n## Acceptance criteria\n\n### Features\n\n- [ ] F3: /admin/models lists every model with its price.\n')
  const plan = {
    summary: 'Show the models page',
    tasks: [{ id: 'P1', title: 'Models page', kind: 'implementation', featureIds: ['F3'], dependsOn: [], testIds: [], changes: [{ operation: 'create', path: options.planPath ?? UI_PLAN_PATH, symbols: [], instructions: 'x', evidence: [] }], commands: [], outcome: 'x' }],
    tests: [],
  }
  await writeFile(join(folder, 'plan.review/trace/plan.json'), JSON.stringify(plan))
  if (options.answer !== undefined) {
    await mkdir(join(folder, 'visual-verify'), { recursive: true })
    await writeFile(join(folder, 'visual-verify/answer.json'), JSON.stringify(options.answer))
  }
  return { repo, folder, out: join(folder, 'visual-verify') }
}

/** Runs main(argv) with stdout and stderr captured; the environment is the given one plus nothing from the session's tokens. */
async function run(argv: string[], env: Record<string, string> = {}) {
  const saved = { ...process.env }
  for (const name of Object.keys(process.env)) if (/_(TOKEN|SECRET|KEY|PASSWORD)$/i.test(name)) delete process.env[name]
  Object.assign(process.env, env)
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((stdout += String(chunk)), true))
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => ((stderr += String(chunk)), true))
  let code: number
  try {
    code = await main(argv)
  } catch (error) {
    code = 1
    stderr += error instanceof Error ? error.message : String(error)
  } finally {
    out.mockRestore()
    err.mockRestore()
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
  return { code, stdout, stderr, text: `${stdout}\n${stderr}` }
}

// The runs share process.stdout and process.env, so they take turns.
describe.sequential('T25 F17: standalone run on a status it does not accept', () => {
  it('refuses Ready: Plan with exit 3 naming both accepted statuses and writes nothing', async () => {
    const { repo, out } = await project()
    const outcome = await run(['local', 'KIT-9', '--repo', repo, '--status', 'Ready: Plan'])
    expect({ code: outcome.code, names: ['In Progress: Implementation', 'In Review: Implementation'].every((status) => outcome.text.includes(status)), written: existsSync(out) }).toEqual({ code: 3, names: true, written: false })
  })
})

describe.sequential('T26 F12 F17: standalone run that cannot check says why', () => {
  const cases: { name: string; options: Options; extra: string[]; reason: string }[] = [
    { name: 'no dev entry', options: { dev: null }, extra: [], reason: 'no aspira.json dev entry' },
    { name: '--cloud', options: {}, extra: ['--cloud'], reason: '--cloud' },
    { name: 'a plan changing only src/feature.ts', options: { planPath: 'src/feature.ts' }, extra: [], reason: 'plan without UI' },
  ]
  for (const { name, options, extra, reason } of cases) {
    it(`skips with exit 0 and names '${reason}' in report.md and in the printed text: ${name}`, async () => {
      const { repo, out } = await project(options)
      const outcome = await run(['local', 'KIT-9', '--repo', repo, '--status', 'In Progress: Implementation', ...extra])
      const report = await readFile(join(out, 'report.md'), 'utf8').catch(() => '')
      expect({ code: outcome.code, report: report.includes(reason), printed: outcome.text.includes(reason) }).toEqual({ code: 0, report: true, printed: true })
    })
  }
})

describe.sequential('T27 F17 F2: standalone run that can check hands the session its job', () => {
  it('prints the dev server with its credential-free run line and the answer path, and writes no Build Summary or PR body', async () => {
    const { repo, folder, out } = await project()
    const outcome = await run(['local', 'KIT-9', '--repo', repo, '--status', 'In Review: Implementation'], { GITHUB_TOKEN: 'g' })
    const printed = JSON.parse(outcome.stdout) as { devServer?: { url?: string; run?: string }; output?: string }
    expect({
      code: outcome.code,
      url: printed.devServer?.url,
      stripped: printed.devServer?.run?.includes('-u GITHUB_TOKEN ') ?? false,
      output: printed.output?.endsWith('.work/kit-9-x/visual-verify/answer.json') ?? false,
      files: ['build-summary.md', 'pr-body.md'].filter((name) => existsSync(join(folder, name)) || existsSync(join(out, name))),
    }).toEqual({ code: 0, url: 'http://localhost:3000', stripped: true, output: true, files: [] })
  })
})

describe.sequential('T4 F1 F11 F13: standalone run with a placeholder dev url', () => {
  const PLACEHOLDER = { cwd: '.', command: 'pnpm dev', url: 'http://{name}.localhost:{port}' }

  it('A: resolves the url from the worktree name and PORT and hands a kit dev run line with the credential names unset', async () => {
    const { repo } = await project({ dev: PLACEHOLDER, worktree: 'FEATURE-SCOOP-7', app: 'web', env: 'PORT=3003\nDATABASE_URL=postgres://branch\n' })
    const outcome = await run(['local', 'KIT-9', '--repo', repo, '--status', 'In Review: Implementation'], { GITHUB_TOKEN: 'g' })
    const printed = JSON.parse(outcome.stdout) as { devServer?: { url?: string; run?: string } }
    expect({
      code: outcome.code,
      url: printed.devServer?.url,
      starts: printed.devServer?.run?.startsWith('env ') ?? false,
      stripped: printed.devServer?.run?.includes('-u GITHUB_TOKEN ') ?? false,
      ends: printed.devServer?.run?.endsWith(' kit dev') ?? false,
    }).toEqual({ code: 0, url: 'http://scoop-7.localhost:3003', starts: true, stripped: true, ends: true })
  })

  it('B: skips with exit 0 and the reason "dev.url needs a kit worktree; run kit worktree" in the main checkout, printing no devServer', async () => {
    const { repo } = await project({ dev: PLACEHOLDER })
    const outcome = await run(['local', 'KIT-9', '--repo', repo, '--status', 'In Review: Implementation'])
    expect({ code: outcome.code, reason: outcome.text.includes('dev.url needs a kit worktree; run kit worktree'), devServer: outcome.text.includes('devServer') }).toEqual({ code: 0, reason: true, devServer: false })
  })

  it('C: leaves the url and the run line of a brace-free dev block exactly as they are today', async () => {
    const { repo } = await project({ worktree: 'FEATURE-SCOOP-7', app: 'web', env: 'PORT=3003\n' })
    const outcome = await run(['local', 'KIT-9', '--repo', repo, '--status', 'In Review: Implementation'], { GITHUB_TOKEN: 'g' })
    const printed = JSON.parse(outcome.stdout) as { devServer?: { url?: string; run?: string } }
    expect({ code: outcome.code, url: printed.devServer?.url, run: printed.devServer?.run?.endsWith(' pnpm dev') ?? false, kitDev: printed.devServer?.run?.includes('kit dev') ?? false }).toEqual({ code: 0, url: 'http://localhost:3000', run: true, kitDev: false })
  })
})

describe.sequential('T28 F3 F7 F8 F17: report from the session\'s answer', () => {
  const answer = {
    nonce: 'n1',
    status: 'ran',
    viewport: '1280x800',
    findings: [
      { grade: 'minor', title: 'Header is two pixels off', page: '/admin/models', files: [] },
      { grade: 'blocker', title: 'Price shows a dash in every row', page: '/admin/models', files: ['src/app/models/page.tsx'] },
    ],
    notExercised: [{ page: 'F3', action: '-', reason: 'not exercised: no page found' }],
    screenshots: ['.work/kit-9-x/visual-verify/models.png'],
  }
  const NOT_EXERCISED = 'not exercised: no page found'

  it('writes report.md with the blocker before the minor, the not-exercised notice apart and the viewport named', async () => {
    const { repo, out } = await project({ answer })
    await run(['report', 'KIT-9', '--repo', repo])
    const report = await readFile(join(out, 'report.md'), 'utf8').catch(() => '')
    expect({
      blockerFirst: report.indexOf('Price shows a dash') >= 0 && report.indexOf('Price shows a dash') < report.indexOf('Header is two pixels off'),
      noticeApart: report.lastIndexOf(NOT_EXERCISED) > report.indexOf('Header is two pixels off'),
      viewport: report.includes('1280x800'),
    }).toEqual({ blockerFirst: true, noticeApart: true, viewport: true })
  })

  it('prints the same findings by grade, blocker first', async () => {
    const { repo } = await project({ answer })
    const outcome = await run(['report', 'KIT-9', '--repo', repo])
    expect({ code: outcome.code, blockerFirst: outcome.text.indexOf('Price shows a dash') >= 0 && outcome.text.indexOf('Price shows a dash') < outcome.text.indexOf('Header is two pixels off'), notice: outcome.text.includes(NOT_EXERCISED) }).toEqual({ code: 0, blockerFirst: true, notice: true })
  })

  it('writes no build-summary.md or pr-body.md', async () => {
    const { repo, folder, out } = await project({ answer })
    await run(['report', 'KIT-9', '--repo', repo])
    expect(['build-summary.md', 'pr-body.md'].filter((name) => existsSync(join(folder, name)) || existsSync(join(out, name)))).toEqual([])
  })
})
