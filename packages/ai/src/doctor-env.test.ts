// KIT-67 in `kit doctor` (T28, T29): with database, webhooks or a placeholder dev.url in aspira.json,
// doctor counts a missing .env.development.local ignore line, prints advisory warn lines for the keys and
// tools the isolation needs (NEON_API_KEY, CLOUDFLARE_API_TOKEN, cloudflared, the login cert, the Stripe
// CLI) that never change its exit code, and lists Stripe endpoints tagged for a worktree that no longer
// exists. Without those keys its output and exit code are today's.
//
// Contract these tests pin for the implementation: `doctor(projectRoot, log, appFlag?, options?)` reads
// `options.env` for NEON_API_KEY, CLOUDFLARE_API_TOKEN, STRIPE_SECRET_KEY, PATH and HOME, and takes
// `options.seams` (the isolation module's seams; only `stripe` is used, to list endpoints). The Stripe
// seam is a synchronous process runner, so doctor stays synchronous.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readApp } from './aspira.js'
import { doctor, hookCommand, mcpServer } from './doctor.js'
import { ISOLATION_CONFIG, startMocks, type Mocks } from './isolation-mocks.test.js'
import { AGENTS, HOOKS, installHooks, KIT_SKILLS, VERSION_FILE } from './skills.js'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const KIT_VERSION = '0.9.0'
const AI_VERSION = (JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')) as { version: string }).version
const IGNORE = ['.work/', '.aspira/', '.worktrees/', '.env.local']

/**
 * A project kit init has fully set up, in a git repository, so every other doctor check passes and the
 * exit code turns on the isolation checks alone. `ignore` is the .gitignore body.
 */
function project(config: Record<string, unknown>, ignore: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-doctor-env-')))
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@aspiralabs/ui': KIT_VERSION, '@aspiralabs/config': KIT_VERSION } }))
  writeFileSync(join(root, 'aspira.json'), JSON.stringify({ board: BOARD, ...config }))
  const app = readApp(root)
  for (const name of ['ui', 'config']) {
    mkdirSync(join(root, 'node_modules', '@aspiralabs', name), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@aspiralabs', name, 'package.json'), JSON.stringify({ name: `@aspiralabs/${name}`, version: KIT_VERSION }))
  }
  writeFileSync(join(root, 'eslint.config.mjs'), "export { default } from '@aspiralabs/config/eslint'\n")
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: '@aspiralabs/config/tsconfig' }))
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(join(root, 'app', 'globals.css'), '@import "@aspiralabs/ui/tokens.css";\n')
  writeFileSync(join(root, 'AGENTS.md'), '<!-- aspiralabs:begin -->\n<!-- aspiralabs:end -->\n')
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': app ? mcpServer(app) : { command: 'npx', args: ['--no', 'aspiralabs-ui-mcp'] } } }))
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: HOOKS.map((name) => ({ command: hookCommand(name) })) }] } }))
  installHooks({ projectRoot: root, dryRun: false, log: () => {} })
  writeFileSync(join(root, '.gitignore'), `${ignore.join('\n')}\n`)
  for (const agent of [...AGENTS, ...KIT_SKILLS]) {
    const dir = join(root, '.claude', 'skills', `aspira-${agent}`)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: aspira-${agent}\n---\n`)
    writeFileSync(join(dir, 'scripts', `${agent}.sh`), '#!/bin/bash\n')
    writeFileSync(join(dir, VERSION_FILE), `${AI_VERSION}\n`)
  }
  return root
}

/** An environment with Notion set up and nothing else: no Neon, Cloudflare or Stripe key, and a PATH and HOME holding none of their tools. */
function bareEnv(): Record<string, string> {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'kit-doctor-env-empty-')))
  mkdirSync(join(empty, 'bin'))
  mkdirSync(join(empty, 'home'))
  return { NOTION_TOKEN: 'ntn_test', PATH: join(empty, 'bin'), HOME: join(empty, 'home') }
}

const notion = { check: (checks: { key: string }[]) => Object.fromEntries(checks.map(({ key }) => [key, { ok: true as const }])) }

function run(root: string, options: Record<string, unknown>): { code: number; lines: string[] } {
  const lines: string[] = []
  // Built apart from the call so the optional `seams` key does not trip the options type before the kit has it.
  const full = { ...notion, ...options }
  const code = doctor(root, (line) => lines.push(line), undefined, full)
  return { code, lines }
}

const isFail = (line: string): boolean => line.startsWith('FAIL')
const mentions = (lines: string[], pattern: RegExp): string[] => lines.filter((line) => pattern.test(line))

describe('kit doctor with isolation keys in aspira.json (T28, F1 F6 F27)', () => {
  it('T28 prints a warn line for each missing key and tool, none prefixed FAIL, and fails only for the missing ignore line', () => {
    const root = project(ISOLATION_CONFIG, IGNORE)
    const { code, lines } = run(root, { env: bareEnv() })
    // One warn line each; the cloudflared line is the one that is not about the login cert.
    const wanted: [RegExp, (line: string) => boolean][] = [
      [/NEON_API_KEY/, () => true],
      [/CLOUDFLARE_API_TOKEN/, () => true],
      [/cloudflared/, (line) => !/cert\.pem/.test(line)],
      [/cert\.pem/, () => true],
      [/\bstripe\b/i, () => true],
    ]
    for (const [pattern, keep] of wanted) {
      const found = mentions(lines, pattern).filter((line) => keep(line) && !/\.env\.development\.local/.test(line))
      expect(found.length, String(pattern)).toBeGreaterThan(0)
      expect(found.every((line) => !isFail(line)), String(pattern)).toBe(true)
    }
    const fails = lines.filter(isFail)
    expect(fails).toHaveLength(1)
    expect(fails[0]).toContain('.env.development.local')
    expect(code).toBe(1)
  })

  it('T28 the warn lines leave the exit code as it was: with the ignore line present doctor is healthy', () => {
    const root = project(ISOLATION_CONFIG, [...IGNORE, '.env.development.local'])
    const { code, lines } = run(root, { env: bareEnv() })
    expect(mentions(lines, /NEON_API_KEY/).length).toBeGreaterThan(0)
    expect(lines.filter(isFail)).toEqual([])
    expect(lines.at(-1)).toBe('healthy')
    expect(code).toBe(0)
  })

  it('T28 stays silent about a key that is set and a tool that is installed', () => {
    const root = project(ISOLATION_CONFIG, [...IGNORE, '.env.development.local'])
    const env = bareEnv()
    for (const tool of ['cloudflared', 'stripe']) {
      writeFileSync(join(env.PATH!, tool), '#!/bin/sh\nexit 0\n')
      chmodSync(join(env.PATH!, tool), 0o755)
    }
    mkdirSync(join(env.HOME!, '.cloudflared'))
    writeFileSync(join(env.HOME!, '.cloudflared', 'cert.pem'), 'cert\n')
    const { code, lines } = run(root, { env: { ...env, NEON_API_KEY: 'napi_test', CLOUDFLARE_API_TOKEN: 'cf_test' } })
    expect(mentions(lines, /NEON_API_KEY|CLOUDFLARE_API_TOKEN|cloudflared|cert\.pem|stripe/i).filter((line) => !/^ok /.test(line))).toEqual([])
    expect(code).toBe(0)
  })

  it('T28 checks only what the keys ask for: a database entry alone warns about NEON_API_KEY and nothing about Cloudflare or Stripe', () => {
    const root = project({ database: ISOLATION_CONFIG.database }, [...IGNORE, '.env.development.local'])
    const { code, lines } = run(root, { env: bareEnv() })
    expect(mentions(lines, /NEON_API_KEY/).length).toBeGreaterThan(0)
    expect(mentions(lines, /CLOUDFLARE_API_TOKEN|cloudflared|cert\.pem|stripe/i)).toEqual([])
    expect(code).toBe(0)
  })

  it('T28 a project with none of the keys prints nothing about the isolation and exits as today', () => {
    const root = project({}, IGNORE)
    const { code, lines } = run(root, { env: bareEnv() })
    expect(mentions(lines, /NEON_API_KEY|CLOUDFLARE_API_TOKEN|cloudflared|cert\.pem|stripe|env\.development/i)).toEqual([])
    expect(lines.filter(isFail)).toEqual([])
    expect(lines.at(-1)).toBe('healthy')
    expect(code).toBe(0)
  })
})

describe('kit doctor lists stale Stripe endpoints (T29, F28)', () => {
  let mocks: Mocks | undefined
  afterEach(async () => {
    await mocks?.close()
    mocks = undefined
  })

  /** A healthy isolated project with a worktree folder per name in `folders`, and the Stripe seam over `endpoints`. */
  async function stale(folders: string[], tagged: string[]): Promise<string[]> {
    mocks = await startMocks({ pageSize: 2 })
    for (const name of tagged) mocks.seed(name)
    mocks.state.endpoints.splice(1, 0, { id: 'we_untagged', url: 'https://example.test/hook', metadata: {}, secret: 'whsec_u' })
    const root = project(ISOLATION_CONFIG, [...IGNORE, '.env.development.local'])
    for (const folder of folders) mkdirSync(join(root, '.worktrees', folder), { recursive: true })
    const { lines } = run(root, { env: { ...bareEnv(), STRIPE_SECRET_KEY: 'sk_test_x' }, seams: mocks.seams })
    return lines
  }

  it('T29 names only the endpoint whose worktree folder is gone, across pages, and not the live or untagged ones', async () => {
    const lines = await stale(['FEATURE-SCOOP-7'], ['scoop-7', 'kit-9'])
    expect(mentions(lines, /we_seed_kit-9/).length).toBeGreaterThan(0)
    expect(mentions(lines, /we_seed_scoop-7/)).toEqual([])
    expect(mentions(lines, /we_untagged/)).toEqual([])
  })

  it('T29 sorts the stale list by worktree name and matches the folder name case-insensitively', async () => {
    const lines = await stale(['bug-kit-1'], ['kit-9', 'abc-2', 'kit-1'])
    const at = (id: string): number => lines.findIndex((line) => line.includes(id))
    expect(at('we_seed_kit-1')).toBe(-1)
    expect(at('we_seed_abc-2')).toBeGreaterThanOrEqual(0)
    expect(at('we_seed_kit-9')).toBeGreaterThan(at('we_seed_abc-2'))
  })

  it('T29 a stale endpoint is advice: doctor still exits 0 on an otherwise healthy project', async () => {
    mocks = await startMocks()
    mocks.seed('kit-9')
    const root = project(ISOLATION_CONFIG, [...IGNORE, '.env.development.local'])
    const { code, lines } = run(root, { env: { ...bareEnv(), STRIPE_SECRET_KEY: 'sk_test_x' }, seams: mocks.seams })
    expect(lines.filter(isFail)).toEqual([])
    expect(code).toBe(0)
  })
})
