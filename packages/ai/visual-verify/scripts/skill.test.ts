// The launcher skill/aspira-visual-verify/scripts/visual-verify.sh driven with a PATH shim that
// records every node call. NOTION_TOKEN is emptied and VISUAL_VERIFY_AGENT_DIR is empty, so the
// launcher finds the package itself and no path through it reaches Notion.
// KIT-58 plan P4: T30.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-visual-verify/scripts/visual-verify.sh')

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A project with aspira.json, and a bin directory whose node only records that it ran. */
async function sandbox() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'visual-verify-skill-')))
  temps.push(dir)
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  const capture = join(dir, 'calls')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', '-q', repo])
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad' }))
  // The launcher runs only the global kit: a `kit` on PATH whose package-dir names this package.
  await writeFile(join(bin, 'kit'), `#!/bin/sh\n[ "$1" = package-dir ] && echo '${dirname(root)}'\nexit 0\n`, { mode: 0o755 })
  await writeFile(join(bin, 'node'), '#!/bin/bash\necho "node $*" >> "$CAPTURE"\necho \'{}\'\n', { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, VISUAL_VERIFY_AGENT_DIR: '', NOTION_TOKEN: '', NOTION_API_KEY: '' }
  return { repo, env, calls: () => readFile(capture, 'utf8').catch(() => '') }
}

const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  exec('bash', [launcher, ...args], { cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
  )

describe('T30 F16 F17: the launcher', () => {
  it('runs node on scripts/local.ts for local, with --repo set to the repository', async () => {
    const { repo, env, calls } = await sandbox()
    const outcome = await run(['local', 'KIT-9', '--status', 'In Progress: Implementation'], repo, env)
    const words = ((await calls()).split('\n').find((entry) => entry.startsWith('node ')) ?? '').split(' ')
    expect({ code: outcome.code, driver: words.some((word) => word.endsWith('scripts/local.ts')), repo: words[words.indexOf('--repo') + 1] }).toEqual({ code: 0, driver: true, repo })
  })

  it('refuses start naming local, and never calls node', async () => {
    const { repo, env, calls } = await sandbox()
    const outcome = await run(['start', 'KIT-9'], repo, env)
    expect({ failed: outcome.code !== 0, namesLocal: /\blocal\b/.test(outcome.output), calls: await calls() }).toEqual({ failed: true, namesLocal: true, calls: '' })
  })
})
