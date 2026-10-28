// The five kit-owned skill launchers (/aspira-next, /aspira-cleanup, /aspira-worktree, /aspira-upgrade, /aspira-map-codebase), copied under a
// temporary HOME's .claude/skills (where the global harness puts them) and run with bash from inside a
// project. The kit binary they call is the process boundary: a fake `kit` on PATH (the global one) that
// records its arguments, prints fixed lines and exits with the code FAKE_KIT_EXIT names. A second fake in
// the project's node_modules/.bin records into its own file: the launchers never run it (F12).
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const RUN_LINE = 'run      /aspira-planner KIT-12'
const SKILLS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

type Project = { root: string; home: string; bin: string; calls: string; projectCalls: string }

function fakeKit(calls: string): string {
  return ['#!/bin/bash', `printf '%s\\n' "$*" >> '${calls}'`, "echo 'ticket   KIT-12 Fake ticket'", `echo '${RUN_LINE}'`, 'exit "${FAKE_KIT_EXIT:-0}"', ''].join('\n')
}

/**
 * A temp HOME holding the five kit launchers under .claude/skills, a project with aspira.json (and the
 * app folder it names, when `app` is set) as the working directory, a recording `kit` on PATH and a
 * second recording `kit` in the owning folder's node_modules/.bin.
 */
