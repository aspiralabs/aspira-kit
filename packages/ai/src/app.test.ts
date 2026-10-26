// A multi-app repository (nomnomzz): the Next app with package.json and node_modules is apps/web,
// there is no root package.json, and Claude Code runs at the root. `kit init --app apps/web` at the
// root puts the package steps in the app and the Claude-facing files at the root, with every path
// inside them pointing into the app; doctor, next and the launchers read the app from aspira.json.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { checkAspira, normalizeApp, readApp, resolveProjectRoot, writeAspira } from './aspira.js'
import { doctor } from './doctor.js'
import { hasJsonComments, readJson } from './fs.js'
import { liveResolver, next, type Resolver } from './next.js'
import { AGENTS, harnessCurrent, KIT_SKILLS, writeGlobalHarness } from './skills.js'
import { initNext } from './stacks/next.js'
import { upgrade } from './upgrade.js'

// The kit runs only as the global @aspiralabs/ai: a test points aiPackageDir() at a fake package to run its resolve script.
const fakeAi = vi.hoisted(() => ({ dir: undefined as string | undefined }))
vi.mock('./skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skills.js')>()
  return { ...actual, aiPackageDir: () => fakeAi.dir ?? actual.aiPackageDir() }
})

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const VERSION = '0.9.0'

type Settings = { hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]> }
type Mcp = { mcpServers: Record<string, { command: string; args: string[] }> }

/** Runs git in `dir`, as the kit and a human would. */
const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

/** The .gitignore kit init leaves at a project root that is also the git root and held only node_modules: the .env.local pair, and none of the harness lines. */
const WIRED_GITIGNORE = [
  'node_modules',
  '',
  '# local secrets such as NOTION_TOKEN; kit worktree links them into each ticket worktree',
  '.env.local',
  '',
].join('\n')

/** The .gitignore an earlier kit left: the .work/, .aspira/ and .worktrees/ lines with their comments, then the .env.local pair. */
const EARLIER_GITIGNORE = [
  'node_modules',
  '',
  '# per-ticket working folders (pulled from the Notion ticket, never committed)',
  '.work/',
  "# the audit log the kit's hooks write (.aspira/audit.jsonl)",
  '.aspira/',
  '# per-ticket git worktrees (kit worktree <ID> makes .worktrees/<TYPE>-<ID>)',
  '.worktrees/',
  '# local secrets such as NOTION_TOKEN; kit worktree links them into each ticket worktree',
  '.env.local',
  '',
].join('\n')

/** A temp home with a current global harness, written by the kit's own writer: what kit init and kit doctor now expect to find. */
function harnessHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kit-home-')))
  writeGlobalHarness({ home })
  return home
}

/** The environment a child git needs so nothing reads or commits with the developer's own configuration. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'kit', GIT_AUTHOR_EMAIL: 'kit@example.com', GIT_COMMITTER_NAME: 'kit', GIT_COMMITTER_EMAIL: 'kit@example.com' }

const logs = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

/** A repository with no root package.json whose Next app is apps/web, with ui and config installed there the way pnpm lays them out
 * (@aspiralabs/ai is the global install: the running package); at `base` when given, else in a new temporary folder. */
function repository(base?: string): { root: string; app: string } {
  const root = base ?? realpathSync(mkdtempSync(join(tmpdir(), 'kit-app-')))
  const app = join(root, 'apps', 'web')
  mkdirSync(join(app, 'app'), { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'web', private: true, dependencies: { '@aspiralabs/ui': VERSION }, devDependencies: { '@aspiralabs/config': VERSION } }))
  writeFileSync(join(app, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
  writeFileSync(join(app, 'app', 'globals.css'), '@import "tailwindcss";\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  writeFileSync(join(root, 'AGENTS.md'), '# nomnomzz\n\n## About this project\n\nRecipes.\n')
  const scope = join(app, 'node_modules', '@aspiralabs')
  const pkg = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true })
    // The agents are ES modules run straight from TypeScript source; "type" is what lets amaro's hook see them as such.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version: VERSION, type: 'module' }))
  }
  for (const name of ['ui', 'config']) pkg(join(scope, name), name)
  mkdirSync(join(scope, 'ui', 'bin'), { recursive: true })
  writeFileSync(join(scope, 'ui', 'bin', 'mcp.js'), '#!/usr/bin/env node\n')
  return { root, app }
}

/** What the pnpm stub of the last init() call was asked to run, one argument line each. */
let pnpmCalls: string[] = []

