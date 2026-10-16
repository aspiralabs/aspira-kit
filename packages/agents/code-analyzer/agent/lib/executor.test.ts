// Pins F52: the Notion token is for the knowledge walk only. Analyzer commands are project code
// (eslint configs, tsc plugins, test scripts), so the host executor runs them without the
// credentials build-feature's gate unsets (packages/agents/build-feature/src/gate.ts CREDENTIALS
// plus every *_TOKEN/_SECRET/_KEY/_PASSWORD variable).

import { mkdtemp, rm } from 'node:fs/promises'
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
