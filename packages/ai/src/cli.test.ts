// T26-T27 (F7, F8): the built dist/cli.js (CI's prepare builds it, as for playbook-export.test.ts) run as a
// child process. The version-check cache is a JSON file under <HOME>/.cache/aspiralabs/version-check.json
// shaped { checkedAt: <ms>, latest: '<x.y.z>', notified: {} }. No network is needed: the cached answer
// is fresh, and the no-cache homes have no token, so no request is made.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))
const BOARD = 'https://www.notion.so/Board-0123456789abcdef0123456789abcdef'

const dirs: string[] = []
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ai-cli-${name}-`))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const ownVersion = (): string => (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string }).version

function homeWithCache(latest: string | null): string {
  const home = temp('home')
  if (latest !== null) {
    mkdirSync(join(home, '.cache', 'aspiralabs'), { recursive: true })
    writeFileSync(join(home, '.cache', 'aspiralabs', 'version-check.json'), JSON.stringify({ checkedAt: Date.now(), latest, notified: {} }))
  }
  return home
}

function kit(args: string[], opts: { home: string; cwd?: string; env?: NodeJS.ProcessEnv }) {
  // The global git config is the one in the temp HOME: nothing reads the real one.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home, USERPROFILE: opts.home, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  Object.assign(env, opts.env)
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'KIT_REEXEC', 'ASPIRA_KIT_REEXEC']) delete env[key]
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? opts.home, env, encoding: 'utf8', timeout: 60_000 })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function fixtureProject(): string {
  const root = temp('project')
  writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }))
  return root
}

function stubKit(appDir: string, exitCode = 7): string {
  const bin = join(appDir, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'kit')
  writeFileSync(file, `#!/bin/sh\necho "project-kit $*"\nexit ${exitCode}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('kit stderr notice', () => {
  it('T26: doctor gets the notice on stderr only, with stdout and exit code unchanged; playbook never does', () => {
    const project = fixtureProject()
    const plain = kit(['doctor', '--cwd', project], { home: homeWithCache(null) })
    const newer = kit(['doctor', '--cwd', project], { home: homeWithCache('99.0.0') })
    expect(newer.stdout).toBe(plain.stdout)
    expect(newer.code).toBe(plain.code)
    expect(plain.stderr).not.toContain('99.0.0')
    const last = newer.stderr.trimEnd().split('\n').at(-1) ?? ''
    expect(last).toContain('99.0.0')
    expect(last).toContain(ownVersion())
    expect(last).toContain('Upgrade: kit update')

    const playbookPlain = kit(['playbook'], { home: homeWithCache(null) })
    const playbookNewer = kit(['playbook'], { home: homeWithCache('99.0.0') })
    expect(playbookNewer.stdout).toBe(playbookPlain.stdout)
    expect(playbookNewer.stderr).not.toContain('99.0.0')
    expect(playbookPlain.stderr).not.toContain('99.0.0')
  })

  it('T26: an unwritable cache directory changes neither exit codes nor stdout', () => {
    const project = fixtureProject()
    const baseline = kit(['doctor', '--cwd', project], { home: homeWithCache(null) })
    const home = temp('blocked')
    // A file where the cache directory should be: the cache cannot be created or written.
    writeFileSync(join(home, '.cache'), 'not a directory')
    const blocked = kit(['doctor', '--cwd', project], { home })
    expect(blocked.code).toBe(baseline.code)
    expect(blocked.stdout).toBe(baseline.stdout)
    const playbookBlocked = kit(['playbook'], { home })
    expect(playbookBlocked.code).toBe(0)
    expect(playbookBlocked.stdout).toBe(kit(['playbook'], { home: homeWithCache(null) }).stdout)
  })
})

