// T41 (F19, F13): the eight launchers inside a client layout. A client root (not a git repository) holds aspira.json
// with `repos`, a .env.local with the Notion token, and the mapped repos; a repo's own .env.local must never reach the
// agent. The launchers run under bash with a stub `node` that records its --env-file arguments and the NOTION_TOKEN
// those files would give it (later files win, as Node loads them), and a stub `kit` that names this package.
// build-feature.sh also starts at the non-git client root and hands the driver that root. In the default project
// (a git repo with its own aspira.json) the --env-file list is today's. NOTION_TOKEN is not in the launchers' shell.

import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const AI = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const launcher = (name: string) => join(AI, name, 'skill', `aspira-${name}`, 'scripts', `${name}.sh`)
// The six agents' `local KIT-11`, visual-verify's `local KIT-11 --status ...`, build-feature's `local KIT-11`.
const LAUNCHERS: { name: string; args: string[] }[] = [
  ...['groomer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer'].map((name) => ({ name, args: ['local', 'KIT-11'] })),
  { name: 'visual-verify', args: ['local', 'KIT-11', '--status', 'In Progress: Implementation'] },
  { name: 'build-feature', args: ['local', 'KIT-11'] },
]

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

// node: records its arguments and the token its --env-file arguments give it, then exits 0.
const STUB_NODE = `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const { parseEnv } = require('node:util')
const args = process.argv.slice(2)
const envFiles = args.filter((arg) => arg.startsWith('--env-file=')).map((arg) => arg.slice('--env-file='.length))
let token = process.env.NOTION_TOKEN ?? null
for (const file of envFiles) {
  try {
    const value = parseEnv(readFileSync(file, 'utf8')).NOTION_TOKEN
    if (value !== undefined && process.env.NOTION_TOKEN === undefined) token = value
  } catch {}
}
appendFileSync(process.env.CAPTURE, JSON.stringify({ args, envFiles, token }) + '\\n')
`

type Call = { args: string[]; envFiles: string[]; token: string | null }

async function sandbox() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'client-launcher-')))
  temps.push(dir)
  const bin = join(dir, 'bin')
  const capture = join(dir, 'calls.jsonl')
  await mkdir(bin)
  await writeFile(join(bin, 'node'), STUB_NODE, { mode: 0o755 })
  await writeFile(join(bin, 'kit'), `#!/bin/sh\n[ "$1" = package-dir ] && echo '${AI}'\nexit 0\n`, { mode: 0o755 })
  const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, ...rest } = process.env
  const env = { ...rest, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, HOME: dir, BUILD_FEATURE_AGENT_DIR: '' }
  return { dir, env, calls: async (): Promise<Call[]> => (await readFile(capture, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Call) }
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args])

/** The non-git client root, its .env.local (client), and the mapped repo web/ with its own .env.local (repo). */
async function clientLayout(dir: string) {
  const root = join(dir, 'client')
  const web = join(root, 'web')
  await mkdir(web, { recursive: true })
  await writeFile(join(root, 'aspira.json'), JSON.stringify({ statusFlow: false, pullRequest: false, repos: { web: { path: 'web' } } }))
  await writeFile(join(root, '.env.local'), 'NOTION_TOKEN=client\n')
  await writeFile(join(web, 'package.json'), '{"name":"web","private":true}\n')
  await writeFile(join(web, '.env.local'), 'NOTION_TOKEN=repo\n')
  git(web, 'init', '-q', '-b', 'main')
  return { root, web }
}

const run = (name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  exec('bash', [launcher(name), ...args], { cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
  )

/** The calls that ran an agent script (a .ts file), where the env files matter. */
const scripts = (calls: Call[]) => calls.filter((call) => call.args.some((arg) => arg.endsWith('.ts')))

describe('T41 F19: the launchers inside a client layout', () => {
  it.each(LAUNCHERS)('$name run inside the repo gives the agent the client token and never the repo one', async ({ name, args }) => {
    const { dir, env, calls } = await sandbox()
    const { root, web } = await clientLayout(dir)
    const outcome = await run(name, args, web, env)
    const seen = scripts(await calls())
    expect({
      ran: seen.length > 0,
      tokens: [...new Set(seen.map((call) => call.token))],
      repoFile: seen.some((call) => call.envFiles.includes(join(web, '.env.local'))),
      clientFile: seen.every((call) => call.envFiles.includes(join(root, '.env.local'))),
      output: seen.length > 0 ? '' : outcome.output,
    }).toEqual({ ran: true, tokens: ['client'], repoFile: false, clientFile: true, output: '' })
  })
})

describe('T41 F13: build-feature.sh at the non-git client root', () => {
  it('starts and passes the client root as --repo, with the client token', async () => {
    const { dir, env, calls } = await sandbox()
    const { root } = await clientLayout(dir)
    const outcome = await run('build-feature', ['local', 'KIT-11'], root, env)
    const seen = scripts(await calls())
    const driver = seen[0]
    expect({
      code: outcome.code,
      repo: driver?.args[driver.args.indexOf('--repo') + 1],
      token: driver?.token,
      refused: /run inside a Git repo/i.test(outcome.output),
    }).toEqual({ code: 0, repo: root, token: 'client', refused: false })
  })
})

describe('T41 F19: the default project keeps today\'s env files', () => {
  it.each(LAUNCHERS)('$name loads the project .env.local, and no client file', async ({ name, args }) => {
    const { dir, env, calls } = await sandbox()
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad' }))
    await writeFile(join(repo, '.env.local'), 'NOTION_TOKEN=default\n')
    await run(name, args, repo, env)
    const seen = scripts(await calls())
    expect({ ran: seen.length > 0, envFiles: [...new Set(seen.map((call) => call.envFiles.join('|')))], token: [...new Set(seen.map((call) => call.token))] }).toEqual({
      ran: true,
      envFiles: [join(repo, '.env.local')],
      token: ['default'],
    })
  })
})
