// T42, T43, T44 (F38, F39, F52): `kit doctor` does not resolve any Notion URL today (doctor.ts has
// no such check at all) and reads no NOTION_TOKEN. This file is the contract P25 implements:
//
// `doctor(projectRoot, log, appFlag?, options?)` gains a fourth, optional `options` argument:
// `{ check?: UrlChecker; env?: Record<string, string | undefined> }`. `check` defaults to the real
// Notion lookup (agent-common's `checkNotionUrls`, through the installed package, the way `next()`
// spawns the board resolver); tests inject a stub so nothing touches the network. `env` defaults to
// `process.env` and lets a test pass a token explicitly instead of mutating the real environment.
//
// Doctor resolves every Notion URL key present in aspira.json — `board`, `releases`, `glossary`,
// `decisions` once those keys exist — and never `repository`, `app` or `models`. `board` resolves
// as a `database` (or `data_source` for a `collection://` value); every other key resolves as a
// `page`. The checker is called once with every `{ key, url, kind }` to resolve. A result that
// failed (401/403/404) is a FAIL line naming the key, the URL and the status; a result Notion could
// not reach (429, 5xx, a network error, or no token) is reported as "not checked: ..." and does not
// add to doctor's problem count. The token check itself (A10) looks at, in order, the process
// environment, the app's `.env.local`, then the project root's `.env.local` (the app's wins over
// the root's, matching `next.ts`'s existing precedence) and fails doctor, naming the files, when no
// token is set anywhere.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { readApp } from './aspira.js'
import { doctor, mcpServer, type UrlCheckResult, type UrlChecker } from './doctor.js'
import { writeGlobalHarness } from './skills.js'

const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const RELEASES = 'https://www.notion.so/3f13e59b22588106ab5dc457a42b0e1c'
const TOKEN = 'ntn_secretvalue'

type Check = Parameters<UrlChecker>[0][number]
type CheckResult = UrlCheckResult

let root: string
/** A temp home holding a current global harness (written by the kit's own writer), so doctor's harness check passes and these suites test the Notion and package checks. */
let home: string

// The kit packages are declared at it; @aspiralabs/ai is the running package (the global install), so every skill is pinned to its version.
const KIT_VERSION = '0.9.0'
const AI_VERSION = (JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')) as { version: string }).version

/** A project kit init has fully set up, so every one of doctor's other checks passes and its exit
 * code turns on the Notion and token checks alone: ui and config declared and installed, the kit's
 * eslint, tsconfig, tokens and .mcp.json. The harness is global now (a temp `home`), so the project
 * has no .claude folder. `declared` is what package.json declares. */
function project(config: Record<string, unknown>, declared: string[] = ['@aspiralabs/ui', '@aspiralabs/config']) {
  root = mkdtempSync(join(tmpdir(), 'kit-doctor-notion-'))
  const kit = Object.fromEntries(declared.map((name) => [name, KIT_VERSION]))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: kit }))
  writeFileSync(join(root, 'aspira.json'), JSON.stringify(config))
  const app = readApp(root)
  for (const name of declared) {
    mkdirSync(join(root, 'node_modules', '@aspiralabs', name.split('/')[1]!), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@aspiralabs', name.split('/')[1]!, 'package.json'), JSON.stringify({ name, version: KIT_VERSION }))
  }
  writeFileSync(join(root, 'eslint.config.mjs'), "export { default } from '@aspiralabs/config/eslint'\n")
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: '@aspiralabs/config/tsconfig' }))
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(join(root, 'app', 'globals.css'), '@import "@aspiralabs/ui/tokens.css";\n')
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'aspiralabs-ui': app ? mcpServer(app) : { command: 'npx', args: ['--no', 'aspiralabs-ui-mcp'] } } }))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'kit-doctor-home-')))
  writeGlobalHarness({ home })
  return root
}