describe('global kit', () => {
  it("inside a project that still has its own kit from before global installs, the running kit answers, not the project's copy", () => {
    const project = fixtureProject()
    stubKit(project)
    const result = kit(['doctor'], { home: homeWithCache(null), cwd: project })
    expect(result.stdout).not.toContain('project-kit')
    expect(result.stdout).toContain('@aspiralabs/ai')

    const app = temp('app-project')
    writeFileSync(join(app, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    mkdirSync(join(app, 'apps', 'web'), { recursive: true })
    writeFileSync(join(app, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', private: true }))
    stubKit(join(app, 'apps', 'web'))
    expect(kit(['doctor'], { home: homeWithCache(null), cwd: app }).stdout).not.toContain('project-kit')
  })

  it('init with no --app works on the app aspira.json records', () => {
    const project = temp('app-init')
    writeFileSync(join(project, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    mkdirSync(join(project, 'apps', 'web'), { recursive: true })
    writeFileSync(join(project, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', private: true }))
    const result = kit(['init', '--stack', 'next', '--dry-run', '--cwd', project], { home: homeWithCache(null) })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('app apps/web')
  })
})

// ---- The global harness: kit update, the writer, self-healing and kit doctor (KIT-71) ----

const SKILL_NAMES = ['build-feature', 'cleanup', 'code-analyzer', 'groomer', 'implementor', 'next', 'planner', 'pr-reviewer', 'spec-writer', 'visual-verify', 'worktree']
const HOOK_NAMES = ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh']
const KIT_PACKAGE_DIR = dirname(dirname(CLI))
const hookCmd = (name: string): string => `sh ~/.claude/hooks/aspira/${name}`
const skillsDir = (home: string): string => join(home, '.claude', 'skills')
const settingsFile = (home: string): string => join(home, '.claude', 'settings.json')
const defaultIgnore = (home: string): string => join(home, '.config', 'git', 'ignore')

/** A stub-bin folder: `pnpm` appends its arguments to a calls file, optionally prints an error and exits; `kit` runs this checkout's CLI. */
function stubBin(pnpm: { exit?: number; stderr?: string } = {}): { bin: string; calls: string; env: NodeJS.ProcessEnv } {
  const bin = temp('bin')
  const calls = join(bin, 'pnpm-calls.txt')
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "$@" >> '${calls}'\n${pnpm.stderr ? `echo '${pnpm.stderr}' >&2\n` : ''}exit ${pnpm.exit ?? 0}\n`)
  writeFileSync(join(bin, 'kit'), `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  chmodSync(join(bin, 'kit'), 0o755)
  return { bin, calls, env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } }
}

/** Every file under `dir` (and the extra files) as path -> bytes in hex, links as their target. */
function snapshot(home: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (path: string): void => {
    if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) return
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) out[path] = `link`
    else if (stat.isDirectory()) {
      out[path] = 'dir'
      for (const entry of readdirSync(path).sort()) walk(join(path, entry))
    } else out[path] = readFileSync(path).toString('hex')
  }
  walk(join(home, '.claude'))
  walk(join(home, '.config'))
  return out
}

const readSettings = (home: string): { model?: string; hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type?: string; command: string }> }>> } =>
  JSON.parse(readFileSync(settingsFile(home), 'utf8'))
const isKitCommand = (command: string): boolean => command.includes('hooks/aspira/')
/** The groups of one event that hold a kit command. */
const kitGroups = (home: string, event: string) => (readSettings(home).hooks?.[event] ?? []).filter((group) => group.hooks.some((hook) => isKitCommand(hook.command)))
const allCommands = (home: string, event: string): string[] => (readSettings(home).hooks?.[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))

/** A home with a current harness, written by one `kit package-dir` run. */
function harnessHome(): string {
  const home = homeWithCache(null)
  expect(kit(['package-dir'], { home }).code).toBe(0)
  return home
}

function kitAsync(args: string[], home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'KIT_REEXEC', 'ASPIRA_KIT_REEXEC']) delete env[key]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function gitProject(): string {
  const root = fixtureProject()
  execFileSync('git', ['init', '-q', root])
  return root
}

describe('kit update', () => {
  it('T1: installs the latest kit globally with pnpm, then writes the eleven skills and three hooks to ~/.claude', () => {
    const home = homeWithCache(null)
    const stub = stubBin()
    const result = kit(['update'], { home, env: stub.env })
    expect(result.code).toBe(0)
    expect(readFileSync(stub.calls, 'utf8').trim()).toBe('add -g @aspiralabs/ai@latest')
    expect(readdirSync(skillsDir(home)).filter((name) => name.startsWith('aspira-')).sort()).toEqual(SKILL_NAMES.map((name) => `aspira-${name}`))
    for (const name of SKILL_NAMES) expect(readFileSync(join(skillsDir(home), `aspira-${name}`, '.kit-version'), 'utf8').trim(), name).toBe(ownVersion())
    for (const hook of HOOK_NAMES) expect(existsSync(join(home, '.claude', 'hooks', 'aspira', hook)), hook).toBe(true)
  })

  it('T2: a failed install exits non-zero with pnpm\'s error and leaves ~/.claude and the global ignore untouched', () => {
    const home = harnessHome()
    const before = snapshot(home)
    const stub = stubBin({ exit: 1, stderr: 'ERR_PNPM_FETCH_404 not found' })
    const result = kit(['update'], { home, env: stub.env })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('ERR_PNPM_FETCH_404')
    expect(snapshot(home)).toEqual(before)
  })

  it('T3: the usage and the upgrade notice name kit update, and the notice does not name kit init', () => {
    const home = homeWithCache('99.0.0')
    const bare = kit([], { home })
    expect(bare.stdout + bare.stderr).toContain('kit update')
    const doctor = kit(['doctor', '--cwd', fixtureProject()], { home: homeWithCache('99.0.0') })
    const notice = doctor.stderr.trimEnd().split('\n').at(-1) ?? ''
    expect(notice).toContain('99.0.0')
    expect(notice).toContain('kit update')
    expect(notice).not.toContain('kit init')
  })
})

describe('the global harness writer', () => {
  it('T4: writes the eleven skills as regular folders, retires aspira-spec-reviewer and keeps the engineer\'s own skills and symlink targets', () => {
    const home = homeWithCache(null)
    const skills = skillsDir(home)
    mkdirSync(join(skills, 'aspira-spec-reviewer'), { recursive: true })
    writeFileSync(join(skills, 'aspira-spec-reviewer', 'SKILL.md'), 'retired')
    const target = temp('groomer-target')
    writeFileSync(join(target, 'marker.txt'), 'mine')
    symlinkSync(target, join(skills, 'aspira-groomer'))
    mkdirSync(join(skills, 'aspira-custom'), { recursive: true })
    writeFileSync(join(skills, 'aspira-custom', 'SKILL.md'), 'custom skill')

    const result = kit(['package-dir'], { home })
    expect(result.stdout).toBe(`${KIT_PACKAGE_DIR}\n`)
    for (const name of SKILL_NAMES) {
      const dir = join(skills, `aspira-${name}`)
      expect(lstatSync(dir).isSymbolicLink(), name).toBe(false)
      expect(lstatSync(dir).isDirectory(), name).toBe(true)
      expect(existsSync(join(dir, 'SKILL.md')), name).toBe(true)
      expect(existsSync(join(dir, 'scripts', `${name}.sh`)), name).toBe(true)
      expect(readFileSync(join(dir, '.kit-version'), 'utf8').trim(), name).toBe(ownVersion())
    }
    expect(existsSync(join(skills, 'aspira-spec-reviewer'))).toBe(false)
    expect(readFileSync(join(skills, 'aspira-custom', 'SKILL.md'), 'utf8')).toBe('custom skill')
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('mine')
  })

  it('T5: merges the kit hooks into an existing settings.json at the literal ~ commands, keeping the engineer\'s settings, hooks and file mode', () => {
    const home = homeWithCache(null)
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      settingsFile(home),
      JSON.stringify({
        model: 'opus',
        hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write', hooks: [{ type: 'command', command: 'sh ~/bin/mine.sh' }, { type: 'command', command: 'sh .claude/hooks/aspira/deny-tier3.sh' }] }] },
      }),
    )
    chmodSync(settingsFile(home), 0o644)
    expect(kit(['package-dir'], { home }).code).toBe(0)
    writeFileSync(join(skillsDir(home), 'aspira-planner', '.kit-version'), '0.0.1\n')
    expect(kit(['package-dir'], { home }).code).toBe(0)

    const settings = readSettings(home)
    expect(settings.model).toBe('opus')
    expect(allCommands(home, 'PreToolUse')).toContain('sh ~/bin/mine.sh')
    expect(kitGroups(home, 'SessionStart').length).toBe(1)
    expect(kitGroups(home, 'PreToolUse').length).toBe(1)
    const kitCommands = [...allCommands(home, 'SessionStart'), ...allCommands(home, 'PreToolUse')].filter(isKitCommand).sort()
    expect(kitCommands).toEqual(HOOK_NAMES.map(hookCmd).sort())
    for (const command of [...allCommands(home, 'SessionStart'), ...allCommands(home, 'PreToolUse')]) expect(command).not.toMatch(/(?<!~\/)\.claude\/hooks\/aspira/)
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o644)
    for (const hook of HOOK_NAMES) expect(statSync(join(home, '.claude', 'hooks', 'aspira', hook)).mode & 0o777, hook).toBe(0o755)
  })

  it('T6: creates settings.json at mode 0600 running the three kit commands on SessionStart and PreToolUse', () => {
    const home = homeWithCache(null)
    expect(kit(['package-dir'], { home }).code).toBe(0)
    expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600)
    expect(allCommands(home, 'SessionStart')).toContain(hookCmd('session-start.sh'))
    const pre = kitGroups(home, 'PreToolUse')
    expect(pre.length).toBe(1)
    expect(pre[0]!.matcher).toBe('Bash|Edit|Write')
    expect(pre[0]!.hooks.map((hook) => hook.command)).toEqual(expect.arrayContaining([hookCmd('deny-tier3.sh'), hookCmd('audit-log.sh')]))
  })

  it('T7: a settings.json that is not strict JSON is left byte for byte, with a stderr note naming the file and the entry to add by hand', () => {
    for (const body of ['{\n  // comment\n  "model": "opus"\n}\n', '{ not json']) {
      const home = homeWithCache(null)
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(settingsFile(home), body)
      const result = kit(['package-dir'], { home })
      expect(result.code).toBe(0)
      expect(readFileSync(settingsFile(home), 'utf8')).toBe(body)
      expect(result.stderr).toContain(settingsFile(home))
      expect(result.stderr).toContain('sh ~/.claude/hooks/aspira/deny-tier3.sh')
    }
  })

  it('T8: the global ignore is core.excludesFile, else $XDG_CONFIG_HOME/git/ignore, else ~/.config/git/ignore, and the kit never sets core.excludesFile', () => {
    const wanted = ['.work/', '.aspira/', '.worktrees/']
    const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').map((line) => line.trim())

    const a = homeWithCache(null)
    expect(kit(['package-dir'], { home: a }).code).toBe(0)
    expect(lines(defaultIgnore(a))).toEqual(expect.arrayContaining(wanted))
    expect(existsSync(join(a, '.gitconfig'))).toBe(false)

    const b = homeWithCache(null)
    const xdg = temp('xdg')
    expect(kit(['package-dir'], { home: b, env: { XDG_CONFIG_HOME: xdg } }).code).toBe(0)
    expect(lines(join(xdg, 'git', 'ignore'))).toEqual(expect.arrayContaining(wanted))
    expect(existsSync(defaultIgnore(b))).toBe(false)
    expect(existsSync(join(b, '.gitconfig'))).toBe(false)

    const c = homeWithCache(null)
    const config = '[core]\n\texcludesFile = ~/my-ignore\n'
    writeFileSync(join(c, '.gitconfig'), config)
    writeFileSync(join(c, 'my-ignore'), '.work/\n*.log\n')
    expect(kit(['package-dir'], { home: c }).code).toBe(0)
    const mine = lines(join(c, 'my-ignore'))
    expect(mine).toContain('*.log')
    expect(mine.filter((line) => line === '.work/').length).toBe(1)
    expect(mine).toEqual(expect.arrayContaining(['.aspira/', '.worktrees/']))
    expect(readFileSync(join(c, '.gitconfig'), 'utf8')).toBe(config)
  })
})

