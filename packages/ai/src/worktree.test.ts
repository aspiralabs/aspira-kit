// kit worktree against real git: a bare origin, a main checkout cloned from it, and the ticket
// worktrees `kit worktree` adds. The board is the one boundary replaced, through the injected
// TicketLookup; install and build run the real npm on a package with no dependencies.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedTicket } from './next.js'
import type { TicketLookup, TicketLookupResult } from './ticket-lookup.js'
import { forbiddenSeams, ISOLATION_CONFIG, setServiceEnv, startMocks, type MockSeams, type Mocks } from './isolation-mocks.test.js'
import { worktree } from './worktree.js'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const MARKER = 'built.marker'

const made: string[] = []
const npmEnv = { npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_offline: 'true' }
const savedEnv = new Map<string, string | undefined>()

beforeAll(() => {
  // npm runs offline and quietly, here and when kit worktree spawns it: the fixture packages have no registry dependencies.
  for (const [key, value] of Object.entries(npmEnv)) {
    savedEnv.set(key, process.env[key])
    process.env[key] = value
  }
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** Run git in `cwd`, failing the test on a non-zero exit; returns trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=Kit Test', '-c', 'user.email=kit@test.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${run.stderr}`)
  return run.stdout.trim()
}

function npm(cwd: string, ...args: string[]): void {
  const run = spawnSync('npm', args, { cwd, encoding: 'utf8', env: { ...process.env, ...npmEnv } })
  if (run.status !== 0) throw new Error(`npm ${args.join(' ')} in ${cwd} failed: ${run.stderr}`)
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const BUILD_SCRIPT = `import { writeFileSync } from 'node:fs'\nwriteFileSync('${MARKER}', 'built\\n')\n`
const FAILING_BUILD = 'process.exit(1)\n'

type Variant = {
  /** Where the app lives: the root (default), apps/web without a root workspace, or apps/web in a root npm workspace. */
  app?: 'root' | 'standalone' | 'workspace'
  /** The app's build script: writes the marker (default), exits 1, or is absent. */
  build?: 'ok' | 'fail' | 'none'
  /** A dependency npm cannot install (a file: tarball that does not exist). */
  brokenInstall?: boolean
  /** Extra aspira.json keys beside the board (the KIT-67 isolation keys). */
  config?: Record<string, unknown>
  /** Extra .gitignore lines beside the defaults. */
  ignore?: string[]
  /** aspira.json only in the main checkout, git-ignored and never committed (KIT-71), instead of committed on main. */
  untrackedAspira?: boolean
  /** A root app with prisma/schema.prisma and prisma as a dev dependency, and a hand-written lockfile (npm is faked on PATH for it). */
  prisma?: boolean
}

type Fixture = { tmp: string; origin: string; main: string }

/** Write a package.json at `dir`, with a `build` script and its build.mjs unless `build` is 'none'. */
function writePackage(dir: string, pkg: Record<string, unknown>, build: Variant['build']): void {
  mkdirSync(dir, { recursive: true })
  const scripts = build === 'none' || build === undefined ? {} : { build: 'node build.mjs' }
  writeFileSync(join(dir, 'package.json'), json({ ...pkg, scripts }))
  if (build !== 'none' && build !== undefined) writeFileSync(join(dir, 'build.mjs'), build === 'fail' ? FAILING_BUILD : BUILD_SCRIPT)
}

/**
 * A bare origin whose main holds aspira.json, package.json, package-lock.json (so npm is detected)
 * and a .gitignore listing .worktrees/ and .env.local; and a main checkout cloned from it, on a
 * branch of its own, with a root .env.local.
 */
function fixture(variant: Variant = {}): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kit-worktree-')))
  made.push(tmp)
  const seed = join(tmp, 'seed')
  const origin = join(tmp, 'origin.git')
  const main = join(tmp, 'main')
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  const app = variant.app ?? 'root'
  const build = variant.build ?? 'ok'
  writeFileSync(join(seed, '.gitignore'), ['.worktrees/', '.env.local', 'node_modules/', MARKER, ...(variant.untrackedAspira === true ? ['aspira.json'] : []), ...(variant.ignore ?? []), ''].join('\n'))
  const aspira = json(app === 'root' ? { board: BOARD, ...variant.config } : { board: BOARD, app: 'apps/web', ...variant.config })
  if (variant.untrackedAspira !== true) writeFileSync(join(seed, 'aspira.json'), aspira)
  if (app === 'root') {
    const dependencies = variant.brokenInstall === true ? { missing: 'file:./missing.tgz' } : {}
    writePackage(seed, { name: 'fixture', version: '1.0.0', private: true, dependencies, ...(variant.prisma === true ? { devDependencies: { prisma: '^6' } } : {}) }, build)
    if (variant.prisma === true) {
      mkdirSync(join(seed, 'prisma'))
      writeFileSync(join(seed, 'prisma', 'schema.prisma'), 'generator client {\n  provider = "prisma-client-js"\n}\n')
    }
    if (variant.brokenInstall === true || variant.prisma === true) {
      // The lockfile npm would write before the dependency was added; npm install then fails on the missing tarball.
      writeFileSync(join(seed, 'package-lock.json'), json({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }))
    } else {
      npm(seed, 'install', '--package-lock-only')
    }
  } else if (app === 'standalone') {
    // A root package.json with no workspaces: apps/web owns its lockfile and install.
    writeFileSync(join(seed, 'package.json'), json({ name: 'repo', version: '1.0.0', private: true }))
    writePackage(join(seed, 'apps', 'web'), { name: 'web', version: '1.0.0', private: true }, build)
    npm(join(seed, 'apps', 'web'), 'install', '--package-lock-only')
  } else {
    writePackage(seed, { name: 'repo', version: '1.0.0', private: true, workspaces: ['apps/*'] }, build)
    writePackage(join(seed, 'apps', 'web'), { name: 'web', version: '1.0.0', private: true }, 'none')
    npm(seed, 'install', '--package-lock-only')
  }
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'initial')
  git(tmp, 'clone', '-q', '--bare', seed, origin)
  git(tmp, 'clone', '-q', origin, main)
  git(main, 'checkout', '-q', '-b', 'chore/other')
  if (variant.untrackedAspira === true) writeFileSync(join(main, 'aspira.json'), aspira)
  writeFileSync(join(main, '.env.local'), variant.config === undefined ? 'NOTION_TOKEN=secret\n' : 'NOTION_TOKEN=secret\nSTRIPE_SECRET_KEY=sk_test_x\n')
  return { tmp, origin, main }
}

const feature = (over: Partial<ResolvedTicket> = {}): TicketLookupResult => ({
  ticket: { id: 'KIT-13', title: 'Kit QoL cleanup', url: 'https://www.notion.so/kit-13', status: 'Ready: Plan', type: 'Feature', folder: 'kit-13-kit-qol-cleanup', ...over },
})

const answer =
  (result: TicketLookupResult): TicketLookup =>
  () =>
    result

type Run = { code: number; lines: string[]; out: string }

async function run(projectRoot: string, ref: string, result: TicketLookupResult, install = false, seams?: MockSeams): Promise<Run> {
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(...line.split('\n'))
  }
  // Built apart from the call so the optional `seams` key does not trip the options type before the kit has it.
  const options = { projectRoot, app: undefined, ref, lookup: answer(result), install, log, ...(seams === undefined ? {} : { seams }) }
  const code = await Promise.resolve(worktree(options))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { code, lines, out: lines.join('\n') }
}

const handlePath = (main: string, handle: string): string => join(main, '.worktrees', handle)

function registered(main: string): string[] {
  return git(main, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync(line.slice('worktree '.length)))
}

const isRegistered = (main: string, path: string): boolean => existsSync(path) && registered(main).includes(realpathSync(path))

const branches = (main: string): string[] =>
  git(main, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter((line) => line !== '')
    .toSorted()

const currentBranch = (dir: string): string => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

const lineWith = (lines: string[], ...parts: string[]): string | undefined => lines.find((line) => parts.every((part) => line.includes(part)))

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('kit worktree: creating a ticket worktree', () => {
  it('T42 creates .worktrees/FEATURE-KIT-13 on feat/<folder> from origin/main, then installs and builds there', async () => {
    const { main } = fixture()
    const result = await run(main, 'KIT-13', feature())
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(result.code).toBe(0)
    expect(isRegistered(main, wt)).toBe(true)
    expect(currentBranch(wt)).toBe('feat/kit-13-kit-qol-cleanup')
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'origin/main'))
    expect(lineWith(result.lines, 'npm install', wt)).toBeDefined()
    expect(lineWith(result.lines, 'npm run build', wt)).toBeDefined()
    expect(existsSync(join(wt, MARKER))).toBe(true)
  })

  it('runs prisma generate in a Prisma app after the install and before the build, naming the command (KIT-75)', async () => {
    const { tmp, main } = fixture({ prisma: true })
    // A fake npm that records its calls: the fixture has no registry and prisma is not installed.
    const bin = join(tmp, 'bin')
    const calls = join(tmp, 'npm-calls')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$PWD $*" >> '${calls}'\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ''}`
    let result: Run
    try {
      result = await run(main, 'KIT-13', feature())
    } finally {
      process.env.PATH = path
    }
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(result.code).toBe(0)
    expect(lineWith(result.lines, 'generate', 'npm exec prisma generate', wt)).toBeDefined()
    expect(readFileSync(calls, 'utf8').split('\n').filter((line) => line !== '')).toEqual([`${wt} install`, `${wt} exec prisma generate`, `${wt} run build`])
  })

  it('runs no prisma generate in a project without Prisma (KIT-75)', async () => {
    const { main } = fixture()
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(0)
    expect(result.out).not.toContain('prisma')
  })

  it('T42 places the worktree under the main checkout when run from inside another ticket worktree', async () => {
    const { main } = fixture()
    const other = handlePath(main, 'CHORE-KIT-1')
    git(main, 'worktree', 'add', '-q', '-b', 'chore/kit-1-other', other, 'origin/main')
    const result = await run(other, 'KIT-13', feature())
    expect(result.code).toBe(0)
    expect(isRegistered(main, handlePath(main, 'FEATURE-KIT-13'))).toBe(true)
    expect(existsSync(join(other, '.worktrees', 'FEATURE-KIT-13'))).toBe(false)
  })

  it('T56 ends with the worktree path and its branch on their own lines', async () => {
    const { main } = fixture()
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(0)
    expect(result.lines.slice(-2)).toEqual([handlePath(main, 'FEATURE-KIT-13'), 'feat/kit-13-kit-qol-cleanup'])
  })

  it('T43 installs and builds in <worktree>/apps/web when aspira.json names an app without a root workspace', async () => {
    const { main } = fixture({ app: 'standalone' })
    const result = await run(main, 'KIT-13', feature())
    const appDir = join(handlePath(main, 'FEATURE-KIT-13'), 'apps', 'web')
    expect(result.code).toBe(0)
    expect(lineWith(result.lines, 'npm install', appDir)).toBeDefined()
    expect(lineWith(result.lines, 'npm run build', appDir)).toBeDefined()
    expect(existsSync(join(appDir, MARKER))).toBe(true)
  })

  it('T43 reports the build as skipped when the app has no build script, and exits 0', async () => {
    const { main } = fixture({ app: 'standalone', build: 'none' })
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(0)
    expect(result.lines.some((line) => /build/i.test(line) && /skipped/i.test(line))).toBe(true)
    expect(lineWith(result.lines, 'npm run build')).toBeUndefined()
  })

  it('T44 uses fix/ and BUG- for a Bug card, chore/ and CHORE- for a Chore card', async () => {
    const { main } = fixture()
    const bug = await run(main, 'KIT-14', feature({ id: 'KIT-14', type: 'Bug', folder: 'kit-14-fix-it' }))
    expect(bug.code).toBe(0)
    expect(currentBranch(handlePath(main, 'BUG-KIT-14'))).toBe('fix/kit-14-fix-it')
    const chore = await run(main, 'KIT-15', feature({ id: 'KIT-15', type: 'Chore', folder: 'kit-15-tidy' }))
    expect(chore.code).toBe(0)
    expect(currentBranch(handlePath(main, 'CHORE-KIT-15'))).toBe('chore/kit-15-tidy')
  })
})

