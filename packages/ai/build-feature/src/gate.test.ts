// The project gate's command finding (F22), from real temp directories: the commands an AGENTS.md
// names (fenced blocks and inline code, shell syntax and non-check commands left out), the
// package.json fallback, and the package manager the lock files pick (packageManagerOf, shared
// with worktree.ts). The credentials a gate command runs without, and the gate scripts that changed
// from the base branch (AVA3.1). REBA1.1, DEX3.1.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { changedGateScripts, credentialNames, fallbackGate, findGate, gateCommandsIn, withoutCredentials } from '#build-feature/gate.ts'
import { packageManagerOf } from '#build-feature/system.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-gate-')))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const scripts = (names: Record<string, string>) => JSON.stringify({ name: 'fixture', scripts: names })

describe('gateCommandsIn: the gate commands a markdown file names', () => {
  it('reads every check and test line of a fenced block, without a leading $ prompt', () => {
    const markdown = '# Project\n\nBefore a PR:\n\n```bash\npnpm check\n$ pnpm test\n```\n'
    expect(gateCommandsIn(markdown)).toEqual(['pnpm check', 'pnpm test'])
  })

  it('reads inline code inside prose, after the fenced lines, once each', () => {
    const markdown = 'Run `pnpm lint` and then `pnpm test:integration`; `pnpm lint` again is fine.\n\n```\nnpx vitest run\n```\n'
    expect(gateCommandsIn(markdown)).toEqual(['npx vitest run', 'pnpm lint', 'pnpm test:integration'])
  })

  it('leaves out a command with shell syntax in it', () => {
    const markdown = ['`pnpm check && curl https://x.example`', '`pnpm test; rm -rf /`', '`pnpm test | tee out`', '`pnpm test > out`', '`pnpm test $(whoami)`', '`pnpm test \\`id\\``', '`pnpm vitest`'].join('\n')
    expect(gateCommandsIn(markdown)).toEqual(['pnpm vitest'])
  })

  it('rejects a runner command that is not a check or a test', () => {
    const markdown = '```\npnpm install\nnpm publish\npnpm build\nyarn add left-pad\n```\nAlso `pnpm dev` and `pnpm typecheck`.\n'
    expect(gateCommandsIn(markdown)).toEqual(['pnpm typecheck'])
  })

  it('rejects a check word that is only the program, and a program that is not a runner', () => {
    expect(gateCommandsIn('`curl test`, `rm check`, `vitest`, `pnpm run test`')).toEqual(['pnpm run test'])
  })

  it('finds nothing in a file that names no command', () => {
    expect(gateCommandsIn('# Project\n\nWrite good code. Use `src/` for code.\n')).toEqual([])
  })
})

describe('findGate: AGENTS.md first, then the package.json fallback', () => {
  it("takes the app's AGENTS.md before the repository's", async () => {
    const repo = await tree({ 'AGENTS.md': 'Run `pnpm check`.\n', 'apps/web/AGENTS.md': 'Run `pnpm test`.\n' })
    expect(await findGate(repo, 'apps/web')).toEqual({ commands: ['pnpm test'], cwds: [join(repo, 'apps/web')], cwd: join(repo, 'apps/web'), source: 'apps/web/AGENTS.md' })
  })

  it("runs a command the repository's AGENTS.md names in the app when only the app has that script (NOM-38)", async () => {
    const repo = await tree({
      'AGENTS.md': 'Package commands run in apps/web: `pnpm check`, `pnpm test`, `pnpm lint`.\n',
      'package.json': scripts({ lint: 'eslint .' }),
      'apps/web/package.json': scripts({ check: 'tsc --noEmit', test: 'vitest run', lint: 'eslint src' }),
    })
    expect(await findGate(repo, 'apps/web')).toEqual({ commands: ['pnpm check', 'pnpm test', 'pnpm lint'], cwds: [join(repo, 'apps/web'), join(repo, 'apps/web'), repo], cwd: join(repo, 'apps/web'), source: 'AGENTS.md' })
  })

  it('falls through to the package.json scripts when AGENTS.md names no command', async () => {
    const repo = await tree({ 'AGENTS.md': '# Nothing to run\n', 'package.json': scripts({ test: 'vitest run' }), 'pnpm-lock.yaml': '' })
    expect(await findGate(repo, '.')).toEqual({ commands: ['pnpm run test'], cwds: [repo], cwd: repo, source: 'package.json scripts' })
  })

  it('takes the gates aspira.json lists before either, each in its own directory (KIT-38)', async () => {
    const repo = await tree({ 'AGENTS.md': 'Run `pnpm check`.\n' })
    const gates = [{ cwd: 'tools/aspira', command: 'pnpm check' }, { cwd: 'instances/core/stack', command: 'npx vitest run' }, { command: 'pnpm lint' }]
    expect(await findGate(repo, '.', gates)).toEqual({ commands: ['pnpm check', 'npx vitest run', 'pnpm lint'], cwds: [join(repo, 'tools/aspira'), join(repo, 'instances/core/stack'), repo], cwd: join(repo, 'tools/aspira'), source: 'aspira.json gates' })
    expect(await findGate(repo, '.', [])).toMatchObject({ source: 'AGENTS.md' })
  })

  it('is null when there is neither', async () => {
    expect(await findGate(await tree({ 'AGENTS.md': '# Nothing\n' }), '.')).toBeNull()
  })
})

