// The three kit-owned skill launchers (/aspira-next, /aspira-cleanup, /aspira-worktree), installed
// into a temporary project by installSkills and run with bash. The kit binary they call is the
// process boundary: a fake node_modules/.bin/kit that records its arguments, prints fixed lines and
// exits with the code FAKE_KIT_EXIT names.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installSkills } from './skills.js'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const RUN_LINE = 'run      /aspira-planner KIT-12 --local'

const made: string[] = []

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

type Project = { root: string; calls: string }

/**
 * A project with aspira.json and the kit-owned skills installed, and a fake kit binary in the
 * node_modules of the directory that owns them: the root, or `app` when aspira.json names one.
 */
function project(app?: string): Project {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-launchers-')))
  made.push(root)
  writeFileSync(join(root, 'aspira.json'), JSON.stringify(app === undefined ? { board: BOARD } : { board: BOARD, app }))
  const owner = app === undefined ? root : join(root, app)
  mkdirSync(owner, { recursive: true })
  writeFileSync(join(owner, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  installSkills({ projectRoot: root, ...(app === undefined ? {} : { app }), dryRun: false, log: () => undefined })
  const calls = join(owner, 'kit-calls.txt')
  const bin = join(owner, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const fake = ['#!/bin/bash', `printf '%s\\n' "$*" >> '${calls}'`, "echo 'ticket   KIT-12 Fake ticket'", `echo '${RUN_LINE}'`, 'exit "${FAKE_KIT_EXIT:-0}"', ''].join('\n')
  writeFileSync(join(bin, 'kit'), fake)
  chmodSync(join(bin, 'kit'), 0o755)
  return { root, calls }
}

/** Run a launcher the way a skill does: `bash .claude/skills/aspira-<name>/scripts/<name>.sh ...` from the project root. */
function launch(root: string, name: string, args: string[], exitCode: number): { status: number | null; stdout: string } {
  const script = join('.claude', 'skills', `aspira-${name}`, 'scripts', `${name}.sh`)
  const run = spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FAKE_KIT_EXIT: String(exitCode) } })
  return { status: run.status, stdout: run.stdout }
}

const recorded = (calls: string): string[] => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((line) => line !== '') : [])

describe('the /aspira-next launcher', () => {
  it('T57 runs kit next with the ticket, relays its output and exits with its code', () => {
    const { root, calls } = project()
    const ok = launch(root, 'next', ['KIT-12'], 0)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(RUN_LINE)
    const failed = launch(root, 'next', ['KIT-12'], 1)
    expect(failed.status).toBe(1)
    expect(failed.stdout).toContain(RUN_LINE)
    const bare = launch(root, 'next', [], 0)
    expect(bare.status).toBe(0)
    expect(recorded(calls)).toEqual(['next KIT-12', 'next KIT-12', 'next'])
  })

  it('T57 runs the kit installed under the app aspira.json names', () => {
    const { root, calls } = project('apps/web')
    expect(existsSync(join(root, 'node_modules', '.bin', 'kit'))).toBe(false)
    const ok = launch(root, 'next', ['KIT-12'], 0)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(RUN_LINE)
    expect(recorded(calls)).toEqual(['next KIT-12'])
  })
})

describe('the /aspira-cleanup launcher', () => {
  it('T58 passes its arguments to kit cleanup verbatim and exits with its code', () => {
    const { root, calls } = project()
    const listing = launch(root, 'cleanup', [], 0)
    expect(listing.status).toBe(0)
    const confirmed = launch(root, 'cleanup', ['--yes', '--only', '/p/a', '/p/b'], 1)
    expect(confirmed.status).toBe(1)
    expect(recorded(calls)).toEqual(['cleanup', 'cleanup --yes --only /p/a /p/b'])
  })
})

describe('the /aspira-worktree launcher', () => {
  it('T59 runs kit worktree with the ticket, relays its output and exits with its code', () => {
    const { root, calls } = project()
    const created = launch(root, 'worktree', ['KIT-13'], 0)
    expect(created.status).toBe(0)
    expect(created.stdout).toContain(RUN_LINE)
    const refused = launch(root, 'worktree', ['KIT-13'], 1)
    expect(refused.status).toBe(1)
    expect(refused.stdout).toContain(RUN_LINE)
    expect(recorded(calls)).toEqual(['worktree KIT-13', 'worktree KIT-13'])
  })
})