describe('kit worktree: an existing branch', () => {
  /** A local branch for KIT-13 under an older title, holding one commit `start work`; returns its short sha. */
  function oldTitleBranch(main: string): string {
    git(main, 'checkout', '-q', '-b', 'feat/kit-13-old-title', 'origin/main')
    writeFileSync(join(main, 'work.txt'), 'started\n')
    git(main, 'add', 'work.txt')
    git(main, 'commit', '-q', '-m', 'start work')
    const sha = git(main, 'log', '-1', '--format=%h')
    git(main, 'checkout', '-q', 'chore/other')
    return sha
  }

  it('T45 reuses a local branch made under an older title, prints its last commit, and leaves install and build to you (AVA1.1)', async () => {
    const { main } = fixture()
    const sha = oldTitleBranch(main)
    const result = await run(main, 'KIT-13', feature({ folder: 'kit-13-new-title' }))
    expect(result.code).toBe(0)
    expect(currentBranch(handlePath(main, 'FEATURE-KIT-13'))).toBe('feat/kit-13-old-title')
    expect(result.lines.some((line) => /reus/i.test(line) && line.includes('feat/kit-13-old-title'))).toBe(true)
    expect(result.out).toContain('feat/kit-13-new-title')
    expect(result.lines.some((line) => line.includes(sha) && line.includes('start work'))).toBe(true)
    // The step lines runStep logs (`install  <dir>: npm install`); the skip line names the commands without running them.
    expect(result.lines.some((line) => line.startsWith('install ') || line.startsWith('build '))).toBe(false)
    expect(result.lines.some((line) => line.startsWith('skip') && line.includes('--install'))).toBe(true)
  })

  it('T45 with --install runs install and build on a reused branch, after printing its last commit', async () => {
    const { main } = fixture()
    const sha = oldTitleBranch(main)
    const result = await run(main, 'KIT-13', feature({ folder: 'kit-13-new-title' }), true)
    expect(result.code).toBe(0)
    const commit = result.lines.findIndex((line) => line.includes(sha) && line.includes('start work'))
    const install = result.lines.findIndex((line) => line.includes('npm install'))
    expect(commit).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(commit)
  })

  it('T45 checks out a branch that exists only on origin, tracking it, and runs none of its scripts (AVA1.1)', async () => {
    const { main } = fixture()
    git(main, 'push', '-q', 'origin', 'origin/main:refs/heads/feat/kit-13-remote')
    git(main, 'update-ref', '-d', 'refs/remotes/origin/feat/kit-13-remote')
    const result = await run(main, 'KIT-13', feature())
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(result.code).toBe(0)
    expect(currentBranch(wt)).toBe('feat/kit-13-remote')
    expect(git(wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('origin/feat/kit-13-remote')
    expect(result.lines.some((line) => line.startsWith('install ') || line.startsWith('build '))).toBe(false)
    expect(result.lines.some((line) => line.startsWith('skip') && line.includes('--install'))).toBe(true)
  })

  it('T45 refuses when more than one branch matches the ticket, listing them', async () => {
    const { main } = fixture()
    git(main, 'branch', 'feat/kit-13-a', 'origin/main')
    git(main, 'branch', 'fix/kit-13-b', 'origin/main')
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(1)
    expect(result.out).toContain('feat/kit-13-a')
    expect(result.out).toContain('fix/kit-13-b')
    expect(existsSync(handlePath(main, 'FEATURE-KIT-13'))).toBe(false)
  })

  it('T46 refuses when the branch is checked out in the main checkout, naming that checkout', async () => {
    const { main } = fixture()
    git(main, 'checkout', '-q', '-b', 'feat/kit-13-x')
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(1)
    // The main checkout's own path, not only as the prefix of the worktree path that was not created.
    expect(result.lines.some((line) => new RegExp(`${escapeRegExp(main)}(?!/)`).test(line))).toBe(true)
    expect(existsSync(handlePath(main, 'FEATURE-KIT-13'))).toBe(false)
  })
})

describe('kit worktree: fetching origin', () => {
  it('T47 branches from the commit just pushed to origin main by another clone', async () => {
    const { tmp, origin, main } = fixture()
    const other = join(tmp, 'other')
    git(tmp, 'clone', '-q', origin, other)
    writeFileSync(join(other, 'news.txt'), 'new\n')
    git(other, 'add', 'news.txt')
    git(other, 'commit', '-q', '-m', 'newer main')
    git(other, 'push', '-q', 'origin', 'main')
    const pushed = git(other, 'rev-parse', 'HEAD')
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(0)
    expect(git(handlePath(main, 'FEATURE-KIT-13'), 'rev-parse', 'HEAD')).toBe(pushed)
  })

  it('T47 says the fetch failed and origin/main may be stale, then creates the worktree from the last-fetched origin/main', async () => {
    const { tmp, main } = fixture()
    const lastFetched = git(main, 'rev-parse', 'origin/main')
    git(main, 'remote', 'set-url', 'origin', join(tmp, 'missing.git'))
    const result = await run(main, 'KIT-13', feature())
    expect(result.lines.some((line) => /fetch/i.test(line) && /fail/i.test(line))).toBe(true)
    expect(result.lines.some((line) => line.includes('origin/main') && /stale/i.test(line))).toBe(true)
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(isRegistered(main, wt)).toBe(true)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(lastFetched)
  })
})

describe('kit worktree: the worktree folder already there', () => {
  it('T48 reports an existing registered worktree and creates no second branch', async () => {
    const { main } = fixture()
    expect((await run(main, 'KIT-13', feature())).code).toBe(0)
    const after = branches(main)
    const again = await run(main, 'KIT-13', feature())
    expect(again.code).toBe(0)
    expect(again.out).toContain(handlePath(main, 'FEATURE-KIT-13'))
    expect(branches(main)).toEqual(after)
  })

  it('T49 reports git worktree add failing with git\'s message and goes no further', async () => {
    const { main } = fixture()
    // A file where the .worktrees folder goes: git cannot create the worktree under it, even as root
    // (some CI runners run as root, which ignores a read-only folder).
    writeFileSync(join(main, '.worktrees'), 'not a folder\n')
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(1)
    expect(result.lines.some((line) => line.includes('git worktree add') && /fail/i.test(line))).toBe(true)
    expect(result.out).toMatch(/could not create|Not a directory/i)
    expect(lineWith(result.lines, '.env.local')).toBeUndefined()
    expect(lineWith(result.lines, 'npm install')).toBeUndefined()
    expect(lineWith(result.lines, 'npm run build')).toBeUndefined()
  })

  it('T50 refuses a folder at .worktrees/FEATURE-KIT-13 that is not a registered worktree', async () => {
    const { main } = fixture()
    const stray = handlePath(main, 'FEATURE-KIT-13')
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'notes.txt'), 'not a worktree\n')
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/not a (registered )?worktree/i)
    expect(branches(main).filter((name) => name.startsWith('feat/kit-13-'))).toEqual([])
  })
})

