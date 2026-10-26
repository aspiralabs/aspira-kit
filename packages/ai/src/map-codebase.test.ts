// KIT-69 (T24-T29): `kit map-codebase` run from the built dist/cli.js as a child process on a temp HOME, as
// cli.test.ts runs the other commands. The fixtures are small git repositories; the aspira.json walk-up
// crosses the git root into a client folder, and `kit doctor` prints one information line about the map.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkAspira, readAspira, resolveProjectRoot } from './aspira.js'
import { writeGlobalHarness } from './skills.js'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const BOARD = 'https://www.notion.so/Board-0123456789abcdef0123456789abcdef'

const dirs: string[] = []
const temp = (name: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `map-codebase-${name}-`)))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function kit(args: string[], opts: { home: string; cwd: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home, USERPROFILE: opts.home, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'KIT_REEXEC', 'ASPIRA_KIT_REEXEC']) delete env[key]
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd, env, encoding: 'utf8', timeout: 120_000 })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` }
}

/** A committed git repository at `root` holding a two-file TypeScript program. */
function gitRepo(root: string): string {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }))
  writeFileSync(join(root, 'src', 'a.ts'), "import { b } from './b'\nexport const a = b + 1\n")
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1\n')
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root })
  return root
}
const status = (root: string): string => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
const home = (): string => temp('home')

describe('kit map-codebase', () => {
  it('T24: builds the in-repo map with no aspira.json, and the ported cartographer commands that are not kept exit non-zero with usage', () => {
    const repo = gitRepo(temp('repo'))
    const h = home()
    const built = kit(['map-codebase'], { home: h, cwd: repo })
    expect(built.code, built.output).toBe(0)
    expect(existsSync(join(repo, '.codebase-map', 'map', 'manifest.json'))).toBe(true)
    for (const command of ['mcp', 'view', 'slice', 'impact']) {
      const refused = kit(['map-codebase', command], { home: h, cwd: repo })
      expect(refused.code, command).not.toBe(0)
      expect(refused.output, command).toMatch(/usage/i)
    }
  })

  it('T25: with codebaseMaps in the nearest aspira.json above the repo, the map and notes go to the client folder and the repo is untouched', () => {
    const client = temp('client')
    writeFileSync(join(client, 'aspira.json'), JSON.stringify({ codebaseMaps: '.codebase-maps' }))
    const repo = gitRepo(join(client, 'loantrack-web'))
    const before = status(repo)
    const built = kit(['map-codebase'], { home: home(), cwd: repo })
    expect(built.code, built.output).toBe(0)
    const root = join(client, '.codebase-maps', 'loantrack-web')
    expect(existsSync(join(root, 'map', 'manifest.json'))).toBe(true)
    expect(existsSync(join(root, 'notes'))).toBe(true)
    expect(status(repo)).toBe(before)
    expect(existsSync(join(repo, '.codebase-map'))).toBe(false)
  })

  it('T26: a bad codebaseMaps key or a file that is not JSON stops the command, names aspira.json and writes nothing', () => {
    const bodies = ['{ not json', JSON.stringify({ codebaseMaps: 3 }), 'ABSOLUTE', JSON.stringify({ codebaseMaps: '../outside' }), JSON.stringify({ codebaseMaps: 'loantrack-web/maps' })]
    for (const body of bodies) {
      const top = temp('bad-key')
      const client = join(top, 'client')
      mkdirSync(client)
      const absolute = join(top, 'abs-maps')
      writeFileSync(join(client, 'aspira.json'), body === 'ABSOLUTE' ? JSON.stringify({ codebaseMaps: absolute }) : body)
      const repo = gitRepo(join(client, 'loantrack-web'))
      const result = kit(['map-codebase'], { home: home(), cwd: repo })
      expect(result.code, body).not.toBe(0)
      expect(result.output, body).toContain('aspira.json')
      if (!body.startsWith('{ not')) expect(result.output, body).toContain('codebaseMaps')
      expect(readdirSync(top).sort(), body).toEqual(['client'])
      expect(readdirSync(client).sort(), body).toEqual(['aspira.json', 'loantrack-web'])
      expect(existsSync(join(repo, '.codebase-map')), body).toBe(false)
      expect(existsSync(join(repo, 'maps')), body).toBe(false)
    }
  })

  it('T27: outside a git repository it writes nothing and lists the repositories below, without node_modules; an empty folder says none were found', () => {
    const folder = temp('no-repo')
    gitRepo(join(folder, 'repo-a'))
    gitRepo(join(folder, 'group', 'repo-b'))
    mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true })
    execFileSync('git', ['init', '-q', join(folder, 'node_modules', 'x')])
    const result = kit(['map-codebase'], { home: home(), cwd: folder })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('repo-a')
    expect(result.output).toContain('group/repo-b')
    expect(result.output).not.toContain('node_modules/x')
    for (const where of [folder, join(folder, 'repo-a'), join(folder, 'group', 'repo-b')]) expect(existsSync(join(where, '.codebase-map'))).toBe(false)

    const empty = temp('empty')
    const none = kit(['map-codebase'], { home: home(), cwd: empty })
    expect(none.code).not.toBe(0)
    expect(none.output).toMatch(/no git repos/i)
    expect(readdirSync(empty)).toEqual([])
  })
})

describe('today\'s aspira.json readers (F7)', () => {
  /** A project with a board and an app, in a git repo, the way kit init leaves it. */
  function appProject(config: Record<string, unknown>): string {
    const root = gitRepo(temp('app'))
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true })
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web', private: true }))
    writeFileSync(join(root, 'aspira.json'), JSON.stringify(config))
    return root
  }

  it('T28: resolveProjectRoot, readAspira and checkAspira answer as before, and kit doctor has no problem about a map or codebaseMaps', () => {
    const root = appProject({ board: BOARD, app: 'apps/web' })
    expect(resolveProjectRoot(join(root, 'apps', 'web', 'src'))).toBe(root)
    expect(readAspira(root)).toEqual({ board: BOARD, app: 'apps/web' })
    expect(checkAspira(root)).toEqual({ ok: true })

    const noBoard = appProject({ app: 'apps/web' })
    const failed = checkAspira(noBoard)
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain('board')
    const mapsNoBoard = appProject({ codebaseMaps: '.maps' })
    expect(checkAspira(mapsNoBoard).ok).toBe(false)
    expect(readAspira(mapsNoBoard)).toEqual({ codebaseMaps: '.maps' })

    const h = home()
    writeGlobalHarness({ home: h })
    const doctor = kit(['doctor', '--cwd', root], { home: h, cwd: root })
    expect(doctor.stdout).not.toContain('codebaseMaps')
    const problems = doctor.stdout.split('\n').filter((line) => /^(FAIL|WARN)/.test(line) && /\bmap\b|codebaseMaps/i.test(line))
    expect(problems).toEqual([])
  })

  it('T29: kit doctor prints exactly one map line naming missing, fresh or stale and the map root, and its exit code does not change', () => {
    const outcomes: Array<{ state: string; code: number | null; line: string }> = []
    for (const state of ['missing', 'fresh', 'stale']) {
      const root = appProject({ board: BOARD })
      const h = home()
      writeGlobalHarness({ home: h })
      if (state !== 'missing') expect(kit(['map-codebase'], { home: h, cwd: root }).code, state).toBe(0)
      if (state === 'stale') writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')
      const doctor = kit(['doctor', '--cwd', root], { home: h, cwd: root })
      // the installed-skill check line for aspira-map-codebase is not the map status line
      const lines = doctor.stdout.split('\n').filter((line) => /\bmap\b/i.test(line) && !line.includes('~/.claude/skills/aspira-map-codebase'))
      expect(lines, `${state}: ${doctor.stdout}`).toHaveLength(1)
      expect(lines[0], state).toMatch(new RegExp(`\\b${state}\\b`, 'i'))
      expect(lines[0], state).toContain('.codebase-map')
      outcomes.push({ state, code: doctor.code, line: lines[0] ?? '' })
    }
    expect(new Set(outcomes.map((outcome) => outcome.code)).size, JSON.stringify(outcomes)).toBe(1)
  })
})