/** Runs init with the install step answered by a pnpm stub (the packages are already laid out), under a temp home so no global git config is read. */
async function init(root: string, extra: { app?: string; board?: string; dryRun?: boolean } = {}): Promise<string[]> {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'kit-stub-bin-')))
  const callsFile = join(bin, 'calls.txt')
  writeFileSync(join(bin, 'pnpm'), `#!/bin/bash\necho "$@" >> '${callsFile}'\ncase $1 in add|remove) exit 0 ;; esac\nexit 1\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  const { lines, log } = logs()
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG: process.env.XDG_CONFIG_HOME, NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kit-init-home-')))
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  delete process.env.XDG_CONFIG_HOME
  try {
    await initNext({ projectRoot: root, dryRun: extra.dryRun ?? false, log, ...(extra.app === undefined ? {} : { app: extra.app }), ...(extra.board === undefined ? {} : { board: extra.board }) })
  } finally {
    const restore = (key: string, value: string | undefined) => (value === undefined ? delete process.env[key] : (process.env[key] = value))
    restore('PATH', saved.PATH)
    restore('HOME', saved.HOME)
    restore('USERPROFILE', saved.USERPROFILE)
    restore('XDG_CONFIG_HOME', saved.XDG)
    restore('GIT_CONFIG_NOSYSTEM', saved.NOSYSTEM)
  }
  pnpmCalls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter((line) => line !== '') : []
  return lines
}

describe('kit init --stack next install lines and no harness, with @aspiralabs/ai global (T7, T9, T17)', () => {
  type Groups = Array<{ hooks: Array<{ command: string }> }>
  const commands = (groups: Groups | undefined) => (groups ?? []).map((g) => g.hooks.map((h) => h.command))
  // A token and a Notion check that passes, so the hooks are the only thing that can fail doctor.
  const notion = { env: { NOTION_TOKEN: 'ntn_test' }, check: (checks: { key: string }[]) => Object.fromEntries(checks.map(({ key }) => [key, { ok: true as const }])) }
  /** A single-app project: the app's files moved up to the root. */
  function singleApp(): string {
    const { root, app } = repository()
    cpSync(app, root, { recursive: true })
    return root
  }

  it('T17: installs ui and config but not the kit, wires the project files, and writes no skills, hooks, kit hook command, managed block or harness ignore line', async () => {
    for (const [root, app] of [[singleApp(), undefined], [repository().root, 'apps/web']] as const) {
      rmSync(join(root, 'AGENTS.md'), { force: true })
      expect(git(root, 'init', '-q').status).toBe(0)
      await init(root, { ...(app === undefined ? {} : { app }), board: BOARD })
      const installs = pnpmCalls.join('\n')
      expect(installs, 'ui').toContain('@aspiralabs/ui')
      expect(installs, 'config').toContain('@aspiralabs/config')
      expect(installs, 'ai').not.toContain('@aspiralabs/ai')
      const appDir = app === undefined ? root : join(root, app)
      for (const file of ['eslint.config.mjs', 'prettier.config.mjs', 'tsconfig.json']) expect(existsSync(join(appDir, file)), file).toBe(true)
      expect(readFileSync(join(appDir, 'app', 'globals.css'), 'utf8')).toContain('@aspiralabs/ui/tokens.css')
      expect((JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as Mcp).mcpServers['aspiralabs-ui']).toBeDefined()
      expect(existsSync(join(root, 'aspira.json'))).toBe(true)
      const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
      expect(agents).toContain('## About this project')
      expect(agents).toContain('## Gotchas')
      expect(agents).not.toContain('aspiralabs:begin')
      expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
      expect(existsSync(join(root, '.claude', 'skills'))).toBe(false)
      expect(existsSync(join(root, '.claude', 'hooks'))).toBe(false)
      const settingsPath = join(root, '.claude', 'settings.json')
      if (existsSync(settingsPath)) expect(readFileSync(settingsPath, 'utf8')).not.toMatch(/hooks\/aspira|session-start|deny-tier3|audit-log/)
      const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n')
      expect(ignore).toContain('.env.local')
      for (const line of ['.work/', '.aspira/', '.worktrees/']) expect(ignore, line).not.toContain(line)
    }
  })

  it('T18: leaves a hand-written AGENTS.md and CLAUDE.md byte for byte as they were', async () => {
    const root = singleApp()
    writeFileSync(join(root, 'AGENTS.md'), '# mine\n\nHand-written rules.\n\n## Gotchas\n\nNone.\n')
    writeFileSync(join(root, 'CLAUDE.md'), 'Read AGENTS.md, then ask.\n')
    const before = { agents: readFileSync(join(root, 'AGENTS.md')), claude: readFileSync(join(root, 'CLAUDE.md')) }
    await init(root, { board: BOARD })
    expect(readFileSync(join(root, 'AGENTS.md')).equals(before.agents)).toBe(true)
    expect(readFileSync(join(root, 'CLAUDE.md')).equals(before.claude)).toBe(true)
  })

  it('removes the @aspiralabs/ai an earlier kit declared, in the app and at a workspace root, before installing', async () => {
    const single = singleApp()
    const pkg = JSON.parse(readFileSync(join(single, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    writeFileSync(join(single, 'package.json'), JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, '@aspiralabs/ai': VERSION } }))
    const lines = (await init(single, { board: BOARD, dryRun: true })).filter((l) => l.startsWith('run '))
    expect(lines[0]).toBe('run    pnpm remove @aspiralabs/ai')
    expect(lines.slice(1).some((l) => l.includes('@aspiralabs/ai'))).toBe(false)
    const { root } = workspace()
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...rootPkg, devDependencies: { ...rootPkg.devDependencies, '@aspiralabs/ai': VERSION } }))
    const workspaceRuns = (await init(root, { app: 'apps/web', board: BOARD, dryRun: true })).filter((l) => l.startsWith('run '))
    expect(workspaceRuns).toContain('run    pnpm remove -w @aspiralabs/ai (in the workspace root)')
    expect(workspaceRuns.filter((l) => l.includes('add') && l.includes('@aspiralabs/ai'))).toEqual([])
  })

  it('removes the kit hook commands an earlier kit wrote, from .claude/ and from node_modules, keeps the project hook, and a re-run changes nothing', async () => {
    for (const app of [undefined, 'apps/web'] as const) {
      const root = app === undefined ? singleApp() : repository().root
      const prefix = app === undefined ? '' : 'apps/web/'
      mkdirSync(join(root, '.claude'), { recursive: true })
      const group = (command: string) => ({ matcher: '', hooks: [{ command }] })
      writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          SessionStart: [group(`sh ${prefix}node_modules/@aspiralabs/ai/hooks/session-start.sh`), group('echo mine')],
          PreToolUse: [group('sh .claude/hooks/aspira/deny-tier3.sh'), group('sh .claude/hooks/aspira/audit-log.sh')],
        },
      }))
      await init(root, { ...(app === undefined ? {} : { app }), board: BOARD })
      const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings
      const all = Object.values(settings.hooks).flatMap((groups) => commands(groups).flat())
      expect(all).toEqual(['echo mine'])
      const first = readFileSync(join(root, '.claude', 'settings.json'), 'utf8')
      await init(root, { ...(app === undefined ? {} : { app }) })
      expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe(first)
    }
  })

  it("doctor passes after init against a current global harness and never asks for a project .claude/settings.json or skills folder", async () => {
    const root = singleApp()
    expect(git(root, 'init', '-q').status).toBe(0)
    await init(root, { board: BOARD })
    const { lines, log } = logs()
    expect(doctor(root, log, undefined, { ...notion, home: harnessHome() })).toBe(0)
    expect(lines.filter((l) => /^(ok {2}|FAIL|skip) \.claude\/(settings\.json|skills)/.test(l))).toEqual([])
    expect(lines.some((l) => l.startsWith('ok   ') && l.includes('~/.claude/skills/aspira-planner'))).toBe(true)
  })

  it('a dry run prints the app install lines for ui and config, never @aspiralabs/ai or the retired packages', async () => {
    for (const make of [singleApp, () => workspace().root]) {
      const root = make()
      const lines = await init(root, { ...(make === singleApp ? {} : { app: 'apps/web' }), board: BOARD, dryRun: true })
      const version = (JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')) as { version: string }).version
      const runs = lines.filter((l) => l.startsWith('run '))
      expect(runs.some((l) => l.startsWith(`run    pnpm add @aspiralabs/ui@${version}`))).toBe(true)
      expect(runs.some((l) => l.startsWith(`run    pnpm add -D @aspiralabs/config@${version} eslint prettier typescript`))).toBe(true)
      expect(runs.filter((l) => l.includes('@aspiralabs/kit') || l.includes('@aspiralabs/agents') || l.includes('@aspiralabs/ai'))).toEqual([])
    }
  })
})

describe('kit init --stack next --app apps/web at the repository root', () => {
  it('writes the package files in the app and the Claude-facing files at the root, with paths pointing into the app', async () => {
    const { root, app } = repository()
    expect(git(root, 'init', '-q').status).toBe(0)
    const lines = await init(root, { app: 'apps/web', board: BOARD })
    expect(lines[0]).toBe(`stack  next (${root}; app apps/web)`)
    // Package-level: in apps/web, nothing of it at the root.
    for (const file of ['.npmrc', 'eslint.config.mjs', 'prettier.config.mjs']) {
      expect(existsSync(join(app, file)), file).toBe(true)
      expect(existsSync(join(root, file)), file).toBe(false)
    }
    expect(JSON.parse(readFileSync(join(app, 'tsconfig.json'), 'utf8'))).toMatchObject({ extends: '@aspiralabs/config/tsconfig/next.json', compilerOptions: { strict: true, paths: { '@/*': ['./*'] } } })
    expect(readFileSync(join(app, 'app', 'globals.css'), 'utf8')).toContain('@import "@aspiralabs/ui/tokens.css";\n@source "../node_modules/@aspiralabs/ui/dist";')
    expect(lines).toContain('run    pnpm add @aspiralabs/ui@' + (JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')) as { version: string }).version)
    // Claude-facing: at the root, nothing of it in the app; no harness at either place.
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.mcp.json', 'aspira.json']) {
      expect(existsSync(join(root, file)), file).toBe(true)
      expect(existsSync(join(app, file)), file).toBe(false)
    }
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# nomnomzz\n\n## About this project\n\nRecipes.\n')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as Mcp
    expect(mcp.mcpServers['aspiralabs-ui']).toEqual({ command: 'node', args: ['apps/web/node_modules/@aspiralabs/ui/bin/mcp.js'] })
    expect(existsSync(join(root, mcp.mcpServers['aspiralabs-ui']!.args[0]!))).toBe(true)
    for (const dir of [root, app]) expect(existsSync(join(dir, '.claude', 'skills')) || existsSync(join(dir, '.claude', 'hooks')), dir).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD, app: 'apps/web' })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(WIRED_GITIGNORE)
    expect(existsSync(join(app, '.gitignore'))).toBe(false)
  })

  it('is idempotent: a re-run keeps every file, and also when the app moves, takes only the kit hook entries out of a project settings.json', async () => {
    const { root } = repository()
    expect(git(root, 'init', '-q').status).toBe(0)
    await init(root, { app: 'apps/web', board: BOARD })
    const before = { mcp: readFileSync(join(root, '.mcp.json'), 'utf8'), gitignore: readFileSync(join(root, '.gitignore'), 'utf8'), agents: readFileSync(join(root, 'AGENTS.md'), 'utf8') }
    const again = await init(root, { app: 'apps/web', board: BOARD })
    expect(again.filter((l) => l.startsWith('write ')).length).toBe(0)
    expect(again).toContain(`keep   ${join(root, 'aspira.json')} (board already set)`)
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(before.mcp)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(before.gitignore)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(before.agents)
    // A project wired earlier (kit hooks in settings.json) and a server of its own: the kit's entries go, the project's stay.
    const settingsPath = join(root, '.claude', 'settings.json')
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'sh node_modules/@aspiralabs/ai/hooks/session-start.sh' }] }, { matcher: 'startup', hooks: [{ command: 'echo mine' }] }] } }))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': { command: 'npx', args: ['--no', 'aspiralabs-ui-mcp'] }, notion: { command: 'npx', args: ['notion-mcp'] } } }))
    await init(root, { app: 'apps/web' })
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings & { permissions?: unknown }
    expect(merged.permissions).toEqual({ allow: ['Bash(pnpm test)'] })
    expect(merged.hooks.SessionStart!.map((g) => g.hooks.map((h) => h.command))).toEqual([['echo mine']])
    expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { notion: { command: 'npx', args: ['notion-mcp'] }, 'aspiralabs-ui': { command: 'node', args: ['apps/web/node_modules/@aspiralabs/ui/bin/mcp.js'] } } })
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD, app: 'apps/web' })
  })

  it('refuses an app with no package.json, an absolute or outside path, and changes nothing in a dry run', async () => {
    const { root, app } = repository()
    await expect(init(root, { app: 'apps/mobile' })).rejects.toThrow('--app apps/mobile: no package.json')
    await expect(init(root, { app: '../elsewhere' })).rejects.toThrow('inside the project')
    await expect(init(root, { app: app })).rejects.toThrow('inside the project')
    const lines = await init(root, { app: 'apps/web/', board: BOARD, dryRun: true })
    expect(lines.some((l) => l.includes('aspira.json') && l.includes('app apps/web'))).toBe(true)
    for (const file of ['AGENTS.md']) expect(readFileSync(join(root, file), 'utf8')).not.toContain('aspiralabs:begin')
    for (const file of ['CLAUDE.md', '.mcp.json', '.claude', 'aspira.json']) expect(existsSync(join(root, file))).toBe(false)
    expect(existsSync(join(app, 'eslint.config.mjs'))).toBe(false)
    expect(normalizeApp('apps/web/')).toBe('apps/web')
    expect(normalizeApp('./apps//web')).toBe('apps/web')
    expect(normalizeApp('.')).toBe('.')
  })

  it('leaves a single-app project exactly as before: no --app, every path at the root', async () => {
    const { root, app } = repository()
    // The app is the root: move the app's files up.
    cpSync(app, root, { recursive: true })
    const lines = await init(root, { board: BOARD })
    expect(lines[0]).toBe(`stack  next (${root})`)
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(true)
    expect((JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as Mcp).mcpServers['aspiralabs-ui']).toEqual({ command: 'npx', args: ['--no', 'aspiralabs-ui-mcp'] })
    expect(existsSync(join(root, '.claude'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD })
    expect(readApp(root)).toBeUndefined()
    expect(doctor(root, () => {}, undefined, { home: harnessHome() })).toBe(0)
  })

  it('writes app to aspira.json without a board, and doctor then only wants the board', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-aspira-app-')))
    mkdirSync(join(root, 'apps', 'web'), { recursive: true })
    writeFileSync(join(root, 'apps', 'web', 'package.json'), '{}')
    const { lines, log } = logs()
    writeAspira({ projectRoot: root, app: 'apps/web', dryRun: false, log })
    expect(lines[0]).toBe(`write  ${join(root, 'aspira.json')} (app apps/web; no --board given, the project has no Feature Board until it is)`)
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ app: 'apps/web' })
    expect(checkAspira(root).reason).toContain('has no "board"')
    writeAspira({ projectRoot: root, board: BOARD, dryRun: false, log })
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ app: 'apps/web', board: BOARD })
    expect(checkAspira(root)).toEqual({ ok: true })
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/mobile' }))
    expect(checkAspira(root).reason).toBe('aspira.json "app" is apps/mobile, but apps/mobile/package.json does not exist')
  })
})

/** The repository above as a pnpm workspace (hangar): the root has its own package.json, lockfile, .npmrc and prettier config, and declares the kit config itself. */
function workspace(): { root: string; app: string } {
  const { root, app } = repository()
  rmSync(join(app, 'pnpm-lock.yaml'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hangar', private: true, devDependencies: { '@aspiralabs/config': '^0.4.2', prettier: '^3' } }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, '.npmrc'), '@aspiralabs:registry=https://npm.pkg.github.com\n')
  writeFileSync(join(root, 'prettier.config.mjs'), "export { default } from '@aspiralabs/config/prettier'\n")
  // A tsconfig with comments and a trailing comma, as Next and editors write them, already on the kit.
  writeFileSync(join(app, 'tsconfig.json'), '{\n  "extends": "@aspiralabs/config/tsconfig/next.json",\n  "compilerOptions": {\n    // Next requires react-jsx.\n    "jsx": "react-jsx", /* "a // string" */\n    "paths": { "@/*": ["./*"] },\n  },\n}\n')
  return { root, app }
}

describe('kit init and kit doctor: the .env.local ignore line, and no .work/, .aspira/ or .worktrees/ lines', () => {
  it('writes .env.local once and none of the harness lines, and a rerun leaves the .gitignore as it was', async () => {
    const { root } = repository()
    expect(git(root, 'init', '-q').status).toBe(0)
    await init(root, { app: 'apps/web', board: BOARD })
    const first = readFileSync(join(root, '.gitignore'), 'utf8')
    await init(root, { app: 'apps/web', board: BOARD })
    expect({ first, second: readFileSync(join(root, '.gitignore'), 'utf8') }).toEqual({ first: WIRED_GITIGNORE, second: WIRED_GITIGNORE })
  })

  it('adds no .env.local line when a glob such as .env*.local already ignores it', async () => {
    const { root } = repository()
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.env*.local\n')
    expect(git(root, 'init', '-q').status).toBe(0)
    await init(root, { app: 'apps/web', board: BOARD })
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n')
    expect({ hasLine: lines.includes('.env.local'), ignored: git(root, 'check-ignore', '-q', '--no-index', '.env.local').status }).toEqual({ hasLine: false, ignored: 0 })
  })

  it("writes no .worktrees/ line into the git root's .gitignore when the project sits below it", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-git-root-')))
    expect(git(repo, 'init', '-q').status).toBe(0)
    const product = join(repo, 'product')
    repository(product)
    writeFileSync(join(product, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    await init(product, { app: 'apps/web', board: BOARD })
    const rootIgnore = existsSync(join(repo, '.gitignore')) ? readFileSync(join(repo, '.gitignore'), 'utf8').split('\n') : []
    expect(rootIgnore).not.toContain('.worktrees/')
    expect(readFileSync(join(product, '.gitignore'), 'utf8').split('\n')).not.toContain('.worktrees/')
  })

  it('doctor fails on a missing .env.local ignore line in a git repository, passes after an init rerun, and skips the check outside one', async () => {
    const { root } = repository()
    expect(git(root, 'init', '-q').status).toBe(0)
    await init(root, { app: 'apps/web', board: BOARD })
    writeFileSync(join(root, '.gitignore'), 'node_modules\n')
    // A token and a Notion check that passes, so the ignore line is the only FAIL line: KIT-2's
    // NOTION_TOKEN line names the .env.local files too, and must not depend on the machine's env.
    const home = harnessHome()
    const notion = { home, env: { NOTION_TOKEN: 'ntn_test' }, check: (checks: { key: string }[]) => Object.fromEntries(checks.map(({ key }) => [key, { ok: true as const }])) }
    const before = logs()
    const beforeCode = doctor(root, before.log, undefined, notion)
    const problems = before.lines.filter((line) => line.startsWith('FAIL'))
    expect({ code: beforeCode, count: problems.length, envLocal: problems.filter((line) => line.includes('.env.local')).length }).toEqual({ code: 1, count: 1, envLocal: 1 })
    await init(root, { app: 'apps/web', board: BOARD })
    expect(doctor(root, () => {}, undefined, notion)).toBe(0)
    // The same project outside any git repository: the check says skipped and counts as no problem.
    const { root: plain } = repository()
    await init(plain, { app: 'apps/web', board: BOARD })
    writeFileSync(join(plain, '.gitignore'), 'node_modules\n')
    const outside = logs()
    const outsideCode = doctor(plain, outside.log, undefined, notion)
    const ignoreLines = outside.lines.filter((line) => line.includes('.env.local'))
    expect({ code: outsideCode, envLocal: ignoreLines.length > 0, allSkipped: ignoreLines.every((line) => line.includes('skipped') && !line.startsWith('FAIL')) }).toEqual({ code: 0, envLocal: true, allSkipped: true })
  })

  it('T27 case A: a database entry in aspira.json adds a .env.development.local line that git then honours for the app file, once', async () => {
    const { root } = repository()
    expect(git(root, 'init', '-q').status).toBe(0)
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web', database: { provider: 'neon', projectId: 'proj-1', parentBranch: 'dev', envVars: ['DATABASE_URL'] } }))
    await init(root, { app: 'apps/web', board: BOARD })
    const first = readFileSync(join(root, '.gitignore'), 'utf8')
    expect(first.split('\n')).toContain('.env.development.local')
    expect(first.split('\n')).toContain('.env.local')
    expect(git(root, 'check-ignore', '-q', '--no-index', 'apps/web/.env.development.local').status).toBe(0)
    await init(root, { app: 'apps/web', board: BOARD })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(first)
  })

  it('T27 case A: webhooks, or a placeholder dev.url, ask for the same line', async () => {
    for (const keys of [{ webhooks: [{ provider: 'stripe', path: '/api/webhooks/stripe' }] }, { dev: { command: 'next dev', url: 'http://{name}.localhost:{port}' } }]) {
      const { root } = repository()
      expect(git(root, 'init', '-q').status).toBe(0)
      writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web', ...keys }))
      await init(root, { app: 'apps/web', board: BOARD })
      expect(readFileSync(join(root, '.gitignore'), 'utf8').split('\n')).toContain('.env.development.local')
    }
  })

  it('T27 adds no .env.development.local line when a glob such as .env*.local already ignores it', async () => {
    const { root } = repository()
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.env*.local\n')
    expect(git(root, 'init', '-q').status).toBe(0)
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web', database: { provider: 'neon', projectId: 'proj-1', parentBranch: 'dev', envVars: ['DATABASE_URL'] } }))
    await init(root, { app: 'apps/web', board: BOARD })
    expect(readFileSync(join(root, '.gitignore'), 'utf8').split('\n')).not.toContain('.env.development.local')
    expect(git(root, 'check-ignore', '-q', '--no-index', 'apps/web/.env.development.local').status).toBe(0)
  })

  it('T27 case B: with no database, webhooks or placeholder dev.url the .gitignore equals today\'s', async () => {
    const { root } = repository()
    expect(git(root, 'init', '-q').status).toBe(0)
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web', dev: { command: 'next dev', url: 'http://localhost:3000' } }))
    await init(root, { app: 'apps/web', board: BOARD })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(WIRED_GITIGNORE)
  })

  it("this repository's own .gitignore ignores .worktrees/ and .env.local", () => {
    const top = git(kit, 'rev-parse', '--show-toplevel').stdout.trim()
    const committed = readFileSync(join(top, '.gitignore'), 'utf8')
    // Only the .gitignore counts: a fresh repository leaves .git/info/exclude (shared by every worktree here) behind.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kit-own-ignore-')))
    expect(git(scratch, 'init', '-q').status).toBe(0)
    writeFileSync(join(scratch, '.gitignore'), committed)
    expect({
      worktrees: git(scratch, 'check-ignore', '-q', '--no-index', '.worktrees/FEATURE-KIT-1').status,
      envLocal: git(scratch, 'check-ignore', '-q', '--no-index', '.env.local').status,
      exactLine: committed.split('\n').includes('.worktrees/'),
    }).toEqual({ worktrees: 0, envLocal: 0, exactLine: true })
  })
})

describe('kit init --stack next --app apps/web in a workspace whose root has its own package.json', () => {
  it('uses the root .npmrc and prettier config, keeps the commented tsconfig, and keeps the root kit packages on the app version', async () => {
    const { root, app } = workspace()
    const tsconfig = readFileSync(join(app, 'tsconfig.json'), 'utf8')
    const lines = await init(root, { app: 'apps/web', board: BOARD })
    const version = (JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')) as { version: string }).version
    expect(lines[0]).toBe(`stack  next (${root}; app apps/web in the workspace)`)
    expect(lines).toContain(`keep   ${join(root, '.npmrc')} (scope already mapped)`)
    expect(lines).toContain(`keep   ${join(root, 'prettier.config.mjs')} (the workspace root's prettier config covers apps/web)`)
    expect(lines).toContain(`keep   ${join(app, 'tsconfig.json')} (already extends the kit)`)
    for (const file of ['.npmrc', 'prettier.config.mjs']) expect(existsSync(join(app, file)), file).toBe(false)
    expect(readFileSync(join(app, 'tsconfig.json'), 'utf8')).toBe(tsconfig)
    expect(lines).toContain(`run    pnpm add @aspiralabs/ui@${version} (in apps/web)`)
    expect(lines).toContain(`run    pnpm add -w -D @aspiralabs/config@${version} (in the workspace root)`)
    // The Claude-facing files are where they are for any app.
    expect((JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as Mcp).mcpServers['aspiralabs-ui']).toEqual({ command: 'node', args: ['apps/web/node_modules/@aspiralabs/ui/bin/mcp.js'] })
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD, app: 'apps/web' })
  })

  it('maps the scope in the root .npmrc when it is missing, and leaves an app prettier config to the app', async () => {
    const { root, app } = workspace()
    rmSync(join(root, '.npmrc'))
    writeFileSync(join(app, '.prettierrc'), '{}\n')
    const lines = await init(root, { app: 'apps/web', dryRun: true })
    expect(lines).toContain(`write  ${join(root, '.npmrc')}`)
    expect(lines).toContain(`write  ${join(app, 'prettier.config.mjs')}`)
    expect(lines.some((l) => l.includes("workspace root's prettier config"))).toBe(false)
  })

  it('treats a root package.json that is not a workspace like no root package.json', async () => {
    const { root, app } = repository()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scripts-only', private: true }))
    const lines = await init(root, { app: 'apps/web', dryRun: true })
    expect(lines[0]).toBe(`stack  next (${root}; app apps/web)`)
    expect(lines).toContain(`write  ${join(app, '.npmrc')}`)
    expect(lines.some((l) => l.includes(' -w '))).toBe(false)
  })

  it('doctor flags a root kit package on another version than the app', async () => {
    const { root } = workspace()
    await init(root, { app: 'apps/web', board: BOARD })
    const { lines, log } = logs()
    const home = harnessHome()
    doctor(root, log, undefined, { home })
    expect(lines).toContain(`FAIL workspace root declares @aspiralabs/config ^0.4.2, the app ${VERSION}`)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hangar', private: true, devDependencies: { '@aspiralabs/config': VERSION } }))
    const again = logs()
    doctor(root, again.log, undefined, { home })
    expect(again.lines).toContain(`ok   workspace root declares @aspiralabs/config ${VERSION}, as the app does`)
    expect(again.lines).toContain('ok   apps/web/tsconfig.json extends the kit')
  })
})