describe('kit worktree: refusing a card', () => {
  it.each(['released', 'Dropped'])('T51 refuses a card whose Status is %s, naming it', async (status) => {
    const { main } = fixture()
    const before = branches(main)
    const result = await run(main, 'KIT-13', feature({ status }))
    expect(result.code).toBe(1)
    expect(result.out).toContain(status)
    expect(existsSync(handlePath(main, 'FEATURE-KIT-13'))).toBe(false)
    expect(branches(main)).toEqual(before)
  })

  it('T52 refuses a card with no Type, naming BOARD-011', async () => {
    const { main } = fixture()
    const before = branches(main)
    const result = await run(main, 'KIT-13', feature({ type: '' }))
    expect(result.code).toBe(1)
    expect(result.out).toContain('BOARD-011')
    expect(result.out).toMatch(/Type/)
    expect(existsSync(join(main, '.worktrees'))).toBe(false)
    expect(branches(main)).toEqual(before)
  })

  it('T52 refuses a Type other than Feature, Bug or Chore', async () => {
    const { main } = fixture()
    const before = branches(main)
    const result = await run(main, 'KIT-13', feature({ type: 'Epic' }))
    expect(result.code).toBe(1)
    expect(result.out).toContain('Type Epic has no handle or branch prefix (BOARD-011)')
    expect(existsSync(join(main, '.worktrees'))).toBe(false)
    expect(branches(main)).toEqual(before)
  })

  it('T52 matches the Type trimmed and case-insensitively', async () => {
    const { main } = fixture()
    const result = await run(main, 'KIT-13', feature({ type: ' feature ' }))
    expect(result.code).toBe(0)
    expect(isRegistered(main, handlePath(main, 'FEATURE-KIT-13'))).toBe(true)
  })

  it('T53 refuses when the installed @aspiralabs/ai reports no Type, naming the version mismatch', async () => {
    const { main } = fixture()
    const before = branches(main)
    const result = await run(main, 'KIT-13', feature({ type: undefined, folder: undefined }))
    expect(result.code).toBe(1)
    expect(result.out).toContain('the installed @aspiralabs/ai does not report')
    expect(result.out).toContain('install @aspiralabs/ai')
    expect(result.out).toContain('kit init')
    expect(existsSync(join(main, '.worktrees'))).toBe(false)
    expect(branches(main)).toEqual(before)
  })

  it.each([
    { reason: 'unknown ID', detail: 'resolve-ticket: No ticket KIT-13 on the board', expected: ['unknown ID'] },
    { reason: 'board unreachable', detail: 'fetch failed', expected: ['board unreachable', 'fetch failed'] },
    { reason: 'no Status on the card', detail: 'status is empty', expected: ['no Status on the card'] },
  ] as const)('T53 refuses when the lookup answers $reason, saying why', async ({ reason, detail, expected }) => {
    const { main } = fixture()
    const before = branches(main)
    const result = await run(main, 'KIT-13', { reason, detail, cause: 'board' })
    expect(result.code).toBe(1)
    for (const part of expected) expect(result.out).toContain(part)
    expect(existsSync(join(main, '.worktrees'))).toBe(false)
    expect(branches(main)).toEqual(before)
  })
})

