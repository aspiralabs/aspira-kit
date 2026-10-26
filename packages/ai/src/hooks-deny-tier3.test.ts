// T6 (F1, F8), T28 (F6): the real hooks/deny-tier3.sh run with sh, fed the JSON a PreToolUse hook receives on stdin.
// A denial is exit 2 with "DENIED (tier 3): <what>" on stderr; an allowed command prints nothing and exits 0.
// The hooks speak only inside an Aspira project (aspira.json at the git root); anywhere else they are silent.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HOOKS = ['deny-tier3.sh', 'audit-log.sh', 'session-start.sh']
const hook = (name: string): string => fileURLToPath(new URL(`../hooks/${name}`, import.meta.url))
const HOOK = hook('deny-tier3.sh')

const dirs: string[] = []
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ai-deny-${name}-`))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  spawnSync('git', args, { cwd, encoding: 'utf8' })
}

function runHook(command: string, script = HOOK, options: { project?: string; home?: string; path?: string } = {}) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
  let project = options.project
  if (!project) {
    project = temp('project')
    git(project, 'init', '-q')
    writeFileSync(join(project, 'aspira.json'), '{}\n')
  }
  const home = options.home ?? temp('home')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project }
  delete env.XDG_CONFIG_HOME
  if (options.path) env.PATH = options.path
  const result = spawnSync('sh', [script], { input: payload, cwd: project, env, encoding: 'utf8', timeout: 30_000 })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('deny-tier3.sh database migrations', () => {
  it.each([
    'prisma migrate dev --name add_x',
    'prisma migrate reset',
    'prisma migrate deploy',
    'prisma migrate status',
    'prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma',
    'prisma migrate resolve --applied 20260101_init',
    'pnpm prisma migrate dev',
    'prisma db push',
  ])('T6: denies "%s" as a database migration', (command) => {
    const result = runHook(command)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('DENIED (tier 3): database migration')
  })

  it('T6: allows kit db migrate --name add_x with no output and exit 0', () => {
    const result = runHook('kit db migrate --name add_x')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})

describe('hooks outside an Aspira project', () => {
  it('T28: a git repository without aspira.json inside a folder that has one: all three hooks are silent and write nothing', () => {
    const parent = temp('parent')
    writeFileSync(join(parent, 'aspira.json'), '{}\n')
    const repo = join(parent, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    const bin = temp('bin')
    const calls = join(bin, 'calls.log')
    writeFileSync(join(bin, 'kit'), `#!/bin/sh\necho "$@" >> "${calls}"\n`)
    chmodSync(join(bin, 'kit'), 0o755)
    const path = [bin, process.env.PATH].join(':')
    const home = temp('home')
    for (const name of HOOKS) {
      const result = runHook('prisma migrate reset', hook(name), { project: repo, home, path })
      expect(result.code, name).toBe(0)
      expect(result.stdout, name).toBe('')
      expect(result.stderr, name).toBe('')
    }
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('')
    expect(existsSync(join(repo, '.aspira'))).toBe(false)
  })
})