function logs() {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

describe('kit doctor checks aspira.json\'s Notion URLs (T42, F38)', () => {
  let seen: Check[][]
  let round: number
  const stub: UrlChecker = (checks) => {
    seen.push(checks)
    round += 1
    const out: Record<string, CheckResult> = {}
    for (const { key } of checks) {
      if (round === 1) out[key] = key === 'releases' ? { ok: false, status: 404, reason: 'Could not find page' } : { ok: true }
      else out[key] = key === 'board' ? { ok: false, unreachable: true, reason: 'rate limited' } : { ok: false, unreachable: true, reason: 'network error: ECONNRESET' }
    }
    return out
  }

  beforeEach(() => {
    seen = []
    round = 0
    project({ board: BOARD, releases: RELEASES, repository: 'aspiralabs/nomnomzz', app: '.' })
    writeFileSync(join(root, '.env.local'), `NOTION_TOKEN=${TOKEN}\n`)
  })

  it('fails the 404 key, naming it, its URL and the status', () => {
    const { lines, log } = logs()
    const code = doctor(root, log, undefined, { home, check: stub })
    expect(lines.some((line) => line.startsWith('FAIL') && line.includes('releases') && line.includes(RELEASES) && line.includes('404'))).toBe(true)
    // The project is otherwise healthy, so that 404 is the one problem doctor fails on.
    expect(lines.filter((line) => line.startsWith('FAIL'))).toHaveLength(1)
    expect(code).toBe(1)
  })

  it('reports a rate limit or a network error as "not checked: Notion unreachable (...)" without failing doctor', () => {
    doctor(root, logs().log, undefined, { home, check: stub }) // round 1, to advance the stub
    const { lines, log } = logs()
    const code = doctor(root, log, undefined, { home, check: stub })
    expect(lines.some((line) => /not checked: Notion unreachable \(.*\)/.test(line) && line.includes('board'))).toBe(true)
    expect(lines.some((line) => line.startsWith('FAIL') && line.includes('board'))).toBe(false)
    expect(code).toBe(0)
  })

  it('checks the board URL as a database and passes it; repository and app are never sent to the checker', () => {
    const { log } = logs()
    doctor(root, log, undefined, { home, check: stub })
    const keys = seen.flat().map((check) => check.key)
    expect(keys).toContain('board')
    expect(keys).not.toContain('repository')
    expect(keys).not.toContain('app')
    expect(seen.flat().find((check) => check.key === 'board')?.kind).toBe('database')
  })

  it('never prints the token, and never a response line longer than one line', () => {
    const { lines, log } = logs()
    doctor(root, log, undefined, { home, check: stub })
    expect(lines.some((line) => line.includes(TOKEN))).toBe(false)
    expect(lines.every((line) => !line.includes('\n'))).toBe(true)
  })
})

describe('kit doctor only checks the keys aspira.json names (T43, F39)', () => {
  it('checks only board when releases, glossary and decisions are absent, and does not fail doctor for them', () => {
    project({ board: BOARD })
    const seen: Check[][] = []
    const stub: UrlChecker = (checks) => {
      seen.push(checks)
      return Object.fromEntries(checks.map(({ key }) => [key, { ok: true }]))
    }
    const { lines, log } = logs()
    doctor(root, log, undefined, { home, check: stub })
    const keys = seen.flat().map((check) => check.key)
    expect(keys).toEqual(['board'])
    expect(lines.some((line) => line.startsWith('FAIL') && /releases|glossary|decisions/.test(line))).toBe(false)
  })
})

describe('kit doctor checks NOTION_TOKEN, in order: process env, the app\'s .env.local, the root\'s (T44, F52)', () => {
  const okChecker: UrlChecker = (checks) => Object.fromEntries(checks.map(({ key }) => [key, { ok: false, unreachable: true, reason: 'no NOTION_TOKEN' }]))

  function appProject() {
    project({ board: BOARD, app: 'apps/web' })
    mkdirSync(join(root, 'apps', 'web'), { recursive: true })
    writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }))
  }

  it('fails, naming the process environment, apps/web/.env.local and .env.local, when no token is set anywhere, and says the URL checks are "not checked: no NOTION_TOKEN"', () => {
    appProject()
    const { lines, log } = logs()
    doctor(root, log, undefined, { home, check: okChecker, env: {} })
    const tokenFail = lines.find((line) => line.startsWith('FAIL') && line.includes('NOTION_TOKEN'))
    expect(tokenFail).toBeDefined()
    expect(tokenFail).toEqual(expect.stringContaining('apps/web/.env.local'))
    expect(tokenFail).toEqual(expect.stringContaining('.env.local'))
    expect(lines.some((line) => line.includes('not checked: no NOTION_TOKEN'))).toBe(true)
  })

  it('names apps/web/.env.local as the source when the token is only there', () => {
    appProject()
    writeFileSync(join(root, 'apps', 'web', '.env.local'), `NOTION_TOKEN=${TOKEN}\n`)
    const { lines, log } = logs()
    doctor(root, log, undefined, { home, check: okChecker, env: {} })
    expect(lines.some((line) => line.includes('ok') && line.includes('apps/web/.env.local') && line.includes('NOTION_TOKEN'))).toBe(true)
  })

  it("names the app's .env.local over the root's when both set it, differently", () => {
    appProject()
    writeFileSync(join(root, '.env.local'), 'NOTION_TOKEN=ntn_root\n')
    writeFileSync(join(root, 'apps', 'web', '.env.local'), 'NOTION_TOKEN=ntn_app\n')
    const { lines, log } = logs()
    doctor(root, log, undefined, { home, check: okChecker, env: {} })
    expect(lines.some((line) => line.includes('apps/web/.env.local') && !line.includes('ntn_'))).toBe(true)
    expect(lines.some((line) => /\bsources? *root.*\.env\.local\b/i.test(line))).toBe(false)
  })

  it('names the process environment over either file when it is set there too', () => {
    appProject()
    writeFileSync(join(root, '.env.local'), 'NOTION_TOKEN=ntn_root\n')
    writeFileSync(join(root, 'apps', 'web', '.env.local'), 'NOTION_TOKEN=ntn_app\n')
    const { lines, log } = logs()
    doctor(root, log, undefined, { home, check: okChecker, env: { NOTION_TOKEN: 'ntn_env' } })
    expect(lines.some((line) => line.includes('ok') && /process environment/i.test(line) && line.includes('NOTION_TOKEN'))).toBe(true)
  })
})

