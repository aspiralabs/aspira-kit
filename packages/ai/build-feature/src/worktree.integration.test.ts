// F50: one worktree per ticket (GIT-001, GIT-002), at seam S1 with real git. The run starts in the
// main checkout on main; before any step the driver makes (or reuses) `.worktrees/<TYPE>-<ID>` on
// `<prefix>/<id>-<slug>` from origin/main, excludes `.worktrees/` locally when `.gitignore` does not
// list it, runs the project's install and build there (pnpm is a fake on PATH), carries the
// ticket's `.work/` folder over, and prints a `worktree` stage telling the session to continue from
// inside it. The repository is a temp repo with a bare origin; nothing reaches the network.

import { execFile } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { BOARD, REPOSITORY, SLUG, branchFor, cleanup, kinds, ofKind, project, worktreeFor, type Project, type Result } from './driver.test-helper.ts'
import { ISOLATED_ASPIRA, ISOLATED_IGNORE, isolationWorld, type World } from './isolation.test-helper.ts'

const exec = promisify(execFile)
afterAll(cleanup)

const SLOW = 120_000
// The step command without its trailing --parent-run <run>:<nonce> (KIT-19), which these tests do not pin.
const commandOf = (result: Result) => (result.stage?.stage === 'step' ? String(result.stage.command).replace(/ --parent-run \S+$/, '').replace(/ --(?:guidelines|knowledge|packet) \S+/g, '') : `<${result.stage?.stage ?? 'no stage'}>`)
const gitIn = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args])).stdout.trim()
const SPEC = '# X\n\n## Acceptance criteria\n\n- [ ] F1: it works.\n'

/** A run started from the main checkout at Ready: Spec, with the ticket's spec in the main checkout's .work/. */
async function fromMain(options: Parameters<typeof project>[0]): Promise<{ h: Project; result: Result }> {
  const h = await project({ layout: 'checkout', ...options })
  await mkdir(h.folder, { recursive: true })
  await writeFile(join(h.folder, 'spec.md'), SPEC)
  const result = await h.advance({}, await h.start())
  return { h, result }
}

