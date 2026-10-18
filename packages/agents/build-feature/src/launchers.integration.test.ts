// The seven step launchers accept --parent-run (KIT-19 plan P7: T33). The build-feature driver
// appends `--parent-run <runId>:<nonce>` to every step command it prints, so each launcher's `local`
// entry must take the option and hand it on, and a value that names no build-feature step of the
// ticket is refused naming the option. Each launcher is run with bash, as the session runs it, from
// its place in this checkout, in a temp git repository with aspira.json and no NOTION_TOKEN, so no
// path reaches Notion.

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOARD, PACKAGE, REPOSITORY } from './driver.test-helper.ts'

const exec = promisify(execFile)
const AGENTS = dirname(PACKAGE)
const LAUNCHERS = ['groomer', 'spec-writer', 'spec-reviewer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer']
const launcher = (name: string) => join(AGENTS, name, 'skill', `aspira-${name}`, 'scripts', `${name}.sh`)

describe('KIT-19 T33 F6 F22: launchers accept --parent-run', () => {
  const outcomes: { name: string; code: number; output: string }[] = []
  let dir = ''

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-launchers-')))
    await exec('git', ['init', '-q', dir])
    await writeFile(join(dir, 'aspira.json'), `${JSON.stringify({ board: BOARD, repository: REPOSITORY }, null, 2)}\n`)
    const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, ...env } = process.env
    for (const name of LAUNCHERS) {
      const outcome = await exec('bash', [launcher(name), 'local', 'KIT-11', '--parent-run', 'bad'], { cwd: dir, env: { ...env, HOME: dir } }).then(
        ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
      )
      outcomes.push({ name, ...outcome })
    }
  }, 300_000)

  afterAll(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  it('reports --parent-run as an unknown option from no launcher', () => {
    expect(outcomes.filter((outcome) => outcome.output.includes('unknown option')).map((outcome) => outcome.name)).toEqual([])
  })

  it('refuses a malformed --parent-run from every launcher, naming the option', () => {
    expect(outcomes.map((outcome) => ({ name: outcome.name, refused: outcome.code !== 0, named: outcome.output.includes('--parent-run') }))).toEqual(LAUNCHERS.map((name) => ({ name, refused: true, named: true })))
  })
})