// ---- kit init removes the harness an earlier kit committed (KIT-71, F15) ----

const KIT_HOOKS = ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh']
const THIRTEEN_SKILLS = [...AGENTS, ...KIT_SKILLS]
const BEGIN_MARKER = '<!-- aspiralabs:begin (managed by @aspiralabs/ai; do not edit inside this block) -->'
const END_MARKER = '<!-- aspiralabs:end -->'
const AGENTS_BEFORE = '# nomnomzz\n\nHand-written intro.\n\n'
const AGENTS_AFTER = '\n\n## About this project\n\nRecipes.\n\n## Gotchas\n\nNone.\n'
const EARLIER_AGENTS = `${AGENTS_BEFORE}${BEGIN_MARKER}\nThis project is on the Aspira Labs kit.\n\n- **Agents:** the /aspira-* skills in .claude/skills/.\n${END_MARKER}${AGENTS_AFTER}`

type HookGroup = { matcher: string; hooks: { type: string; command: string }[] }
const hookGroup = (...commands: string[]): HookGroup => ({ matcher: 'Bash|Edit|Write', hooks: commands.map((command) => ({ type: 'command', command })) })
const KIT_SESSION = hookGroup('sh .claude/hooks/aspira/session-start.sh')
const KIT_PRE = ['sh .claude/hooks/aspira/deny-tier3.sh', 'sh .claude/hooks/aspira/audit-log.sh']