describe('kit worktree: .env.local', () => {
  it('T54 links the main checkout\'s root .env.local, skips the app\'s missing one, and leaves git status clean', async () => {
    const { main } = fixture({ app: 'workspace' })
    const result = await run(main, 'KIT-13', feature())
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(result.code).toBe(0)
    const link = join(wt, '.env.local')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(join(main, '.env.local')))
    expect(readFileSync(link, 'utf8')).toBe('NOTION_TOKEN=secret\n')
    expect(existsSync(join(wt, 'apps', 'web', '.env.local'))).toBe(false)
    expect(result.lines.some((line) => line.includes(join('apps', 'web', '.env.local')) && /skip/i.test(line))).toBe(true)
    expect(git(wt, 'status', '--porcelain')).toBe('')
  })
})

describe('kit worktree: aspira.json (KIT-71)', () => {
  it('links the main checkout\'s git-ignored aspira.json into the new worktree, and leaves git status clean', async () => {
    const { main } = fixture({ app: 'workspace', untrackedAspira: true })
    const result = await run(main, 'KIT-13', feature())
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(result.code).toBe(0)
    const link = join(wt, 'aspira.json')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(join(main, 'aspira.json')))
    expect(lineWith(result.lines, 'link', link)).toBeDefined()
    expect(git(wt, 'status', '--porcelain')).toBe('')
  })

  it('keeps the aspira.json a branch still commits, linking nothing over it', async () => {
    const { main } = fixture()
    const result = await run(main, 'KIT-13', feature())
    const link = join(handlePath(main, 'FEATURE-KIT-13'), 'aspira.json')
    expect(result.code).toBe(0)
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(lineWith(result.lines, 'link', link)).toBeUndefined()
  })
})