function project(app?: string): Project {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kit-launchers-')))
  tempDirs.push(base)
  const root = join(base, 'project')
  // HOME sits inside the project, so a launcher that looked for the project from its own location would find it and its node_modules kit.
  const home = join(root, '.home')
  const bin = join(base, 'bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(root, { recursive: true })
  for (const name of ['next', 'cleanup', 'worktree', 'upgrade', 'map-codebase']) {
    const target = join(home, '.claude', 'skills', `aspira-${name}`)
    cpSync(join(SKILLS, `aspira-${name}`), target, { recursive: true })
    chmodSync(join(target, 'scripts', `${name}.sh`), 0o755)
  }
  writeFileSync(join(root, 'aspira.json'), JSON.stringify(app === undefined ? { board: BOARD } : { board: BOARD, app }))
  const owner = app === undefined ? root : join(root, app)
  mkdirSync(owner, { recursive: true })
  writeFileSync(join(owner, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  const calls = join(base, 'path-kit-calls.txt')
  writeFileSync(join(bin, 'kit'), fakeKit(calls))
  chmodSync(join(bin, 'kit'), 0o755)
  const projectCalls = join(owner, 'kit-calls.txt')
  const projectBin = join(owner, 'node_modules', '.bin')
  mkdirSync(projectBin, { recursive: true })
  writeFileSync(join(projectBin, 'kit'), fakeKit(projectCalls))
  chmodSync(join(projectBin, 'kit'), 0o755)
  return { root, home, bin, calls, projectCalls }
}

/** Run a launcher the way a skill does: `bash ~/.claude/skills/aspira-<name>/scripts/<name>.sh ...` from the project. */
function launch(made: Project, name: string, args: string[], exitCode: number, cwd = made.root): { status: number | null; stdout: string; stderr: string } {
  const script = join(made.home, '.claude', 'skills', `aspira-${name}`, 'scripts', `${name}.sh`)
  const run = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: made.home, USERPROFILE: made.home, PATH: `${made.bin}:${process.env.PATH ?? ''}`, FAKE_KIT_EXIT: String(exitCode) },
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

const recorded = (calls: string): string[] => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((line) => line !== '') : [])

describe('the /aspira-next launcher', () => {
  it('T57 runs kit next with the ticket, relays its output and exits with its code', () => {
    const made = project()
    const { calls } = made
    const ok = launch(made, 'next', ['KIT-12'], 0)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(RUN_LINE)
    const failed = launch(made, 'next', ['KIT-12'], 1)
    expect(failed.status).toBe(1)
    expect(failed.stdout).toContain(RUN_LINE)
    const bare = launch(made, 'next', [], 0)
    expect(bare.status).toBe(0)
    expect(recorded(calls)).toEqual(['next KIT-12', 'next KIT-12', 'next'])
  })

  it('T43 runs the kit on PATH, not one installed in the project', () => {
    const made = project('apps/web')
    const ok = launch(made, 'next', ['KIT-1'], 0)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(RUN_LINE)
    expect(recorded(made.calls)).toEqual(['next KIT-1'])
    expect(recorded(made.projectCalls)).toEqual([])
  })

  it('T43 runs the kit on PATH from a project with no node_modules kit either', () => {
    const made = project()
    rmSync(join(made.root, 'node_modules'), { recursive: true, force: true })
    const ok = launch(made, 'next', ['KIT-1'], 0)
    expect(ok.status).toBe(0)
    expect(recorded(made.calls)).toEqual(['next KIT-1'])
  })
})

describe('the kit launchers without kit on PATH (KIT-76)', () => {
  it('find the global kit in $PNPM_HOME, and otherwise name the PATH fix in one line', () => {
    const made = project()
    const script = join(made.home, '.claude', 'skills', 'aspira-next', 'scripts', 'next.sh')
    const env = { HOME: made.home, USERPROFILE: made.home, PATH: '/usr/bin:/bin' }
    const found = spawnSync('/bin/bash', [script, 'KIT-1'], { cwd: made.root, encoding: 'utf8', env: { ...env, PNPM_HOME: made.bin } })
    expect(found.status).toBe(0)
    expect(recorded(made.calls)).toEqual(['next KIT-1'])
    const missing = spawnSync('/bin/bash', [script, 'KIT-1'], { cwd: made.root, encoding: 'utf8', env })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr.trim().split('\n')).toHaveLength(1)
    expect(missing.stderr).toContain('export PATH="$HOME/Library/pnpm:$PATH"')
    expect(missing.stderr).toContain('restart Claude Code')
  })
})

describe('the /aspira-cleanup launcher', () => {
  it('T58 passes its arguments to kit cleanup verbatim and exits with its code', () => {
    const made = project()
    const { calls } = made
    const listing = launch(made, 'cleanup', [], 0)
    expect(listing.status).toBe(0)
    const confirmed = launch(made, 'cleanup', ['--yes', '--only', '/p/a', '/p/b'], 1)
    expect(confirmed.status).toBe(1)
    expect(recorded(calls)).toEqual(['cleanup', 'cleanup --yes --only /p/a /p/b'])
  })
})

describe('the /aspira-worktree launcher', () => {
  it('T59 runs kit worktree with the ticket, relays its output and exits with its code', () => {
    const made = project()
    const { calls } = made
    const created = launch(made, 'worktree', ['KIT-13'], 0)
    expect(created.status).toBe(0)
    expect(created.stdout).toContain(RUN_LINE)
    const refused = launch(made, 'worktree', ['KIT-13'], 1)
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain(RUN_LINE)
    expect(recorded(calls)).toEqual(['worktree KIT-13', 'worktree KIT-13'])
  })
})

describe('the /aspira-upgrade launcher', () => {
  it('passes its arguments to kit upgrade verbatim, from inside the app too, and exits with its code', () => {
    const made = project('apps/web')
    const listing = launch(made, 'upgrade', ['--dry-run'], 0, join(made.root, 'apps', 'web'))
    expect(listing.status).toBe(0)
    const applied = launch(made, 'upgrade', [], 1)
    expect(applied.status).toBe(1)
    expect(recorded(made.calls)).toEqual(['upgrade --dry-run', 'upgrade'])
    expect(recorded(made.projectCalls)).toEqual([])
  })

  it('runs in a git repository whose aspira.json a pull deleted, so kit upgrade can restore it, and refuses outside one', () => {
    const made = project()
    rmSync(join(made.root, 'aspira.json'))
    expect(spawnSync('git', ['init', '-q', made.root]).status).toBe(0)
    mkdirSync(join(made.root, 'src'), { recursive: true })
    expect(launch(made, 'upgrade', ['--dry-run'], 0, join(made.root, 'src')).status).toBe(0)
    expect(recorded(made.calls)).toEqual(['upgrade --dry-run'])
    const outside = project()
    rmSync(join(outside.root, 'aspira.json'))
    const refused = launch(outside, 'upgrade', [], 0)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('aspira-upgrade')
    expect(recorded(outside.calls)).toEqual([])
  })
})

describe('the /aspira-map-codebase launcher', () => {
  it('T32 runs in a git repository with no aspira.json, hands its arguments to kit map-codebase and exits with its code; without kit it says so', () => {
    const made = project()
    rmSync(join(made.root, 'aspira.json'))
    expect(spawnSync('git', ['init', '-q', made.root]).status).toBe(0)
    const listing = launch(made, 'map-codebase', ['notes', '--x'], 0)
    expect(listing.status).toBe(0)
    const failed = launch(made, 'map-codebase', [], 3)
    expect(failed.status).toBe(3)
    expect(recorded(made.calls)).toEqual(['map-codebase notes --x', 'map-codebase'])
    expect(recorded(made.projectCalls)).toEqual([])

    // No kit anywhere on PATH: an empty folder is the whole PATH.
    const empty = join(dirname(made.root), 'empty-bin')
    mkdirSync(empty, { recursive: true })
    const script = join(made.home, '.claude', 'skills', 'aspira-map-codebase', 'scripts', 'map-codebase.sh')
    const bare = spawnSync('/bin/bash', [script, 'notes'], { cwd: made.root, encoding: 'utf8', env: { HOME: made.home, USERPROFILE: made.home, PATH: empty } })
    expect(bare.status).not.toBe(0)
    expect(bare.stderr).toMatch(/cannot find kit/i)
  })
})