/**
 * An earlier kit's project, laid out by hand and committed once: the thirteen skill folders (each with .kit-version), the retired
 * aspira-spec-reviewer, a skill of the engineer's own, the three hooks, settings.json, the managed block and the wired .gitignore,
 * and with `aspira`, a committed aspira.json.
 */
function earlierKit(options: { mixedSettings?: boolean; commentAbove?: string; aspira?: boolean } = {}): { root: string } {
  const { root } = repository()
  if (options.aspira === true) writeFileSync(join(root, 'aspira.json'), `${JSON.stringify({ board: BOARD, app: 'apps/web' }, null, 2)}\n`)
  const mixed = options.mixedSettings ?? true
  for (const name of [...THIRTEEN_SKILLS, 'spec-reviewer']) {
    const dir = join(root, '.claude', 'skills', `aspira-${name}`)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`)
    writeFileSync(join(dir, 'scripts', `${name}.sh`), '#!/bin/sh\n')
    writeFileSync(join(dir, '.kit-version'), '0.9.0\n')
  }
  mkdirSync(join(root, '.claude', 'skills', 'aspira-other'), { recursive: true })
  writeFileSync(join(root, '.claude', 'skills', 'aspira-other', 'SKILL.md'), '# mine\n')
  mkdirSync(join(root, '.claude', 'hooks', 'aspira'), { recursive: true })
  for (const name of KIT_HOOKS) writeFileSync(join(root, '.claude', 'hooks', 'aspira', name), '#!/bin/sh\nexit 0\n')
  const hooks = { SessionStart: [KIT_SESSION], PreToolUse: [hookGroup(...KIT_PRE, ...(mixed ? ['sh scripts/mine.sh'] : []))] }
  writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify(mixed ? { permissions: { allow: ['Bash(pnpm test)'] }, hooks } : { hooks }, null, 2)}\n`)
  writeFileSync(join(root, 'AGENTS.md'), EARLIER_AGENTS)
  writeFileSync(join(root, '.gitignore'), options.commentAbove === undefined ? EARLIER_GITIGNORE : EARLIER_GITIGNORE.replace('# per-ticket git worktrees (kit worktree <ID> makes .worktrees/<TYPE>-<ID>)', options.commentAbove))
  expect(git(root, 'init', '-q').status).toBe(0)
  const sh = (...args: string[]) => spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV })
  expect(sh('add', '-A').status).toBe(0)
  expect(sh('commit', '-q', '-m', 'first').status).toBe(0)
  return { root }
}