describe('F50: the run works the ticket in its own worktree', () => {
  it('creates .worktrees/FEATURE-KIT-11 on feat/kit-11-x from origin/main with the GIT-002 command, before any step', async () => {
    const { h, result } = await fromMain({ status: 'Ready: Spec' })
    const worktree = worktreeFor(h.main)
    const adds = (await h.gitCalls()).filter((args) => args[0] === 'worktree' && args[1] === 'add')
    expect({
      stage: result.stage?.stage,
      worktree: result.stage?.worktree,
      branch: result.stage?.branch,
      head: await gitIn(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'),
      fromMain: (await gitIn(worktree, 'rev-parse', 'HEAD')) === h.base,
      adds,
      steps: ofKind(h.stages, 'step').length,
    }).toEqual({
      stage: 'worktree',
      worktree,
      branch: 'feat/kit-11-x',
      head: 'feat/kit-11-x',
      fromMain: true,
      adds: [['worktree', 'add', '-b', 'feat/kit-11-x', '.worktrees/FEATURE-KIT-11', 'origin/main']],
      steps: 0,
    })
  }, SLOW)

  it('names the worktree and branch by the card Type: BUG with fix/, CHORE with chore/', async () => {
    const outcomes = []
    for (const type of ['Bug', 'Chore']) {
      const { h, result } = await fromMain({ status: 'Ready: Spec', type })
      outcomes.push({ type, worktree: result.stage?.worktree === worktreeFor(h.main, type), head: await gitIn(worktreeFor(h.main, type), 'rev-parse', '--abbrev-ref', 'HEAD') })
    }
    expect(outcomes).toEqual([
      { type: 'Bug', worktree: true, head: branchFor('Bug') },
      { type: 'Chore', worktree: true, head: branchFor('Chore') },
    ])
  }, SLOW)

  it('adds .worktrees/ to .git/info/exclude when .gitignore does not list it, and leaves exclude alone when it does', async () => {
    const without = await fromMain({ status: 'Ready: Spec' })
    const listed = await fromMain({ status: 'Ready: Spec', mainFiles: { '.gitignore': 'node_modules/\n.worktrees/\n' } })
    const excluded = async (h: Project) => (await readFile(join(h.main, '.git/info/exclude'), 'utf8')).split('\n').includes('.worktrees/')
    expect({ without: await excluded(without.h), listed: await excluded(listed.h) }).toEqual({ without: true, listed: false })
  }, SLOW)

  it('runs pnpm install then pnpm build in the new worktree for a pnpm workspace with a build script, else only the install', async () => {
    const workspace = await fromMain({ status: 'Ready: Spec', mainFiles: { 'pnpm-workspace.yaml': 'packages: []\n', 'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'echo built' } }) } })
    const single = await fromMain({ status: 'Ready: Spec', mainFiles: { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'package.json': JSON.stringify({ name: 'fixture' }) } })
    expect({ workspace: await workspace.h.pnpmCalls(), single: await single.h.pnpmCalls() }).toEqual({
      workspace: [`${worktreeFor(workspace.h.main)} install`, `${worktreeFor(workspace.h.main)} build`],
      single: [`${worktreeFor(single.h.main)} install`],
    })
  }, SLOW)

  it('installs in the app directory aspira.json names, not the worktree root (KIT-21)', async () => {
    const { h } = await fromMain({ status: 'Ready: Spec', aspira: { board: BOARD, repository: REPOSITORY, app: 'tools/app' }, mainFiles: { 'tools/app/pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'tools/app/package.json': JSON.stringify({ name: 'fixture' }) } })
    expect(await h.pnpmCalls()).toEqual([`${join(worktreeFor(h.main), 'tools', 'app')} install`])
  }, SLOW)

  it('links the main checkout\'s root and app .env.local into the worktree before the install (KIT-49)', async () => {
    const { h } = await fromMain({ status: 'Ready: Spec', aspira: { board: BOARD, repository: REPOSITORY, app: 'tools/app' }, mainFiles: { '.gitignore': '.env.local\n', '.env.local': 'ROOT=1\n', 'tools/app/.env.local': 'APP=1\n', 'tools/app/package.json': JSON.stringify({ name: 'fixture' }) } })
    const worktree = worktreeFor(h.main)
    const link = (path: string) => { try { return lstatSync(join(worktree, path)).isSymbolicLink() } catch { return false } }
    expect({ root: link('.env.local'), app: link('tools/app/.env.local') }).toEqual({ root: true, app: true })
  }, SLOW)

  it('links the main checkout\'s git-ignored aspira.json into a new worktree, and into a reused one that lacks it (KIT-71)', async () => {
    const isLink = (worktree: string) => { try { return lstatSync(join(worktree, 'aspira.json')).isSymbolicLink() } catch { return false } }
    const { h } = await fromMain({ status: 'Ready: Spec', aspiraUntracked: true })
    const reuse = await project({ status: 'Ready: Spec', layout: 'checkout', aspiraUntracked: true })
    await mkdir(reuse.folder, { recursive: true })
    await writeFile(join(reuse.folder, 'spec.md'), SPEC)
    await exec('git', ['-C', reuse.main, 'worktree', 'add', '-q', '-b', 'feat/kit-11-x', worktreeFor(reuse.main), 'main'])
    const redirect = await reuse.start()
    expect({ created: isLink(worktreeFor(h.main)), reused: isLink(worktreeFor(reuse.main)), stage: redirect.stage?.stage }).toEqual({ created: true, reused: true, stage: 'worktree' })
  }, SLOW)

  it('a run started inside a reused worktree that lacks aspira.json links the main checkout\'s and goes on (KIT-78)', async () => {
    const h = await project({ status: 'Ready: Spec', layout: 'checkout', aspiraUntracked: true })
    const worktree = worktreeFor(h.main)
    await exec('git', ['-C', h.main, 'worktree', 'add', '-q', '-b', 'feat/kit-11-x', worktree, 'main'])
    h.cd(worktree)
    await mkdir(h.folder, { recursive: true })
    await writeFile(join(h.folder, 'spec.md'), SPEC)
    const step = await h.advance({}, await h.start())
    expect({ link: lstatSync(join(worktree, 'aspira.json')).isSymbolicLink(), command: commandOf(step) }).toEqual({ link: true, command: '/aspira-planner KIT-11 --take-recommended' })
  }, SLOW)

  it('continues from inside the worktree: the ticket folder is there and the next stage is the step', async () => {
    const { h, result } = await fromMain({ status: 'Ready: Spec' })
    const mainState = JSON.parse(await readFile(join(h.stateDir, 'state.json'), 'utf8')) as { inProgress: unknown; runs: { ended: string | null }[] }
    h.cd(String(result.stage?.worktree))
    await h.answer(result.stage, {})
    const step = await h.advance()
    expect({
      spec: existsSync(join(h.folder, 'spec.md')),
      folder: h.folder === join(worktreeFor(h.main), '.work', SLUG),
      command: commandOf(step),
      inProgress: ((await h.state()).inProgress as { runId?: string } | null)?.runId === step.stage?.runId,
      mainLock: mainState.inProgress,
      mainEnded: mainState.runs.at(-1)?.ended,
    }).toEqual({ spec: true, folder: true, command: '/aspira-planner KIT-11 --take-recommended', inProgress: true, mainLock: null, mainEnded: 'moved' })
  }, SLOW)

  it('reuses an existing worktree: from the main checkout it only says to continue there, and adds no worktree', async () => {
    const h = await project({ status: 'Ready: Spec', layout: 'checkout' })
    await mkdir(h.folder, { recursive: true })
    await writeFile(join(h.folder, 'spec.md'), SPEC)
    const worktree = worktreeFor(h.main)
    await exec('git', ['-C', h.main, 'worktree', 'add', '-q', '-b', 'feat/kit-11-x', worktree, 'main'])
    const redirect = await h.start()
    h.cd(worktree)
    const step = await h.advance({}, await h.start())
    expect({
      stage: redirect.stage?.stage,
      worktree: redirect.stage?.worktree,
      adds: (await h.gitCalls()).filter((args) => args[0] === 'worktree' && args[1] === 'add').length,
      spec: existsSync(join(h.folder, 'spec.md')),
      command: commandOf(step),
    }).toEqual({ stage: 'worktree', worktree, adds: 0, spec: true, command: '/aspira-planner KIT-11 --take-recommended' })
  }, SLOW)

  it('stops naming the missing Type before any worktree or step when the card has no Type', async () => {
    const { h, result } = await fromMain({ status: 'Ready: Spec', type: null })
    const text = `${result.text}\n${await readFile(join(h.folder, 'build-summary.md'), 'utf8').catch(() => '')}`
    expect({ end: result.stage?.stage, named: /\bType\b/.test(text), worktrees: existsSync(join(h.main, '.worktrees')), steps: kinds(h.stages).filter((kind) => kind === 'step' || kind === 'worktree').length }).toEqual({
      end: 'end',
      named: true,
      worktrees: false,
      steps: 0,
    })
  }, SLOW)
})

// KIT-67 T33 (F1, F25): step 1 brings the worktree to its isolated state. The driver is a child process, so
// the isolation seams are stood in for at the boundary it crosses (isolation.test-helper.ts): Neon and
// Cloudflare DNS through NEON_API_BASE_URL and CLOUDFLARE_API_BASE_URL, cloudflared and the Stripe CLI as
// fake executables on PATH, all over one in-memory state. A project without isolation keys calls none of them.
describe('KIT-67 T33: the run isolates the ticket\'s worktree', () => {
  const worlds: World[] = []
  afterAll(async () => {
    for (const world of worlds) await world.close()
  })
  const newWorld = async (): Promise<World> => {
    const world = await isolationWorld()
    worlds.push(world)
    return world
  }

  /** The main checkout at Ready: Spec with the isolation keys in aspira.json (or `aspira`), the ticket's spec in its .work/, and the fake services wired in. */
  async function isolatedProject(world: World, aspira: Record<string, unknown> | undefined = ISOLATED_ASPIRA): Promise<Project> {
    const h = await project({ layout: 'checkout', status: 'Ready: Spec', ...(aspira === undefined ? {} : { aspira }), mainFiles: { '.gitignore': ISOLATED_IGNORE }, env: world.env })
    await world.install(h.dir)
    await mkdir(h.folder, { recursive: true })
    await writeFile(join(h.folder, 'spec.md'), SPEC)
    return h
  }

  /** A worktree made before isolation existed: plain git, no env file, no resources. */
  async function preexisting(h: Project): Promise<string> {
    const worktree = worktreeFor(h.main)
    await exec('git', ['-C', h.main, 'worktree', 'add', '-q', '-b', 'feat/kit-11-x', worktree, 'main'])
    return worktree
  }

  const addsOf = async (h: Project) => (await h.gitCalls()).filter((args) => args[0] === 'worktree' && args[1] === 'add').length

  const envOf = async (worktree: string): Promise<Record<string, string>> => {
    const text = await readFile(join(worktree, '.env.development.local'), 'utf8').catch(() => '')
    return Object.fromEntries(text.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  }

  /** What isolation leaves for KIT-11: the same state T7, T13, T14 and T16 assert, read back from the mocks and the worktree. */
  async function isolatedState(h: Project, world: World) {
    const worktree = worktreeFor(h.main)
    const env = await envOf(worktree)
    const config = await readFile(join(worktree, '.aspira/cloudflared.yml'), 'utf8').catch(() => '')
    const { state } = world.mocks
    return {
      branch: state.branches.map((branch) => branch.name).filter((name) => name.startsWith('wt/')),
      database: /^postgres(?:ql)?:\/\/.*wt-kit-11/.test(env.DATABASE_URL ?? ''),
      port: /^\d+$/.test(env.PORT ?? ''),
      urls: [env.BETTER_AUTH_URL, env.NEXT_PUBLIC_APP_URL],
      expectedUrl: `http://kit-11.localhost:${env.PORT}`,
      tunnels: state.tunnels.map((tunnel) => tunnel.name),
      cname: state.cnames.map((cname) => cname.name),
      tunnelConfig: config.includes('kit-11-branch.aspiralabs.co') && config.includes(`http://localhost:${env.PORT}`),
      endpoints: state.endpoints.map((endpoint) => endpoint.metadata.aspira_worktree),
      secret: env.STRIPE_WEBHOOK_SECRET !== undefined && env.STRIPE_WEBHOOK_SECRET === state.endpoints[0]?.secret,
    }
  }

  const ISOLATED = { branch: ['wt/kit-11'], database: true, port: true, tunnels: ['wt-kit-11'], cname: ['kit-11-branch.aspiralabs.co'], tunnelConfig: true, endpoints: ['kit-11'], secret: true }
  const settled = async (h: Project, world: World) => {
    const { urls, expectedUrl, ...rest } = await isolatedState(h, world)
    return { ...rest, urls: urls.map((url) => url === expectedUrl) }
  }
  const ISOLATED_URLS = [true, true]

  it('creates the worktree isolated: branch, PORT, URL variables, tunnel config and endpoint secret, with one git worktree add, before any step', async () => {
    const world = await newWorld()
    const h = await isolatedProject(world)
    const result = await h.advance({}, await h.start())
    expect({ stage: result.stage?.stage, adds: await addsOf(h), steps: ofKind(h.stages, 'step').length, ...(await settled(h, world)) }).toEqual({ stage: 'worktree', adds: 1, steps: 0, ...ISOLATED, urls: ISOLATED_URLS })
  }, SLOW)

  it('completes missing isolation on a rerun from the main checkout: the redirect stage is still worktree and no worktree is added', async () => {
    const world = await newWorld()
    const h = await isolatedProject(world)
    await preexisting(h)
    const redirect = await h.start()
    expect({ stage: redirect.stage?.stage, adds: await addsOf(h), ...(await settled(h, world)) }).toEqual({ stage: 'worktree', adds: 0, ...ISOLATED, urls: ISOLATED_URLS })
  }, SLOW)

  it('completes missing isolation on a rerun from inside the worktree: the run goes on to the step and no worktree is added', async () => {
    const world = await newWorld()
    const h = await isolatedProject(world)
    const worktree = await preexisting(h)
    h.cd(worktree)
    await h.write(`.work/${SLUG}/spec.md`, SPEC)
    const step = await h.advance({}, await h.start())
    expect({ command: commandOf(step), adds: await addsOf(h), ...(await settled(h, world)) }).toEqual({ command: '/aspira-planner KIT-11 --take-recommended', adds: 0, ...ISOLATED, urls: ISOLATED_URLS })
  }, SLOW)

  it('a project with no isolation keys makes the worktree as before and calls no database, tunnel or Stripe service', async () => {
    const world = await newWorld()
    const h = await isolatedProject(world, { board: BOARD, repository: REPOSITORY })
    const result = await h.advance({}, await h.start())
    const worktree = worktreeFor(h.main)
    expect({
      stage: result.stage?.stage,
      adds: await addsOf(h),
      branches: world.mocks.state.branches.map((branch) => branch.name),
      resources: [world.mocks.state.tunnels.length, world.mocks.state.cnames.length, world.mocks.state.endpoints.length],
      calls: [world.mocks.calls.cloudflared.length, world.mocks.calls.stripe.length, world.mocks.events.length],
      envFile: existsSync(join(worktree, '.env.development.local')),
      tunnelConfig: existsSync(join(worktree, '.aspira')),
    }).toEqual({ stage: 'worktree', adds: 1, branches: ['main', 'dev'], resources: [0, 0, 0], calls: [0, 0, 0], envFile: false, tunnelConfig: false })
  }, SLOW)

  it('halts naming the database step when Neon fails, keeps the worktree, and a rerun from the main checkout completes the isolation', async () => {
    const world = await newWorld()
    world.mocks.failNeonCreate = true
    const h = await isolatedProject(world)
    const failed = await h.advance({}, await h.start())
    const text = `${failed.text}\n${await h.summary()}`
    const halted = { end: failed.stage?.stage, stopped: failed.stage?.stopped, named: /database/i.test(text), steps: ofKind(h.stages, 'step').length, kept: existsSync(worktreeFor(h.main)) }
    world.mocks.failNeonCreate = false
    const rerun = await h.start()
    expect({ halted, rerun: rerun.stage?.stage, adds: await addsOf(h), ...(await settled(h, world)) }).toEqual({ halted: { end: 'end', stopped: true, named: true, steps: 0, kept: true }, rerun: 'worktree', adds: 1, ...ISOLATED, urls: ISOLATED_URLS })
  }, SLOW)
})

describe('review AVA1.1: the base branch is checked before git sees it', () => {
  it('refuses a base that is not a plain branch name before fetching it', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { prepareWorktree, TICKET_TYPES } = await import('./worktree.ts')
    const main = await mkdtemp(join(tmpdir(), 'wt-base-'))
    const fetched: string[] = []
    const sys = { gitFetchMain: async (_options: unknown, base: string) => { fetched.push(base); return { code: 0, stdout: '', stderr: '' } } } as unknown as Parameters<typeof prepareWorktree>[1]
    const outcome = await prepareWorktree({ place: { top: main, main, commonDir: join(main, '.git') }, id: 'KIT-1', title: 'x', type: TICKET_TYPES.Feature, cardType: 'Feature', env: {}, base: '--upload-pack=x', skipIsolation: true }, sys).catch((error: Error) => ({ ok: false as const, message: error.message }))
    expect([outcome.ok, fetched]).toEqual([false, []])
  })
})
