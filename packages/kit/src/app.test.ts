// A multi-app repository (nomnomzz): the Next app with package.json and node_modules is apps/web,
// there is no root package.json, and Claude Code runs at the root. `kit init --app apps/web` at the
// root puts the package steps in the app and the Claude-facing files at the root, with every path
// inside them pointing into the app; doctor, next and the launchers read the app from aspira.json.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkAspira, normalizeApp, readApp, resolveProjectRoot, writeAspira } from './aspira.js'
import { doctor } from './doctor.js'
import { hasJsonComments, readJson } from './fs.js'
import { liveResolver, next, type Resolver } from './next.js'
import { AGENTS, skillDir } from './skills.js'
import { initNext } from './stacks/next.js'

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const VERSION = '0.9.0'

type Settings = { hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]> }
type Mcp = { mcpServers: Record<string, { command: string; args: string[] }> }

const logs = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

/** A repository with no root package.json whose Next app is apps/web, with the kit packages installed there the way pnpm lays them out. */
function repository(): { root: string; app: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-app-')))
  const app = join(root, 'apps', 'web')
  mkdirSync(join(app, 'app'), { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'web', private: true, dependencies: { '@aspiralabs/ui': VERSION }, devDependencies: { '@aspiralabs/config': VERSION, '@aspiralabs/kit': VERSION, '@aspiralabs/agents': VERSION } }))
  writeFileSync(join(app, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
  writeFileSync(join(app, 'app', 'globals.css'), '@import "tailwindcss";\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  writeFileSync(join(root, 'AGENTS.md'), '# nomnomzz\n\n## About this project\n\nRecipes.\n')
  const scope = join(app, 'node_modules', '@aspiralabs')
  const store = join(app, 'node_modules', '.pnpm', `@aspiralabs+agents@${VERSION}`, 'node_modules', '@aspiralabs')
  const pkg = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true })
    // The agents are ES modules run straight from TypeScript source; "type" is what lets amaro's hook see them as such.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version: VERSION, type: 'module' }))
  }
  for (const name of ['ui', 'config', 'kit']) pkg(join(scope, name), name)
  // The hooks as the installed package ships them, so the settings' commands can be run from the root.
  cpSync(join(kit, 'hooks'), join(scope, 'kit', 'hooks'), { recursive: true })
  mkdirSync(join(scope, 'ui', 'bin'), { recursive: true })
  writeFileSync(join(scope, 'ui', 'bin', 'mcp.js'), '#!/usr/bin/env node\n')
  pkg(join(store, 'agents'), 'agents')
  symlinkSync(join(store, 'agents'), join(scope, 'agents'))
  for (const agent of [...AGENTS, 'agent-common'] as const) {
    pkg(join(store, agent), agent)
    if (agent === 'agent-common') continue
    mkdirSync(join(store, agent, 'skill', `aspira-${agent}`, 'scripts'), { recursive: true })
    writeFileSync(join(store, agent, 'skill', `aspira-${agent}`, 'SKILL.md'), `---\nname: aspira-${agent}\n---\n`)
    writeFileSync(join(store, agent, 'skill', `aspira-${agent}`, 'scripts', `${agent}.sh`), '#!/bin/bash\necho hi\n')
  }
  return { root, app }
}

/** Runs init with the install step answered by a pnpm stub (the packages are already laid out). */
async function init(root: string, extra: { app?: string; board?: string; dryRun?: boolean } = {}): Promise<string[]> {
  const bin = join(root, '.stub-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\n[ "$1" = add ] && exit 0\nexit 1\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  const { lines, log } = logs()
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    await initNext({ projectRoot: root, dryRun: extra.dryRun ?? false, log, ...(extra.app === undefined ? {} : { app: extra.app }), ...(extra.board === undefined ? {} : { board: extra.board }) })
  } finally {
    process.env.PATH = path
  }
  return lines
}