const runGit = (root: string, ...args: string[]) => spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV })
const commitCount = (root: string) => runGit(root, 'rev-list', '--count', 'HEAD').stdout.trim()

/** The two printed git commands from an init log, as { add, commit, paths }, or undefined when none was printed. */
function printedGit(lines: string[]): { add: string; commit: string; paths: string[] } | undefined {
  const find = (needle: string) => {
    const line = lines.find((l) => l.includes(needle))
    return line === undefined ? undefined : line.slice(line.indexOf(needle.startsWith('git add') ? 'git add' : 'git commit'))
  }
  const add = find('git add -A -- ')
  const commit = find('git commit -m')
  if (add === undefined || commit === undefined) return undefined
  const paths = add.slice(add.indexOf(' -- ') + 4).split(' ').filter((p) => p !== '')
  expect(commit.slice(commit.lastIndexOf(' -- ') + 4).split(' ').filter((p) => p !== ''), 'the commit lists the add paths').toEqual(paths)
  return { add, commit, paths }
}

const covers = (paths: string[], file: string, root: string, base = root) =>
  paths.some((p) => {
    const abs = resolve(base, p.replace(/\/$/, ''))
    const target = join(root, file)
    return abs === target || target.startsWith(`${abs}/`)
  })

/** Files changed against HEAD in the working tree that belong to the harness (everything but the app's own files init rewrites). */
const changedHarnessFiles = (root: string): string[] => runGit(root, 'diff', '--name-only', 'HEAD').stdout.split('\n').filter((f) => f !== '' && !f.startsWith('apps/'))

/** Every file under `dir` (but .git) as relative path -> bytes in hex. */
function bytesOf(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.name === '.git') continue
    if (entry.isDirectory()) Object.assign(out, bytesOf(dir, rel))
    else out[rel] = readFileSync(join(dir, rel)).toString('hex')
  }
  return out
}