describe('self-healing', () => {
  const versionOf = (home: string, name: string): string => readFileSync(join(skillsDir(home), `aspira-${name}`, '.kit-version'), 'utf8').trim()

  it('T9: each drift is repaired by the next kit command, and a current harness is not rewritten', () => {
    for (const stale of ['0.0.1', '999.0.0']) {
      const home = harnessHome()
      writeFileSync(join(skillsDir(home), 'aspira-planner', '.kit-version'), `${stale}\n`)
      expect(kit(['version-check'], { home }).code).toBe(0)
      expect(versionOf(home, 'planner'), stale).toBe(ownVersion())
    }

    const hook = harnessHome()
    rmSync(join(hook, '.claude', 'hooks', 'aspira', 'audit-log.sh'))
    kit(['package-dir'], { home: hook })
    expect(existsSync(join(hook, '.claude', 'hooks', 'aspira', 'audit-log.sh'))).toBe(true)

    const ignore = harnessHome()
    writeFileSync(defaultIgnore(ignore), readFileSync(defaultIgnore(ignore), 'utf8').split('\n').filter((line) => line.trim() !== '.aspira/').join('\n'))
    kit(['package-dir'], { home: ignore })
    expect(readFileSync(defaultIgnore(ignore), 'utf8').split('\n').map((line) => line.trim())).toContain('.aspira/')

    const retired = harnessHome()
    mkdirSync(join(skillsDir(retired), 'aspira-spec-reviewer'))
    kit(['package-dir'], { home: retired })
    expect(existsSync(join(skillsDir(retired), 'aspira-spec-reviewer'))).toBe(false)

    const current = harnessHome()
    const files = [...SKILL_NAMES.map((name) => join(skillsDir(current), `aspira-${name}`, '.kit-version')), settingsFile(current), defaultIgnore(current)]
    const mtimes = files.map((file) => statSync(file).mtimeMs)
    kit(['package-dir'], { home: current })
    expect(files.map((file) => statSync(file).mtimeMs)).toEqual(mtimes)
  })

  it('T10: a harness that cannot be written only warns on stderr, and the command still answers', () => {
    const home = homeWithCache(null)
    writeFileSync(join(home, '.claude'), 'a file where the folder should be')
    const result = kit(['package-dir'], { home })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${KIT_PACKAGE_DIR}\n`)
    expect(result.stderr).toMatch(/warn/i)
    expect(result.stderr).toMatch(/harness/i)
    expect(result.stderr).toContain('.claude')
  })

  it('T11: two kit commands at once leave one complete harness and no temp folders', async () => {
    const home = homeWithCache(null)
    const [one, two] = await Promise.all([kitAsync(['package-dir'], home), kitAsync(['package-dir'], home)])
    for (const result of [one, two]) {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${KIT_PACKAGE_DIR}\n`)
    }
    expect(readdirSync(skillsDir(home)).sort()).toEqual(SKILL_NAMES.map((name) => `aspira-${name}`))
    for (const name of SKILL_NAMES) {
      const dir = join(skillsDir(home), `aspira-${name}`)
      expect(existsSync(join(dir, 'SKILL.md')), name).toBe(true)
      expect(existsSync(join(dir, 'scripts', `${name}.sh`)), name).toBe(true)
      expect(versionOf(home, name), name).toBe(ownVersion())
    }
  })

  it('T12: ~/.claude/CLAUDE.md is never written or touched', () => {
    const project = fixtureProject()
    const stub = stubBin()
    const withFile = homeWithCache(null)
    mkdirSync(join(withFile, '.claude'), { recursive: true })
    const claudeMd = join(withFile, '.claude', 'CLAUDE.md')
    writeFileSync(claudeMd, 'sentinel line\n')
    const bytes = readFileSync(claudeMd)
    const mtime = statSync(claudeMd).mtimeMs
    const without = homeWithCache(null)
    for (const home of [withFile, without]) {
      kit(['update'], { home, cwd: project, env: stub.env })
      kit(['package-dir'], { home, cwd: project })
      kit(['doctor', '--cwd', project], { home })
    }
    expect(readFileSync(claudeMd).equals(bytes)).toBe(true)
    expect(statSync(claudeMd).mtimeMs).toBe(mtime)
    expect(existsSync(join(without, '.claude', 'CLAUDE.md'))).toBe(false)
  })
})