describe('kit worktree: install or build failing', () => {
  it('T55 names a failed build, keeps the worktree and exits 1', async () => {
    const { main } = fixture({ build: 'fail' })
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(1)
    expect(result.lines.some((line) => /build/i.test(line) && /fail/i.test(line))).toBe(true)
    expect(isRegistered(main, handlePath(main, 'FEATURE-KIT-13'))).toBe(true)
  })

  it('T55 names a failed install, keeps the worktree and exits 1', async () => {
    const { main } = fixture({ brokenInstall: true })
    const result = await run(main, 'KIT-13', feature())
    expect(result.code).toBe(1)
    expect(result.lines.some((line) => /install/i.test(line) && /fail/i.test(line))).toBe(true)
    expect(isRegistered(main, handlePath(main, 'FEATURE-KIT-13'))).toBe(true)
  })
})

/** The KIT-67 isolation keys with the .env.development.local and .aspira/ ignore lines the kit needs before it writes there. */
const ISOLATED = { config: ISOLATION_CONFIG, ignore: ['.env.development.local', '.aspira/'] } satisfies Variant

describe('kit worktree: a project with no isolation keys (T23, F1)', () => {
  it('T23 creates and then reports the existing worktree exactly as before, and calls no seam', async () => {
    const { main } = fixture()
    const { seams, used } = forbiddenSeams()
    const wt = handlePath(main, 'FEATURE-KIT-13')
    const created = await run(main, 'KIT-13', feature(), false, seams)
    expect(created.code).toBe(0)
    expect(created.lines.slice(-2)).toEqual([wt, 'feat/kit-13-kit-qol-cleanup'])
    expect(lineWith(created.lines, 'created', wt)).toBeDefined()
    const again = await run(main, 'KIT-13', feature(), false, seams)
    expect(again.code).toBe(0)
    expect(again.lines.filter((line) => !line.startsWith('ticket') && !line.startsWith('fetch'))).toEqual([`exists   ${wt} (already a worktree on feat/kit-13-kit-qol-cleanup)`, wt, 'feat/kit-13-kit-qol-cleanup'])
    expect(used()).toEqual([])
    expect(existsSync(join(wt, '.env.development.local'))).toBe(false)
    expect(existsSync(join(wt, '.aspira'))).toBe(false)
  })
})