describe('kit init --stack next --app apps/web at the repository root', () => {
  it('writes the package files in the app and the Claude-facing files at the root, with paths pointing into the app', async () => {
    const { root, app } = repository()
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
    // Claude-facing: at the root, nothing of it in the app.
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.json', 'aspira.json']) {
      expect(existsSync(join(root, file)), file).toBe(true)
      expect(existsSync(join(app, file)), file).toBe(false)
    }
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(agents).toMatch(/^# nomnomzz\n\n## About this project\n\nRecipes\.\n\n<!-- aspiralabs:begin/)
    expect(agents).toContain('- **The app:** `apps/web` owns `package.json` and `node_modules`')
    expect(agents).not.toContain('{{app')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as Mcp
    expect(mcp.mcpServers['aspiralabs-ui']).toEqual({ command: 'node', args: ['apps/web/node_modules/@aspiralabs/ui/bin/mcp.js'] })
    expect(existsSync(join(root, mcp.mcpServers['aspiralabs-ui']!.args[0]!))).toBe(true)
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings
    expect(settings.hooks.SessionStart!.map((g) => g.hooks.map((h) => h.command))).toEqual([['sh apps/web/node_modules/@aspiralabs/kit/hooks/session-start.sh']])
    expect(settings.hooks.PreToolUse!.map((g) => g.hooks.map((h) => h.command))).toEqual([['sh apps/web/node_modules/@aspiralabs/kit/hooks/deny-tier3.sh', 'sh apps/web/node_modules/@aspiralabs/kit/hooks/audit-log.sh']])
    for (const agent of AGENTS) {
      expect(readFileSync(join(skillDir(root, agent), '.kit-version'), 'utf8')).toBe(`${VERSION}\n`)
      expect(existsSync(join(app, '.claude'))).toBe(false)
    }
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD, app: 'apps/web' })
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^node_modules\n\n# per-ticket[^\n]*\n\.work\/\n# the audit log[^\n]*\n\.aspira\/\n$/)
    expect(existsSync(join(app, '.gitignore'))).toBe(false)
  })

  it('is idempotent: a re-run keeps every file and leaves one kit hook group per event, also when the app moves', async () => {
    const { root } = repository()
    await init(root, { app: 'apps/web', board: BOARD })
    const before = { settings: readFileSync(join(root, '.claude', 'settings.json'), 'utf8'), mcp: readFileSync(join(root, '.mcp.json'), 'utf8'), gitignore: readFileSync(join(root, '.gitignore'), 'utf8'), agents: readFileSync(join(root, 'AGENTS.md'), 'utf8') }
    const again = await init(root, { app: 'apps/web', board: BOARD })
    expect(again.filter((l) => l.startsWith('write ')).length).toBe(0)
    expect(again).toContain(`keep   ${join(root, '.gitignore')} (.work/, .aspira/ ignored)`)
    expect(again).toContain(`keep   ${join(root, 'aspira.json')} (board already set)`)
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe(before.settings)
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(before.mcp)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(before.gitignore)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(before.agents)
    // A project wired for the root earlier (hooks at node_modules/...) and a server of its own: the kit's entries are replaced, the project's kept.
    const settingsPath = join(root, '.claude', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings & { permissions?: unknown }
    settings.permissions = { allow: ['Bash(pnpm test)'] }
    settings.hooks.SessionStart!.push({ matcher: 'startup', hooks: [{ command: 'sh node_modules/@aspiralabs/kit/hooks/session-start.sh' }] }, { matcher: 'startup', hooks: [{ command: 'echo mine' }] })
    writeFileSync(settingsPath, JSON.stringify(settings))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': { command: 'npx', args: ['--no', 'aspiralabs-ui-mcp'] }, notion: { command: 'npx', args: ['notion-mcp'] } } }))
    await init(root, { app: 'apps/web' })
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings & { permissions?: unknown }
    expect(merged.permissions).toEqual({ allow: ['Bash(pnpm test)'] })
    expect(merged.hooks.SessionStart!.map((g) => g.hooks.map((h) => h.command))).toEqual([['echo mine'], ['sh apps/web/node_modules/@aspiralabs/kit/hooks/session-start.sh']])
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
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).not.toContain('**The app:**')
    expect((JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as Mcp).mcpServers['aspiralabs-ui']).toEqual({ command: 'npx', args: ['--no', 'aspiralabs-ui-mcp'] })
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toBe('sh node_modules/@aspiralabs/kit/hooks/session-start.sh')
    expect(JSON.parse(readFileSync(join(root, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD })
    expect(readApp(root)).toBeUndefined()
    expect(doctor(root, () => {})).toBe(0)
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
    doctor(root, log)
    expect(lines).toContain(`FAIL workspace root declares @aspiralabs/config ^0.4.2, the app ${VERSION}`)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hangar', private: true, devDependencies: { '@aspiralabs/config': VERSION } }))
    const again = logs()
    doctor(root, again.log)
    expect(again.lines).toContain(`ok   workspace root declares @aspiralabs/config ${VERSION}, as the app does`)
    expect(again.lines).toContain('ok   apps/web/tsconfig.json extends the kit')
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

describe('the hooks, run from the root as the settings name them', () => {
  it('write the audit log at the root, not beside the script under apps/web/node_modules', async () => {
    const { root } = repository()
    await init(root, { app: 'apps/web', board: BOARD })
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root }
    for (const group of [...settings.hooks.SessionStart!, ...settings.hooks.PreToolUse!]) {
      for (const hook of group.hooks) {
        const [sh, script] = hook.command.split(' ')
        const run = spawnSync(sh!, [script!], { cwd: root, env, input: '{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}', encoding: 'utf8' })
        expect(run.status, hook.command).toBe(0)
        if (script!.endsWith('session-start.sh')) expect(run.stdout).toContain('Agent Instructions')
      }
    }
    expect(existsSync(join(root, '.aspira', 'audit.jsonl'))).toBe(true)
    expect(existsSync(join(root, 'apps', 'web', '.aspira'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.aspira', 'audit.jsonl'), 'utf8').trim())).toMatchObject({ event: { tool_name: 'Bash' } })
    // And git ignores it, so the first tool call does not dirty the tree.
    expect(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status).toBe(0)
    expect(spawnSync('git', ['-C', root, 'status', '--porcelain', '--', '.aspira'], { encoding: 'utf8' }).stdout).toBe('')
  })
})

describe('kit doctor with an app', () => {
  it('checks the app for the package-level items and the root for the Claude-facing items, from --app or aspira.json', async () => {
    const { root, app } = repository()
    await init(root, { app: 'apps/web', board: BOARD })
    const flagged = logs()
    expect(doctor(root, flagged.log, 'apps/web')).toBe(0)
    expect(flagged.lines[0]).toBe(`app    apps/web (package.json and node_modules); Claude-facing files at ${root}`)
    expect(flagged.lines).toContain('ok   apps/web/eslint.config.mjs extends the kit')
    expect(flagged.lines).toContain('ok   .claude/settings.json has the hooks from apps/web/node_modules')
    expect(flagged.lines).toContain('ok   .mcp.json registers aspiralabs-ui from apps/web/node_modules')
    expect(flagged.lines).toContain('ok   .gitignore ignores .aspira/ (the audit log the hooks write)')
    expect(flagged.lines).toContain('ok   aspira.json names the Feature Board and the app (apps/web)')
    expect(flagged.lines.filter((l) => l.startsWith('ok   .claude/skills/aspira-')).length).toBe(6)
    expect(flagged.lines.at(-1)).toBe('healthy')
    // Without the flag: the app comes from aspira.json.
    const fromConfig = logs()
    expect(doctor(root, fromConfig.log)).toBe(0)
    expect(fromConfig.lines).toEqual(flagged.lines)
    // Package-level drift is reported against the app, Claude-facing drift against the root.
    writeFileSync(join(app, 'eslint.config.mjs'), 'export default []\n')
    writeFileSync(join(root, '.gitignore'), '.work/\n')
    const drift = logs()
    expect(doctor(root, drift.log)).toBe(1)
    expect(drift.lines).toContain('FAIL apps/web/eslint.config.mjs extends the kit')
    expect(drift.lines).toContain('FAIL .gitignore ignores .aspira/ (the audit log the hooks write)')
    expect(drift.lines.at(-1)).toBe('2 problem(s); run kit init --stack next --app apps/web (and --board <Feature Board URL> when aspira.json is the problem)')
  })

  it('says what to do at a root with no package.json and no app, and finds the root from inside the app', async () => {
    const { root, app } = repository()
    const bare = logs()
    expect(doctor(root, bare.log)).toBe(1)
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
  it('resolves the ticket with the agents installed under the app named in aspira.json, or by --app', () => {
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
    expect(lines).toContain('run      /aspira-planner NOM-4 --local')
    mkdirSync(join(root, 'apps', 'mobile'))
    expect(next(root, 'NOM-4', log, resolver, 'apps/mobile')).toBe(0)
    expect(seen[1]![3]).toBe(join(root, 'apps', 'mobile'))
  })

  const amaro = join(dirname(dirname(kit)), 'packages', 'agents', 'implementor', 'node_modules', 'amaro')
  it.skipIf(!existsSync(amaro))('runs the installed agent-common resolve script from the app, with the app\'s .env.local', () => {
    const { root, app } = repository()
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    const store = join(app, 'node_modules', '.pnpm', `@aspiralabs+agents@${VERSION}`, 'node_modules')
    symlinkSync(realpathSync(amaro), join(store, 'amaro'))
    mkdirSync(join(store, '@aspiralabs', 'agent-common', 'scripts'), { recursive: true })
    writeFileSync(join(store, '@aspiralabs', 'agent-common', 'scripts', 'resolve-ticket.ts'), "const ref: string = process.argv[2]!\nconsole.log(`id=${ref}\\ntitle=Explore pagination\\nurl=https://www.notion.so/nom-4\\nstatus=${process.env.FAKE_STATUS ?? 'Idea'}`)\n")
    writeFileSync(join(app, '.env.local'), 'FAKE_STATUS=In Review: Spec\n')
    const { lines, log } = logs()
    expect(next(root, 'NOM-4', log, liveResolver)).toBe(0)
    expect(lines).toContain('status   In Review: Spec')
    expect(lines).toContain('run      /aspira-spec-reviewer NOM-4 --local')
  })
})