describe('global harness doctor check', () => {
  const lines = (output: string): string[] => output.split('\n')

  it('T13: doctor reports the harness ok when current, and names each missing hook or skill when it cannot be repaired', () => {
    const project = gitProject()
    const healthy = kit(['doctor', '--cwd', project], { home: homeWithCache(null) })
    const ok = lines(healthy.stdout).filter((line) => line.startsWith('ok'))
    for (const name of SKILL_NAMES) expect(ok.some((line) => line.includes(`~/.claude/skills/aspira-${name}`)), name).toBe(true)
    for (const hook of HOOK_NAMES) expect(ok.some((line) => line.includes(hook)), hook).toBe(true)
    expect(ok.some((line) => line.includes('~/.claude/settings.json'))).toBe(true)
    expect(ok.some((line) => line.includes('git/ignore'))).toBe(true)

    const noHooks = homeWithCache(null)
    mkdirSync(join(noHooks, '.claude'), { recursive: true })
    writeFileSync(join(noHooks, '.claude', 'hooks'), 'a file where the folder should be')
    const blockedHooks = kit(['doctor', '--cwd', project], { home: noHooks })
    expect(blockedHooks.code).not.toBe(0)
    for (const hook of HOOK_NAMES) {
      expect(lines(blockedHooks.stdout).some((line) => line.startsWith('FAIL') && line.includes(hook) && line.includes('missing')), hook).toBe(true)
    }

    const noSkills = homeWithCache(null)
    mkdirSync(join(noSkills, '.claude'), { recursive: true })
    writeFileSync(join(noSkills, '.claude', 'skills'), 'a file where the folder should be')
    const blockedSkills = kit(['doctor', '--cwd', project], { home: noSkills })
    expect(blockedSkills.code).not.toBe(0)
    for (const name of SKILL_NAMES) {
      expect(lines(blockedSkills.stdout).some((line) => line.startsWith('FAIL') && line.includes(`~/.claude/skills/aspira-${name}`) && line.includes('missing')), name).toBe(true)
    }
  })
})