describe('kit init removes the committed harness (KIT-71)', () => {
  it('T19: removes the skill folders, hooks, kit hook commands, managed block and ignore lines, prints the git commands and commits nothing', async () => {
    const { root } = earlierKit()
    const lines = await init(root, { app: 'apps/web', board: BOARD })
    for (const name of [...THIRTEEN_SKILLS, 'spec-reviewer']) expect(existsSync(join(root, '.claude', 'skills', `aspira-${name}`)), name).toBe(false)
    expect(existsSync(join(root, '.claude', 'skills', 'aspira-other', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, '.claude', 'hooks', 'aspira'))).toBe(false)
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as { permissions?: unknown; hooks: Record<string, HookGroup[]> }
    expect(settings.permissions).toEqual({ allow: ['Bash(pnpm test)'] })
    expect(settings.hooks.SessionStart).toBeUndefined()
    expect(Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)))).toEqual(['sh scripts/mine.sh'])
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENTS_BEFORE.concat(AGENTS_AFTER))
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(WIRED_GITIGNORE)
    expect(lines.some((l) => l.includes('git add -A -- '))).toBe(true)
    expect(lines.some((l) => l.includes('git commit -m'))).toBe(true)
    // The printed paths are exactly the removed and edited ones: each covers a change, each change is covered, aspira-other is not.
    const printed = printedGit(lines)!
    const changed = changedHarnessFiles(root)
    expect(changed.length).toBeGreaterThan(0)
    for (const file of changed) expect(covers(printed.paths, file, root), file).toBe(true)
    for (const path of printed.paths) expect(changed.some((file) => covers([path], file, root)), path).toBe(true)
    expect(covers(printed.paths, '.claude/skills/aspira-other/SKILL.md', root)).toBe(false)
    expect(commitCount(root)).toBe('1')
  })

  it('T20: keeps a hand-written comment above .worktrees/, deletes a settings.json holding only kit hooks, and a second run has nothing to remove and prints no commit', async () => {
    const { root } = earlierKit({ mixedSettings: false, commentAbove: '# my folders' })
    await init(root, { app: 'apps/web', board: BOARD })
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n')
    expect(ignore).toContain('# my folders')
    expect(ignore).not.toContain('.worktrees/')
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false)
    const second = await init(root, { app: 'apps/web', board: BOARD })
    expect(second.some((l) => /nothing to remove/i.test(l))).toBe(true)
    expect(second.some((l) => l.includes('git commit'))).toBe(false)
  })

  it('T21: a dry run lists every removal and changes no file', async () => {
    const { root } = earlierKit()
    const before = bytesOf(root)
    const lines = await init(root, { app: 'apps/web', board: BOARD, dryRun: true })
    const text = lines.join('\n')
    for (const name of [...THIRTEEN_SKILLS, 'spec-reviewer']) expect(text, name).toContain(`aspira-${name}`)
    expect(lines.filter((l) => /\.claude\/(skills|hooks)/.test(l) && /^(write|update|keep|skip)\b/.test(l)), 'no install line for the harness').toEqual([])
    expect(text).not.toContain('aspira-other')
    expect(text).toContain('.claude/hooks/aspira')
    expect(text).toContain('settings.json')
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('.gitignore')
    expect(bytesOf(root)).toEqual(before)
  })

  it('T22: the two printed commands commit exactly the printed paths and leave an unrelated staged file staged', async () => {
    const { root } = earlierKit()
    writeFileSync(join(root, 'notes.txt'), 'staged by the engineer\n')
    expect(runGit(root, 'add', 'notes.txt').status).toBe(0)
    const lines = await init(root, { app: 'apps/web', board: BOARD })
    const printed = printedGit(lines)!
    for (const command of [printed.add, printed.commit]) {
      const run = spawnSync('sh', ['-c', command], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
      expect(run.status, `${command}\n${run.stderr}`).toBe(0)
    }
    expect(commitCount(root)).toBe('2')
    const committed = runGit(root, 'show', '--name-only', '--pretty=format:', 'HEAD').stdout.split('\n').filter((f) => f !== '')
    expect(committed.length).toBeGreaterThan(0)
    for (const file of committed) expect(covers(printed.paths, file, root), file).toBe(true)
    for (const path of printed.paths) expect(committed.some((file) => covers([path], file, root)), path).toBe(true)
    expect(committed).not.toContain('notes.txt')
    expect(runGit(root, 'diff', '--cached', '--name-only').stdout.split('\n')).toContain('notes.txt')
  })

  it("T23: a project below the git root also loses the .worktrees/ line an earlier kit wrote into the git root's .gitignore, and the printed commands list it", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kit-git-root-')))
    expect(git(repo, 'init', '-q').status).toBe(0)
    writeFileSync(join(repo, '.gitignore'), '# per-ticket git worktrees (kit worktree <ID> makes .worktrees/<TYPE>-<ID>)\n.worktrees/\n')
    const product = join(repo, 'web')
    repository(product)
    writeFileSync(join(product, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    const lines = await init(product, { app: 'apps/web', board: BOARD })
    const rootIgnore = readFileSync(join(repo, '.gitignore'), 'utf8')
    expect(rootIgnore.split('\n')).not.toContain('.worktrees/')
    expect(rootIgnore).not.toContain('per-ticket git worktrees')
    const printed = printedGit(lines)
    expect(printed).toBeDefined()
    // A path is printed either from the git root or from the project root; either way it names the git root's .gitignore.
    const names = (base: string) => printed!.paths.some((p) => resolve(base, p) === join(repo, '.gitignore'))
    expect(names(repo) || names(product)).toBe(true)
  })

  it("T24: doctor names each leftover of an earlier kit, and after init removes them it reports none and no managed-block or harness ignore check", async () => {
    const { root } = earlierKit()
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    const home = harnessHome()
    const notion = { home, env: { NOTION_TOKEN: 'ntn_test' }, check: (checks: { key: string }[]) => Object.fromEntries(checks.map(({ key }) => [key, { ok: true as const }])) }
    const project = (line: string) => !line.includes('~/')
    const oldChecks = (lines: string[]) => lines.filter((l) => l.includes('AGENTS.md has the managed block') || /^(ok {2}|FAIL|skip) \.gitignore ignores \.(work|aspira|worktrees)\//.test(l))
    const first = logs()
    expect(doctor(root, first.log, undefined, notion)).toBe(1)
    const fails = first.lines.filter((l) => l.startsWith('FAIL') && project(l))
    expect(fails.some((l) => l.includes('.claude/skills/aspira-planner'))).toBe(true)
    expect(fails.some((l) => l.includes('.claude/hooks/aspira'))).toBe(true)
    expect(fails.some((l) => l.includes('.claude/settings.json'))).toBe(true)
    expect(fails.some((l) => l.includes('AGENTS.md') && l.includes('managed block'))).toBe(true)
    expect(fails.some((l) => l.includes('.gitignore') && l.includes('.work/'))).toBe(true)
    expect(oldChecks(first.lines)).toEqual([])
    await init(root, { app: 'apps/web', board: BOARD })
    const second = logs()
    expect(doctor(root, second.log, undefined, notion)).toBe(0)
    expect(second.lines.filter((l) => project(l) && /\.claude\/(skills|hooks|settings\.json)/.test(l))).toEqual([])
    expect(second.lines.some((l) => project(l) && l.includes('managed block'))).toBe(false)
    expect(oldChecks(second.lines)).toEqual([])
  })
})

// ---- aspira.json is git-ignored, never committed (KIT-71) ----

const ASPIRA = { board: BOARD, app: 'apps/web' }
const ASPIRA_TEXT = `${JSON.stringify(ASPIRA, null, 2)}\n`

/** A wired project whose aspira.json is committed, as every project was before KIT-71. */
function committedAspira(): { root: string } {
  const { root } = repository()
  writeFileSync(join(root, 'aspira.json'), ASPIRA_TEXT)
  expect(git(root, 'init', '-q').status).toBe(0)
  expect(runGit(root, 'add', '-A').status).toBe(0)
  expect(runGit(root, 'commit', '-q', '-m', 'first').status).toBe(0)
  return { root }
}

const tracked = (root: string): boolean => runGit(root, 'ls-files', '--', 'aspira.json').stdout.trim() !== ''

describe('aspira.json is git-ignored (KIT-71)', () => {
  it('init stops tracking a committed aspira.json, keeps the file, and the printed commands record the untracking', async () => {
    const { root } = committedAspira()
    const lines = await init(root, { app: 'apps/web', board: BOARD })
    expect(tracked(root)).toBe(false)
    expect(readFileSync(join(root, 'aspira.json'), 'utf8')).toBe(ASPIRA_TEXT)
    expect(lines.some((l) => l.startsWith('untrack') && l.includes('aspira.json'))).toBe(true)
    expect(commitCount(root)).toBe('1')
    const commands = lines.filter((l) => /^\s+git (add|commit) /.test(l)).map((l) => l.trim())
    expect(commands.some((c) => c.startsWith('git commit -m'))).toBe(true)
    for (const command of commands) {
      const run = spawnSync('sh', ['-c', command], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
      expect(run.status, `${command}\n${run.stderr}`).toBe(0)
    }
    expect(commitCount(root)).toBe('2')
    expect(runGit(root, 'ls-tree', '--name-only', 'HEAD', '--', 'aspira.json').stdout.trim()).toBe('')
    expect(readFileSync(join(root, 'aspira.json'), 'utf8')).toBe(ASPIRA_TEXT)
  })

  it('a dry run lists the untracking and leaves aspira.json tracked', async () => {
    const { root } = committedAspira()
    const lines = await init(root, { app: 'apps/web', board: BOARD, dryRun: true })
    expect(lines.some((l) => l.startsWith('untrack') && l.includes('aspira.json'))).toBe(true)
    expect(tracked(root)).toBe(true)
  })

  it('init restores the aspira.json a pull of the untracking commit deleted, from the commit before it, and keeps the app it names', async () => {
    const { root } = committedAspira()
    expect(runGit(root, 'rm', '-q', 'aspira.json').status).toBe(0)
    expect(runGit(root, 'commit', '-q', '-m', 'untrack aspira.json').status).toBe(0)
    expect(existsSync(join(root, 'aspira.json'))).toBe(false)
    const lines = await init(root)
    expect(readFileSync(join(root, 'aspira.json'), 'utf8')).toBe(ASPIRA_TEXT)
    expect(lines.some((l) => l.startsWith('restore') && l.includes('aspira.json'))).toBe(true)
    expect(lines).toContain(`stack  next (${root}; app apps/web)`)
    expect(tracked(root)).toBe(false)
  })

  it('init restores a deleted aspira.json from the last commit that still has it, and never overwrites one that is there', async () => {
    const { root } = committedAspira()
    rmSync(join(root, 'aspira.json'))
    const restored = await init(root, { app: 'apps/web' })
    expect(restored.some((l) => l.startsWith('restore') && l.includes('aspira.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual(ASPIRA)
    const mine = `${JSON.stringify({ ...ASPIRA, releases: BOARD }, null, 2)}\n`
    writeFileSync(join(root, 'aspira.json'), mine)
    const kept = await init(root, { app: 'apps/web' })
    expect(kept.some((l) => l.startsWith('restore'))).toBe(false)
    expect(readFileSync(join(root, 'aspira.json'), 'utf8')).toBe(mine)
  })

  it('doctor fails while git tracks aspira.json, naming kit upgrade, and passes that check once it is untracked', () => {
    const { root } = committedAspira()
    const home = harnessHome()
    const notion = { home, env: { NOTION_TOKEN: 'ntn_test' }, check: (checks: { key: string }[]) => Object.fromEntries(checks.map(({ key }) => [key, { ok: true as const }])) }
    const first = logs()
    expect(doctor(root, first.log, undefined, notion)).toBe(1)
    const fail = first.lines.find((l) => l.startsWith('FAIL') && l.includes('aspira.json') && l.includes('tracked'))
    expect(fail).toBeDefined()
    expect(fail).toContain('kit upgrade')
    expect(runGit(root, 'rm', '-q', '--cached', 'aspira.json').status).toBe(0)
    const second = logs()
    doctor(root, second.log, undefined, notion)
    expect(second.lines.some((l) => l.startsWith('FAIL') && l.includes('aspira.json'))).toBe(false)
  })
})

// ---- kit upgrade: the harness migration alone (KIT-71) ----

/** Runs kit upgrade under `home` with no global git config or XDG folder of the developer's, as the CLI would. */
function runUpgrade(root: string, home: string, dryRun = false): { code: number; lines: string[] } {
  const { lines, log } = logs()
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  const code = upgrade({ projectRoot: root, dryRun, log, home, env })
  return { code, lines }
}

const emptyHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'kit-upgrade-home-')))
const harnessEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  return env
}

describe('kit upgrade (KIT-71)', () => {
  it('writes the global harness, removes the committed one, untracks aspira.json keeping the file, touches no stack file, and prints the one commit', () => {
    const { root } = earlierKit({ aspira: true })
    const app = bytesOf(join(root, 'apps'))
    const home = emptyHome()
    const { code, lines } = runUpgrade(root, home)
    expect(code).toBe(0)
    expect(harnessCurrent({ home, env: harnessEnv(home) })).toEqual([])
    for (const name of [...THIRTEEN_SKILLS, 'spec-reviewer']) expect(existsSync(join(root, '.claude', 'skills', `aspira-${name}`)), name).toBe(false)
    expect(existsSync(join(root, '.claude', 'skills', 'aspira-other', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, '.claude', 'hooks', 'aspira'))).toBe(false)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENTS_BEFORE.concat(AGENTS_AFTER))
    expect(tracked(root)).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual(ASPIRA)
    expect(bytesOf(join(root, 'apps')), 'tsconfig, eslint, package.json and the rest of the app are untouched').toEqual(app)
    expect(existsSync(join(root, '.npmrc'))).toBe(false)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(commitCount(root)).toBe('1')
    const command = lines.map((l) => l.trim()).find((l) => l.startsWith('git add -A -- '))
    expect(command).toBeDefined()
    expect(command).toContain(' && git commit -m "chore: move to the global Aspira harness"')
    const run = spawnSync('sh', ['-c', command!], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(commitCount(root)).toBe('2')
    expect(runGit(root, 'ls-tree', '--name-only', 'HEAD', '--', 'aspira.json').stdout.trim()).toBe('')
    expect(changedHarnessFiles(root)).toEqual([])
  })

  it('a dry run lists every change and changes no file in the repository or the home', () => {
    const { root } = earlierKit({ aspira: true })
    const before = bytesOf(root)
    const home = emptyHome()
    const { code, lines } = runUpgrade(root, home, true)
    expect(code).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('.claude/hooks/aspira')
    expect(text).toContain('aspira-planner')
    expect(lines.some((l) => l.startsWith('untrack') && l.includes('aspira.json'))).toBe(true)
    expect(text).not.toContain('git commit')
    expect(bytesOf(root)).toEqual(before)
    expect(tracked(root)).toBe(true)
    expect(readdirSync(home)).toEqual([])
  })

  it('restores an aspira.json a pull deleted, and with nothing else to do says the repository is already on the global harness', () => {
    const { root } = committedAspira()
    expect(runGit(root, 'rm', '-q', 'aspira.json').status).toBe(0)
    expect(runGit(root, 'commit', '-q', '-m', 'untrack aspira.json').status).toBe(0)
    const { code, lines } = runUpgrade(root, harnessHome())
    expect(code).toBe(0)
    expect(readFileSync(join(root, 'aspira.json'), 'utf8')).toBe(ASPIRA_TEXT)
    expect(lines.some((l) => l.startsWith('restore') && l.includes('aspira.json'))).toBe(true)
    expect(lines.some((l) => l.includes('already on the global harness'))).toBe(true)
    expect(lines.some((l) => l.includes('git commit'))).toBe(false)
  })

  it('is a no-op on a repository already on the global harness', () => {
    const { root } = committedAspira()
    expect(runGit(root, 'rm', '-q', '--cached', 'aspira.json').status).toBe(0)
    expect(runGit(root, 'commit', '-q', '-m', 'untrack aspira.json').status).toBe(0)
    const home = harnessHome()
    const before = bytesOf(root)
    const { code, lines } = runUpgrade(root, home)
    expect(code).toBe(0)
    expect(lines.some((l) => l.includes('already on the global harness'))).toBe(true)
    expect(lines.some((l) => /^(remove|untrack|restore)\b/.test(l) || l.includes('git commit'))).toBe(false)
    expect(bytesOf(root)).toEqual(before)
  })
})

describe('readJson', () => {
  it('reads JSON with comments and trailing commas, and leaves comment markers inside strings alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-jsonc-'))
    const path = join(dir, 'tsconfig.json')
    writeFileSync(path, '{\n  // line\n  "a": "x // y /* z */", /* block */\n  "b": [1, 2, /* last */],\n  "c": "quote \\" // still a string",\n}\n')
    expect(readJson(path)).toEqual({ a: 'x // y /* z */', b: [1, 2], c: 'quote " // still a string' })
    expect(hasJsonComments(path)).toBe(true)
    writeFileSync(path, '{"a": "// not a comment"}')
    expect(hasJsonComments(path)).toBe(false)
  })
})