describe('kit worktree: isolating an existing worktree (T24, F4 F5 F6)', () => {
  let mocks: Mocks
  let restore: () => void

  beforeEach(async () => {
    mocks = await startMocks()
    restore = setServiceEnv()
  })

  afterEach(async () => {
    restore()
    await mocks.close()
  })

  /** A worktree made before isolation existed: plain git, no env file, no resources. */
  function preexisting(main: string): string {
    const wt = handlePath(main, 'FEATURE-KIT-13')
    git(main, 'worktree', 'add', '-q', '-b', 'feat/kit-13-kit-qol-cleanup', wt, 'origin/main')
    return wt
  }

  it('T24 runs the missing isolation on a rerun and exits 0 instead of returning at "exists"', async () => {
    const { main } = fixture(ISOLATED)
    const wt = preexisting(main)
    const result = await run(main, 'KIT-13', feature(), false, mocks.seams)
    expect(result.code).toBe(0)
    expect(mocks.state.branches.map((branch) => branch.name)).toContain('wt/kit-13')
    expect(mocks.state.tunnels.map((tunnel) => tunnel.name)).toEqual(['wt-kit-13'])
    expect(mocks.state.endpoints.map((endpoint) => endpoint.metadata.aspira_worktree)).toEqual(['kit-13'])
    const env = readFileSync(join(wt, '.env.development.local'), 'utf8')
    expect(env).toMatch(/^DATABASE_URL=/m)
    expect(env).toMatch(/^PORT=\d+$/m)
    expect(git(wt, 'status', '--porcelain')).toBe('')
    expect(result.lines.slice(-2)).toEqual([wt, 'feat/kit-13-kit-qol-cleanup'])
  })

  it('T24 a second rerun creates nothing new', async () => {
    const { main } = fixture(ISOLATED)
    preexisting(main)
    expect((await run(main, 'KIT-13', feature(), false, mocks.seams)).code).toBe(0)
    expect(mocks.state.branches.map((branch) => branch.name)).toContain('wt/kit-13')
    const before = JSON.stringify(mocks.state)
    expect((await run(main, 'KIT-13', feature(), false, mocks.seams)).code).toBe(0)
    expect(JSON.stringify(mocks.state)).toBe(before)
  })

  it('T24 with a failing Neon mock exits 1 naming the database step, and the worktree folder remains', async () => {
    const { main } = fixture(ISOLATED)
    const wt = preexisting(main)
    mocks.failNeonCreate = true
    const result = await run(main, 'KIT-13', feature(), false, mocks.seams)
    expect(result.code).toBe(1)
    expect(result.lines.some((line) => /database/i.test(line))).toBe(true)
    expect(isRegistered(main, wt)).toBe(true)
    // A rerun with a healthy mock resumes and finishes.
    mocks.failNeonCreate = false
    expect((await run(main, 'KIT-13', feature(), false, mocks.seams)).code).toBe(0)
  })

  it('T24 without the .env.development.local ignore line exits 1 naming that line, and writes no env file', async () => {
    const { main } = fixture({ config: ISOLATION_CONFIG, ignore: ['.aspira/'] })
    const wt = preexisting(main)
    const result = await run(main, 'KIT-13', feature(), false, mocks.seams)
    expect(result.code).toBe(1)
    expect(result.lines.some((line) => line.includes('.env.development.local') && /ignore/i.test(line))).toBe(true)
    expect(existsSync(join(wt, '.env.development.local'))).toBe(false)
    expect(isRegistered(main, wt)).toBe(true)
  })

  it('T24 isolates a newly created worktree in the same run, after the git worktree exists', async () => {
    const { main } = fixture(ISOLATED)
    const result = await run(main, 'KIT-13', feature(), false, mocks.seams)
    const wt = handlePath(main, 'FEATURE-KIT-13')
    expect(result.code).toBe(0)
    expect(mocks.state.branches.map((branch) => branch.name)).toContain('wt/kit-13')
    expect(existsSync(join(wt, '.env.development.local'))).toBe(true)
    expect(result.lines.slice(-2)).toEqual([wt, 'feat/kit-13-kit-qol-cleanup'])
  })
})