describe('kit doctor checks the kit packages, with @aspiralabs/ai global (T8, F3)', () => {
  const env = { NOTION_TOKEN: TOKEN }
  const check: UrlChecker = (checks) => Object.fromEntries(checks.map(({ key }) => [key, { ok: true } as CheckResult]))
  const run = (declared?: string[]) => {
    project({ board: BOARD }, declared)
    const { lines, log } = logs()
    return { code: doctor(root, log, undefined, { home, check, env }), lines }
  }

  it('T45: passes a healthy project with no project .claude folder and names neither @aspiralabs/kit nor @aspiralabs/agents', () => {
    const { code, lines } = run()
    expect(code).toBe(0)
    expect(lines.filter((line) => line.includes('@aspiralabs/kit') || line.includes('@aspiralabs/agents'))).toEqual([])
    expect(lines.filter((line) => line.startsWith('ok   .claude/skills/aspira-'))).toEqual([])
  })

  it('names the global @aspiralabs/ai, fails while the project declares it, and fails when ui or config is missing', () => {
    expect(run().lines).toContain(`${'@aspiralabs/ai'.padEnd(20)} global ${AI_VERSION}`)
    const projectCopy = run(['@aspiralabs/ui', '@aspiralabs/config', '@aspiralabs/ai'])
    expect(projectCopy.code).not.toBe(0)
    expect(projectCopy.lines).toContain('FAIL @aspiralabs/ai is in package.json; it is installed globally now: pnpm remove @aspiralabs/ai, then kit init')
    expect(run(['@aspiralabs/config']).lines).toContain('missing @aspiralabs/ui')
    expect(run(['@aspiralabs/ui']).lines).toContain('missing @aspiralabs/config')
    expect(run(['@aspiralabs/ui']).code).not.toBe(0)
  })

  it('never asks for the 0.15 packages a project may still declare', () => {
    const { lines } = run(['@aspiralabs/ui', '@aspiralabs/config', '@aspiralabs/kit', '@aspiralabs/agents'])
    expect(lines.some((line) => line.startsWith('missing') && (line.includes('@aspiralabs/kit') || line.includes('@aspiralabs/agents')))).toBe(false)
  })
})
