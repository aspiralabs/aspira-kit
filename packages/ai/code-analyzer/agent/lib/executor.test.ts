// Pins F52: the Notion token is for the knowledge walk only. Analyzer commands are project code
// (eslint configs, tsc plugins, test scripts), so the host executor runs them without the
// credentials build-feature's gate unsets (packages/ai/build-feature/src/gate.ts CREDENTIALS
// plus every *_TOKEN/_SECRET/_KEY/_PASSWORD variable).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CREDENTIALS, analyzerEnv, hostExecutor } from './executor'

const FAKE = 'fake-credential-value'
const NAMES = ['NOTION_TOKEN', 'NOTION_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_GATEWAY_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'STRIPE_SECRET', 'DB_PASSWORD', 'OPENAI_API_KEY']

const saved = new Map<string, string | undefined>()
const dirs: string[] = []
afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('the analyzer child environment', () => {
  it('names the same fixed credentials as build-feature\'s gate', () => {
    expect([...CREDENTIALS]).toEqual(['NOTION_TOKEN', 'NOTION_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_GATEWAY_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'])
  })

  it('drops every credential and credential-named variable, keeps the rest, and forces CI output', () => {
    const env = analyzerEnv({ ...Object.fromEntries(NAMES.map((name) => [name, FAKE])), PATH: '/usr/bin', HOME: '/home/x', KEYBOARD: 'us' })
    for (const name of NAMES) expect(env[name], name).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', KEYBOARD: 'us', CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' })
  })

  it('a command the host executor runs sees none of the credentials set in this process', async () => {
    for (const name of NAMES) {
      saved.set(name, process.env[name])
      process.env[name] = FAKE
    }
    const root = await mkdtemp(join(tmpdir(), 'ca-exec-env-'))
    dirs.push(root)
    const result = await hostExecutor(root).run('env')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain(FAKE)
    expect(result.stdout).toContain('CI=1')
  })
})

// KIT-67 T36 (F25, spec decision Q1): in an isolated worktree (.worktrees/<HANDLE>-<ID> with aspira.json
// database.envVars and the kit's .env.development.local) a host analyzer command gets the branch database
// variables over the process environment, so it never reaches the shared database; credentials stay dropped.
describe('the analyzer child environment in an isolated worktree', () => {
  const BRANCH_URL = 'postgres://branch'
  const SHARED_URL = 'postgres://shared'

  /** A checkout laid out as the kit leaves a ticket worktree; `isolated` false leaves out the env file and the .worktrees folder. */
  async function checkout(isolated: boolean): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'ca-exec-wt-'))
    dirs.push(base)
    const root = isolated ? join(base, '.worktrees', 'FEATURE-SCOOP-7') : base
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'aspira.json'), JSON.stringify({ database: { provider: 'neon', projectId: 'p', parentBranch: 'dev', envVars: ['DATABASE_URL'] } }))
    if (isolated) await writeFile(join(root, '.env.development.local'), `PORT=3003\nDATABASE_URL=${BRANCH_URL}\n`)
    return root
  }

  const setEnv = (name: string, value: string) => {
    saved.set(name, process.env[name])
    process.env[name] = value
  }

  it('a command run through hostExecutor rooted at the worktree sees the branch DATABASE_URL, not the process one', async () => {
    setEnv('DATABASE_URL', SHARED_URL)
    const result = await hostExecutor(await checkout(true)).run('echo "$DATABASE_URL"')
    expect({ exitCode: result.exitCode, stdout: result.stdout.trim() }).toEqual({ exitCode: 0, stdout: BRANCH_URL })
  })

  it('still drops credential-named variables there', async () => {
    setEnv('DATABASE_URL', SHARED_URL)
    setEnv('NEON_API_KEY', FAKE)
    setEnv('STRIPE_SECRET', FAKE)
    const result = await hostExecutor(await checkout(true)).run('echo "$DATABASE_URL|${NEON_API_KEY-unset}|${STRIPE_SECRET-unset}"')
    expect(result.stdout.trim()).toBe(`${BRANCH_URL}|unset|unset`)
  })

  it('leaves the process DATABASE_URL alone outside an isolated worktree', async () => {
    setEnv('DATABASE_URL', SHARED_URL)
    const result = await hostExecutor(await checkout(false)).run('echo "$DATABASE_URL"')
    expect(result.stdout.trim()).toBe(SHARED_URL)
  })
})
