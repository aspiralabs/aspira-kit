// KIT-68 (T45, T46): `kit doctor` from the built dist/cli.js (run `pnpm build:kit` first, as for map-codebase.test.ts) at a
// client root and beside a stray parent aspira.json.
//
// Contract these tests pin for the implementation: an aspira.json with `repos` that doctor reads from its own folder is a
// client root. Doctor then checks the client keys, their confinement, the guidelines folder (REV-001 in some file) and every
// extend file, and that no Aspira file inside a mapped repo is tracked by git; it skips the board, Notion and @aspiralabs
// package checks. Each failing check prints a FAIL line naming the offending path or key, and the exit code is 1. Run in a
// git repo that a parent folder's aspira.json does not map, doctor prints a line naming that ignored file.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeGlobalHarness } from './skills.js'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const BOARD = 'https://www.notion.so/Board-0123456789abcdef0123456789abcdef'

const dirs: string[] = []
let home: string
const temp = (name: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `doctor-client-${name}-`)))
  dirs.push(dir)
  return dir
}
beforeAll(() => {
  home = temp('home')
  writeGlobalHarness({ home })
})
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function kitDoctor(cwd: string): { code: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'KIT_REEXEC', 'ASPIRA_KIT_REEXEC']) delete env[key]
  const result = spawnSync(process.execPath, [CLI, 'doctor'], { cwd, env, encoding: 'utf8', timeout: 120_000 })
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  return dir
}

/** A non-git client root with a valid client aspira.json, a guidelines folder holding REV-001, one extend file and a work root; `config` overrides keys. */
function clientRoot(config: Record<string, unknown> = {}): string {
  const root = temp('client')
  gitRepo(join(root, 'web'))
  mkdirSync(join(root, 'rules'))
  writeFileSync(join(root, 'rules', 'review.md'), '**REV-001 — MUST** verify every finding.\n')
  mkdirSync(join(root, 'ext'))
  writeFileSync(join(root, 'ext', 'planner.md'), 'Plan for the client.\n')
  mkdirSync(join(root, 'work'))
  writeFileSync(join(root, 'aspira.json'), JSON.stringify({ statusFlow: false, repos: { web: { path: 'web' } }, guidelines: 'rules', workRoot: 'work', extend: { planner: ['ext/planner.md'] }, ...config }))
  return root
}

describe('kit doctor at a client root (T45)', () => {
  it('passes a valid client root and prints no board or @aspiralabs package check', () => {
    const { code, output } = kitDoctor(clientRoot())
    expect(output).not.toMatch(/FAIL/)
    expect(output).not.toMatch(/board/i)
    expect(output).not.toMatch(/@aspiralabs\/(ui|config)/)
    expect(code).toBe(0)
  })

  it('fails a guidelines folder with no REV-001, naming the folder', () => {
    const root = clientRoot()
    writeFileSync(join(root, 'rules', 'review.md'), 'No rule ids here.\n')
    const { code, output } = kitDoctor(root)
    expect([code, /FAIL.*REV-001/.test(output), /guidelines/.test(output)]).toEqual([1, true, true])
  })

  it('fails a missing extend file, naming it', () => {
    const { code, output } = kitDoctor(clientRoot({ extend: { planner: ['ext/gone.md'] } }))
    expect([code, /FAIL.*ext\/gone\.md/.test(output)]).toEqual([1, true])
  })

  it('fails an absolute workRoot, naming the key', () => {
    const { code, output } = kitDoctor(clientRoot({ workRoot: '/tmp/elsewhere' }))
    expect([code, /FAIL.*workRoot/.test(output)]).toEqual([1, true])
  })

  it('fails case-duplicate repos keys, naming both', () => {
    const { code, output } = kitDoctor(clientRoot({ repos: { Web: { path: 'web' }, web: { path: 'web' } } }))
    expect([code, /FAIL.*Web/.test(output), /FAIL.*\bweb\b/.test(output)]).toEqual([1, true, true])
  })

  it('fails a mapped repo that tracks aspira.json, naming the file', () => {
    const root = clientRoot()
    writeFileSync(join(root, 'web', 'aspira.json'), '{}\n')
    execFileSync('git', ['add', 'aspira.json'], { cwd: join(root, 'web') })
    const { code, output } = kitDoctor(root)
    expect([code, /FAIL.*web[\\/]aspira\.json/.test(output)]).toEqual([1, true])
  })
})

/** A repo with the files a product repo has, a board-only aspira.json and a global harness the doctor accepts. */
function productRepo(dir: string): string {
  gitRepo(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@aspiralabs/ui': '0.1.0', '@aspiralabs/config': '0.1.0' } }))
  writeFileSync(join(dir, 'aspira.json'), JSON.stringify({ board: BOARD }))
  return dir
}

describe('kit doctor beside a stray parent aspira.json (T46)', () => {
  it('reports the ignored aspira.json in a repo the parent file does not map', () => {
    const parent = temp('parent')
    gitRepo(join(parent, 'web'))
    writeFileSync(join(parent, 'aspira.json'), JSON.stringify({ repos: { web: { path: 'web' } } }))
    const other = gitRepo(join(parent, 'other'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other' }))
    const { output } = kitDoctor(other)
    expect(output).toMatch(new RegExp(`ignor.*${join(parent, 'aspira.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))
  })

  it('prints a product repo\'s output as it is without the parent file', () => {
    const alone = productRepo(join(temp('alone'), 'product'))
    const parent = temp('nested')
    gitRepo(join(parent, 'web'))
    writeFileSync(join(parent, 'aspira.json'), JSON.stringify({ repos: { web: { path: 'web' } } }))
    const nested = productRepo(join(parent, 'product'))
    const normalize = (text: string, root: string): string => text.split(root).join('<ROOT>')
    const a = kitDoctor(alone)
    const b = kitDoctor(nested)
    expect(normalize(b.output, nested)).toBe(normalize(a.output, alone))
    expect(b.output).not.toContain(join(parent, 'aspira.json'))
    expect(b.code).toBe(a.code)
  })
})
