// T29, T30 (F6): the real hooks/audit-log.sh and deny-tier3.sh run with sh against temp projects and a temp HOME.
// The audit log is written only where .aspira/ is ignored by git (or there is no git repository).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const AUDIT = fileURLToPath(new URL('../hooks/audit-log.sh', import.meta.url))
const DENY = fileURLToPath(new URL('../hooks/deny-tier3.sh', import.meta.url))

const dirs: string[] = []
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ai-audit-${name}-`))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const gitRepoWithAspira = (): string => {
  const dir = temp('repo')
  spawnSync('git', ['init', '-q', dir])
  writeFileSync(join(dir, 'aspira.json'), '{}\n')
  return dir
}

function homeIgnoring(ignored: boolean): string {
  const home = temp('home')
  if (ignored) {
    mkdirSync(join(home, '.config', 'git'), { recursive: true })
    writeFileSync(join(home, '.config', 'git', 'ignore'), '.aspira/\n')
  }
  return home
}

function run(script: string, project: string, home: string, command: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project }
  delete env.XDG_CONFIG_HOME
  delete env.ASPIRA_AUDIT_LOG
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
  const result = spawnSync('sh', [script], { input, cwd: project, env, encoding: 'utf8', timeout: 30_000 })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean)

describe('audit-log.sh guard and check-ignore', () => {
  it('T29: in a subfolder of the Aspira project, with .aspira/ ignored globally, it logs there and the deny hook still denies', () => {
    const root = gitRepoWithAspira()
    const web = join(root, 'apps', 'web')
    mkdirSync(web, { recursive: true })
    const home = homeIgnoring(true)
    const logged = run(AUDIT, web, home, 'ls')
    expect(logged.code).toBe(0)
    const log = lines(join(web, '.aspira', 'audit.jsonl'))
    expect(log).toHaveLength(1)
    expect(() => JSON.parse(log[0])).not.toThrow()
    const denied = run(DENY, web, home, 'prisma migrate reset')
    expect(denied.code).toBe(2)
    expect(denied.stderr).toContain('DENIED (tier 3)')
  })

  it('T30: (a) with .aspira/ not ignored in a git repository nothing is written and stderr is one line; (b) without a git repository it logs', () => {
    const repo = gitRepoWithAspira()
    const a = run(AUDIT, repo, homeIgnoring(false), 'ls')
    expect(a.code).toBe(0)
    expect(existsSync(join(repo, '.aspira', 'audit.jsonl'))).toBe(false)
    const stderr = a.stderr.split('\n').filter(Boolean)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain('.aspira/')
    expect(stderr[0]).toMatch(/not ignored/)

    const home = homeIgnoring(false)
    const folder = join(home, 'work')
    mkdirSync(folder)
    writeFileSync(join(folder, 'aspira.json'), '{}\n')
    const b = run(AUDIT, folder, home, 'ls')
    expect(b.code).toBe(0)
    expect(lines(join(folder, '.aspira', 'audit.jsonl'))).toHaveLength(1)
  })
})