describe('the hooks, run from the global harness as the settings name them', () => {
  it('write the audit log at the root, not beside the script, and git ignores it through the global ignore', async () => {
    const { root } = repository()
    expect(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status).toBe(0)
    await init(root, { app: 'apps/web', board: BOARD })
    const home = harnessHome()
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as Settings
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root, GIT_CONFIG_NOSYSTEM: '1' }
    delete env.XDG_CONFIG_HOME
    for (const group of [...settings.hooks.SessionStart!, ...settings.hooks.PreToolUse!]) {
      for (const hook of group.hooks.filter((h) => h.command.includes('hooks/aspira/'))) {
        // The settings name the hooks with a literal ~, which the shell expands to the temp home.
        const run = spawnSync('sh', ['-c', hook.command], { cwd: root, env, input: '{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}', encoding: 'utf8' })
        expect(run.status, hook.command).toBe(0)
        if (hook.command.endsWith('session-start.sh')) expect(run.stdout).toContain('Agent Instructions')
      }
    }
    expect(existsSync(join(root, '.aspira', 'audit.jsonl'))).toBe(true)
    expect(existsSync(join(root, 'apps', 'web', '.aspira'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.aspira', 'audit.jsonl'), 'utf8').trim())).toMatchObject({ event: { tool_name: 'Bash' } })
    // The project's .gitignore has no .aspira/ line; the global ignore does, so the first tool call does not dirty the tree.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).not.toContain('.aspira/')
    expect(spawnSync('git', ['-C', root, 'status', '--porcelain', '--', '.aspira'], { encoding: 'utf8', env }).stdout).toBe('')
  })
})

describe('kit doctor with an app', () => {
  it('checks the app for the package-level items and the root for the Claude-facing items, from --app or aspira.json, with no project skills or hooks lines', async () => {
    const { root, app } = repository()
    await init(root, { app: 'apps/web', board: BOARD })
    const home = harnessHome()
    const flagged = logs()
    expect(doctor(root, flagged.log, 'apps/web', { home })).toBe(0)
    expect(flagged.lines[0]).toBe(`app    apps/web (package.json and node_modules); Claude-facing files at ${root}`)
    expect(flagged.lines).toContain('ok   apps/web/eslint.config.mjs extends the kit')
    expect(flagged.lines).toContain('ok   .mcp.json registers aspiralabs-ui from apps/web/node_modules')
    expect(flagged.lines).toContain('ok   aspira.json names the Feature Board and the app (apps/web)')
    expect(flagged.lines.filter((l) => /^(ok {2}|FAIL) \.claude\/(skills|settings\.json|hooks)/.test(l))).toEqual([])
    expect(flagged.lines.filter((l) => /^(ok {2}|FAIL|skip) \.gitignore ignores \.(work|aspira|worktrees)\//.test(l) || l.includes('AGENTS.md has the managed block'))).toEqual([])
    expect(flagged.lines.at(-1)).toBe('healthy')
    // Without the flag: the app comes from aspira.json.
    const fromConfig = logs()
    expect(doctor(root, fromConfig.log, undefined, { home })).toBe(0)
    expect(fromConfig.lines).toEqual(flagged.lines)
    // Package-level drift is reported against the app.
    writeFileSync(join(app, 'eslint.config.mjs'), 'export default []\n')
    const drift = logs()
    expect(doctor(root, drift.log, undefined, { home })).toBe(1)
    expect(drift.lines).toContain('FAIL apps/web/eslint.config.mjs extends the kit')
    expect(drift.lines.at(-1)).toBe('1 problem(s); run kit init --stack next --app apps/web (and --board <Feature Board URL> when aspira.json is the problem)')
  })

  it('says what to do at a root with no package.json and no app, and finds the root from inside the app', async () => {
    const { root, app } = repository()
    const bare = logs()
    expect(doctor(root, bare.log, undefined, { home: harnessHome() })).toBe(1)
    expect(bare.lines).toEqual(['no package.json here (in a repository whose app lives in a subdirectory, pass --app <dir>)'])
    expect(resolveProjectRoot(app)).toBe(app)
    await init(root, { app: 'apps/web', board: BOARD })
    // `pnpm kit doctor` in apps/web, where the kit's bin is: the root that wired it.
    expect(resolveProjectRoot(app)).toBe(root)
    expect(resolveProjectRoot(join(app, 'app'))).toBe(root)
    expect(resolveProjectRoot(root)).toBe(root)
    expect(resolveProjectRoot(join(root, 'apps'))).toBe(join(root, 'apps'))
  })
})

describe('kit next with an app', () => {
  it('resolves the ticket with @aspiralabs/ai installed under the app named in aspira.json, or by --app', () => {
    const { root } = repository()
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    const seen: string[][] = []
    const resolver: Resolver = (board, ref, projectRoot, appDir) => {
      seen.push([board, ref, projectRoot, appDir])
      return { id: ref, title: 'Explore pagination', url: '', status: 'Ready: Spec' }
    }
    const { lines, log } = logs()
    expect(next(root, 'NOM-4', log, resolver)).toBe(0)
    expect(seen).toEqual([[BOARD, 'NOM-4', root, join(root, 'apps', 'web')]])
    expect(lines).toContain('run      /aspira-planner NOM-4')
    mkdirSync(join(root, 'apps', 'mobile'))
    expect(next(root, 'NOM-4', log, resolver, 'apps/mobile')).toBe(0)
    expect(seen[1]![3]).toBe(join(root, 'apps', 'mobile'))
  })

  it('prints the same five lines for a ticket that also carries its type and working-folder name', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-next-typed-')))
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
    const resolver: Resolver = () => {
      const ticket = { id: 'NOM-4', title: 'Explore pagination', url: 'https://app.notion.com/p/abc', status: 'Ready: Spec', type: 'Feature', folder: 'nom-4-explore-pagination' }
      return ticket
    }
    const { lines, log } = logs()
    const code = next(root, 'NOM-4', log, resolver)
    expect({ code, lines }).toEqual({
      code: 0,
      lines: ['ticket   NOM-4 Explore pagination (https://app.notion.com/p/abc)', 'status   Ready: Spec', 'next     Step 5: plan', 'run      /aspira-planner NOM-4', 'who      agent'],
    })
  })

  const amaro = [join(kit, 'node_modules', 'amaro'), join(dirname(dirname(kit)), 'node_modules', 'amaro'), join(dirname(dirname(kit)), 'packages', 'agents', 'implementor', 'node_modules', 'amaro')].find((dir) => existsSync(dir)) ?? ''
  it.skipIf(amaro === '')('runs the global kit common resolve script from the app, with the app\'s .env.local', () => {
    const { root, app } = repository()
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    // The global @aspiralabs/ai the kit runs from (a copy under the app's node_modules would never be used).
    const installed = join(root, 'global', '@aspiralabs', 'ai')
    mkdirSync(join(installed, 'node_modules'), { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: VERSION, type: 'module' }))
    symlinkSync(realpathSync(amaro), join(installed, 'node_modules', 'amaro'))
    mkdirSync(join(installed, 'common', 'scripts'), { recursive: true })
    writeFileSync(join(installed, 'common', 'scripts', 'resolve-ticket.ts'), "const ref: string = process.argv[2]!\nconsole.log(`id=${ref}\\ntitle=Explore pagination\\nurl=https://www.notion.so/nom-4\\nstatus=${process.env.FAKE_STATUS ?? 'Idea'}`)\n")
    writeFileSync(join(app, '.env.local'), 'FAKE_STATUS=In Review: Spec\n')
    const { lines, log } = logs()
    fakeAi.dir = installed
    try {
      expect(next(root, 'NOM-4', log, liveResolver)).toBe(0)
    } finally {
      fakeAi.dir = undefined
    }
    expect(lines).toContain('status   In Review: Spec')
    expect(lines).toContain('run      /aspira-spec-writer NOM-4')
  })
})
