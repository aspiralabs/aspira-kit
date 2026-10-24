// T26-T27 (F7, F8): the built dist/cli.js (CI's prepare builds it, as for playbook-export.test.ts) run as a
// child process. The version-check cache is a JSON file under <HOME>/.cache/aspiralabs/version-check.json
// shaped { checkedAt: <ms>, latest: '<x.y.z>', notified: {} }. No network is needed: the cached answer
// is fresh, and the no-cache homes have no token, so no request is made.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home, USERPROFILE: opts.home, ...opts.env }
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
    expect(last).toContain('pnpm add -g @aspiralabs/ai@latest')

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

describe('re-exec', () => {
  it("T27: inside a project the project's copy runs once with the same arguments and its exit code wins", () => {
    const project = fixtureProject()
    stubKit(project)
    const result = kit(['doctor'], { home: homeWithCache(null), cwd: project })
    expect(result.code).toBe(7)
    expect(result.stdout.match(/project-kit doctor/g)).toHaveLength(1)
  })

  it("T27: in an --app project the app's copy runs", () => {
    const project = temp('app-project')
    writeFileSync(join(project, 'aspira.json'), JSON.stringify({ board: BOARD, app: 'apps/web' }))
    mkdirSync(join(project, 'apps', 'web'), { recursive: true })
    writeFileSync(join(project, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', private: true }))
    stubKit(join(project, 'apps', 'web'))
    const result = kit(['doctor'], { home: homeWithCache(null), cwd: project })
    expect(result.code).toBe(7)
    expect(result.stdout).toContain('project-kit doctor')
  })

  it('T27: outside a project the running copy answers, and a project copy that is the running file is not re-executed', () => {
    const empty = temp('empty')
    const outside = kit(['playbook'], { home: homeWithCache(null), cwd: empty })
    expect(outside.code).toBe(0)
    expect(outside.stdout.length).toBeGreaterThan(0)
    expect(outside.stdout).not.toContain('project-kit')

    const project = fixtureProject()
    mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true })
    symlinkSync(CLI, join(project, 'node_modules', '.bin', 'kit'))
    const self = kit(['playbook'], { home: homeWithCache(null), cwd: project })
    expect(self.code).toBe(0)
    expect(self.stdout).toBe(outside.stdout)
  })
})