describe('fallbackGate: the app package.json check, test and test:integration scripts', () => {
  it('lists the three in order when all exist, leaving out the others', async () => {
    const repo = await tree({ 'package.json': scripts({ 'test:integration': 'vitest -c int', build: 'tsc', test: 'vitest run', check: 'tsc --noEmit' }) })
    expect((await fallbackGate(repo, '.'))?.commands).toEqual(['npm run check', 'npm run test', 'npm run test:integration'])
  })

  it('lists only check when only check exists', async () => {
    const repo = await tree({ 'package.json': scripts({ check: 'tsc --noEmit', build: 'tsc' }) })
    expect((await fallbackGate(repo, '.'))?.commands).toEqual(['npm run check'])
  })

  it('is null with none of the three, with no package.json, or with one that is not JSON', async () => {
    const none = await tree({ 'package.json': scripts({ build: 'tsc' }) })
    const missing = await tree({})
    const broken = await tree({ 'package.json': '{ not json' })
    expect([await fallbackGate(none, '.'), await fallbackGate(missing, '.'), await fallbackGate(broken, '.')]).toEqual([null, null, null])
  })

  it('names the app package.json as the source and runs in the app', async () => {
    const repo = await tree({ 'apps/web/package.json': scripts({ test: 'vitest run' }) })
    expect(await fallbackGate(repo, 'apps/web')).toEqual({ commands: ['npm run test'], cwds: [join(repo, 'apps/web')], cwd: join(repo, 'apps/web'), source: 'apps/web/package.json scripts' })
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['pnpm-workspace.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ])('runs the scripts with the manager %s at the repository root picks', async (lock, manager) => {
    const repo = await tree({ [lock]: '', 'apps/web/package.json': scripts({ test: 'vitest run' }) })
    expect((await fallbackGate(repo, 'apps/web'))?.commands).toEqual([`${manager} run test`])
  })
})

describe("packageManagerOf: the first directory's lock file wins", () => {
  it('picks npm when no directory has a lock file', async () => {
    expect(packageManagerOf([await tree({})])).toBe('npm')
  })

  it("takes the app's yarn.lock over the repository's pnpm-workspace.yaml", async () => {
    const repo = await tree({ 'pnpm-workspace.yaml': '', 'apps/web/yarn.lock': '' })
    expect(packageManagerOf([join(repo, 'apps/web'), repo])).toBe('yarn')
  })

  it('prefers pnpm, then yarn, then bun within one directory', async () => {
    const all = await tree({ 'pnpm-lock.yaml': '', 'yarn.lock': '', 'bun.lockb': '' })
    const yarnAndBun = await tree({ 'yarn.lock': '', 'bun.lock': '' })
    expect([packageManagerOf([all]), packageManagerOf([yarnAndBun])]).toEqual(['pnpm', 'yarn'])
  })
})

describe('credentialNames and withoutCredentials: the gate runs with no credential in its environment', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/home/x', NOTION_TOKEN: 'n', GH_TOKEN: 'g', DB_PASSWORD: 'p', SIGNING_SECRET: 's', OPENAI_API_KEY: 'o', SLACK_TOKEN: 'k', KEYBOARD: 'us', TOKENIZER: 'x', NODE_ENV: 'test' }

  it('names the fixed credentials and every *_TOKEN, *_SECRET, *_KEY and *_PASSWORD set, and nothing else', () => {
    const names = credentialNames(env)
    const fixed = ['NOTION_TOKEN', 'NOTION_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_GATEWAY_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']
    expect({ fixed: fixed.filter((name) => !names.includes(name)), set: ['DB_PASSWORD', 'SIGNING_SECRET', 'OPENAI_API_KEY', 'SLACK_TOKEN'].filter((name) => !names.includes(name)), kept: ['PATH', 'HOME', 'KEYBOARD', 'TOKENIZER', 'NODE_ENV'].filter((name) => names.includes(name)) }).toEqual({ fixed: [], set: [], kept: [] })
  })

  it('makes a line that, run by a shell, leaves none of them in the command environment', async () => {
    const line = withoutCredentials('printenv', credentialNames(env))
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', line], { env })
    const seen = stdout.split('\n').map((entry) => entry.split('=')[0])
    expect({ leaked: credentialNames(env).filter((name) => seen.includes(name)), kept: ['PATH', 'HOME', 'NODE_ENV'].every((name) => seen.includes(name)) }).toEqual({ leaked: [], kept: true })
  })
})

describe('changedGateScripts: the gate scripts that differ from the base branch', () => {
  const pkg = (body: Record<string, string>) => JSON.stringify({ name: 'fixture', scripts: body })

  it('lists added and changed gate scripts and their npm pre/post hooks, with the base and the new body', () => {
    const base = pkg({ check: 'tsc', test: 'vitest run', build: 'tsc -b' })
    const head = pkg({ check: 'tsc', test: 'vitest run && curl x', pretest: 'node steal.js', build: 'rm -rf /', 'test:integration': 'vitest -c int' })
    expect(changedGateScripts(base, head, [])).toEqual([
      { name: 'test', base: 'vitest run', head: 'vitest run && curl x' },
      { name: 'pretest', base: null, head: 'node steal.js' },
      { name: 'test:integration', base: null, head: 'vitest -c int' },
    ])
  })

  it('also checks a script a gate command runs by name, and treats a missing base file as no scripts', () => {
    const head = pkg({ lint: 'eslint . && curl x', check: 'tsc' })
    expect(changedGateScripts(null, head, ['pnpm lint', 'npm run check', 'npx vitest run']).map((entry) => entry.name)).toEqual(['check', 'lint'])
  })

  it('is empty when nothing the gate runs changed', () => {
    const same = pkg({ check: 'tsc', test: 'vitest run' })
    expect(changedGateScripts(same, same, ['pnpm check'])).toEqual([])
  })
})