describe('global-only resolution', () => {
  it('T15: a kit still installed in the project is never consulted: neither doctor nor next names it, and the skills are compared with the running kit', () => {
    const project = fixtureProject()
    const copy = join(project, 'node_modules', '@aspiralabs', 'ai')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: '0.1.0' }))
    const home = homeWithCache(null)
    const doctor = kit(['doctor', '--cwd', project], { home })
    const next = kit(['next', 'KIT-1', '--cwd', project], { home })
    for (const output of [doctor.stdout + doctor.stderr, next.stdout + next.stderr]) expect(output).not.toContain(copy)
    expect(doctor.stdout).not.toContain('0.1.0')
    const skillLines = doctor.stdout.split('\n').filter((line) => line.includes('~/.claude/skills/aspira-'))
    expect(skillLines.length).toBe(11)
    expect(skillLines.every((line) => line.startsWith('ok'))).toBe(true)
  })
})

describe('kit doctor outside an Aspira repo', () => {
  it('T26: says the tier-3 deny hook does not apply in a git repository with no aspira.json', () => {
    const project = temp('plain-repo')
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0', private: true }))
    execFileSync('git', ['init', '-q', project])
    const result = kit(['doctor', '--cwd', project], { home: homeWithCache(null) })
    expect(result.stdout).toMatch(/tier-3 deny hook does not apply/)
    // And inside an Aspira repo the same line is not printed.
    const aspira = kit(['doctor', '--cwd', gitProject()], { home: homeWithCache(null) })
    expect(aspira.stdout).not.toMatch(/tier-3 deny hook does not apply/)
  })
})
