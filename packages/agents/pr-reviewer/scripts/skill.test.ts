import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-pr-reviewer/scripts/pr-reviewer.sh')
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(root, 'node_modules/amaro/dist/register-strip.mjs')
const eve = join(root, 'node_modules/eve/bin/eve.js')
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

// A node that records its arguments (one per line), and a screen that runs the job in the foreground.
async function stubs(withScreen: boolean) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pr-review-skill-')))
  const repo = join(dir, 'repo with spaces')
  const bin = join(dir, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', '-q', repo])
  if (withScreen) await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  // Every node call is appended as one line, its arguments separated by a unit separator: the
  // estimate first, then the eve invoke.
  await writeFile(join(bin, 'node'), '#!/bin/bash\nprintf \'%s\\x1f\' "$@" >> "$CAPTURE"\nprintf \'\\n\' >> "$CAPTURE"\necho "{}"\n', { mode: 0o755 })
  const capture = join(dir, 'arguments')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, PR_REVIEWER_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: withScreen ? 'test' : '' }
  const calls = async (): Promise<string[][]> => {
    const lines = (await readFile(capture, 'utf8')).split('\n').filter(Boolean)
    await writeFile(capture, '')
    return lines.map((line) => command(line.split('\x1f').slice(0, -1)))
  }
  const captured = async (): Promise<string[]> => (await calls()).at(-1)!
  return { dir, repo, env, captured, calls }
}

it('starts the eve agent detached, with the PR, the caps, the budget and the comment choice in its prompt, after printing the estimate', async () => {
  const { dir, repo, env, captured, calls } = await stubs(true)
  const started = await exec('bash', [launcher, 'start', 'https://github.com/acme/app/pull/7', '--max-rounds', '2', '--max-cost', '2.5', '--no-comment'], { cwd: repo, env })
  const [estimate, args] = await calls()
  // The estimate runs first, from the same agent with the same node, with the source and the cap; the invoke follows.
  expect(estimate).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/estimate.ts'), 'https://github.com/acme/app/pull/7', '--max-rounds', '2'])
  expect(args!.slice(0, 5)).toEqual(['--import', loader, '--experimental-strip-types', eve, 'invoke'])
  expect(args![5]).toContain('Review https://github.com/acme/app/pull/7')
  expect(args![5]).toContain('cap it at 2 rounds')
  expect(args![5]).toContain('stop at $2.5')
  expect(args![5]).toContain('Do not comment on the PR')
  expect(started.stdout).toContain('agent: @aspiralabs/pr-reviewer@')
  expect(started.stderr).toContain(`pr-reviewer: running kit source at ${root}, not the installed @aspiralabs/pr-reviewer`)
  await expect(exec('bash', [launcher, 'start', '.', '--max-cost', '0'], { cwd: repo, env })).rejects.toThrow('--max-cost')

  // --yes skips the estimate; --since names the previous review in the prompt.
  const previous = join(dir, 'previous')
  await mkdir(previous)
  await writeFile(join(previous, 'findings.md'), '# Findings\n')
  await exec('bash', [launcher, 'start', 'acme/app#7', '--yes', '--since', previous], { cwd: repo, env })
  const [only] = await calls()
  expect(only!.slice(0, 5)).toEqual(['--import', loader, '--experimental-strip-types', eve, 'invoke'])
  expect(only![5]).toContain(`Review acme/app#7 again, since the previous review in ${previous}`)
  await expect(exec('bash', [launcher, 'start', '.', '--since', join(dir, 'nowhere')], { cwd: repo, env })).rejects.toThrow('has no findings.md')
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('finished')
  expect(status.stdout).toContain('agent: @aspiralabs/pr-reviewer@')
  expect((await exec('bash', [launcher, 'wait', run, '--max', '1'], { cwd: repo, env })).stdout).toContain('finished')

  await exec('bash', [launcher, 'start', '.', '--branch', 'feat/x', '--base', 'develop'], { cwd: repo, env })
  const local = await captured()
  expect(local[5]).toContain(`Review the branch feat/x in ${repo} against develop`)
  await expect(exec('bash', [launcher, 'start', '.', '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
  await expect(exec('bash', [launcher, 'start', '.', '--knowledge', 'rules'], { cwd: repo, env })).rejects.toThrow('--knowledge is for local')
})

it('steps a --local review synchronously, with no screen, no gateway key and no estimate, passing absolute paths', async () => {
  const { dir, repo, env, captured, calls } = await stubs(false)
  await mkdir(join(repo, 'prev'))
  await writeFile(join(repo, 'prev', 'findings.md'), '# Findings\n')
  await exec('bash', [launcher, 'local', '.', '--branch', 'feat/x', '--base', 'main', '--max-rounds', '3', '--max-cost', '4', '--since', 'prev', '--no-comment', '--output', 'out', '--knowledge', 'rules'], { cwd: repo, env })
  const local = await calls()
  expect(local).toHaveLength(1)
  expect(local[0]).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), repo, '--branch', 'feat/x', '--base', 'main', '--max-rounds', '3', '--max-cost', '4', '--since', join(repo, 'prev'), '--no-comment', '--output', join(repo, 'out'), '--knowledge', join(repo, 'rules')])
  await exec('bash', [launcher, 'local', 'acme/app#7', '--finish'], { cwd: dir, env })
  expect(await captured()).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), 'acme/app#7', '--finish'])
  await expect(exec('bash', [launcher, 'local'], { cwd: repo, env })).rejects.toThrow('usage')
  await expect(exec('bash', [launcher, 'local', '.', '--max-rounds', 'x'], { cwd: repo, env })).rejects.toThrow('--max-rounds')
})

it('resolves the agent in order: PR_REVIEWER_AGENT_DIR, the package installed under the project, then its own location; never $ASPIRA_KIT', async () => {
  const { dir, env, captured } = await stubs(false)
  const app = join(dir, 'app')
  const store = join(app, 'node_modules/.pnpm/@aspiralabs+agents@9.9.9/node_modules')
  const installed = join(store, '@aspiralabs/pr-reviewer')
  for (const [name, path] of [['@aspiralabs/agents', join(store, '@aspiralabs/agents')], ['@aspiralabs/pr-reviewer', installed]] as const) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '9.9.9' }, null, 2))
  }
  await mkdir(join(installed, 'scripts'))
  await writeFile(join(installed, 'scripts/local.ts'), '')
  await mkdir(join(store, 'amaro/dist'), { recursive: true })
  await writeFile(join(store, 'amaro/dist/register-strip.mjs'), '')
  await mkdir(join(app, 'node_modules/@aspiralabs'), { recursive: true })
  await symlink(join(store, '@aspiralabs/agents'), join(app, 'node_modules/@aspiralabs/agents'))
  await writeFile(join(app, 'package.json'), '{"name":"app"}')
  await exec('git', ['init', '-q', app])
  const copy = join(app, '.claude/skills/aspira-pr-reviewer/scripts/pr-reviewer.sh')
  await cp(launcher, copy)
  const fromApp = await exec('bash', [copy, 'local', '.'], { cwd: app, env: { ...env, ASPIRA_KIT: join(dir, 'stale-kit') } })
  expect(await captured()).toEqual(['--import', join(store, 'amaro/dist/register-strip.mjs'), '--experimental-strip-types', join(installed, 'scripts/local.ts'), app])
  expect(fromApp.stderr).not.toContain('kit source')
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere)
  await exec('git', ['init', '-q', elsewhere])
  const own = await exec('bash', [launcher, 'local', '.'], { cwd: elsewhere, env })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(own.stderr).toContain(`pr-reviewer: running kit source at ${root}, not the installed @aspiralabs/pr-reviewer`)
  const override = await exec('bash', [copy, 'local', '.'], { cwd: app, env: { ...env, PR_REVIEWER_AGENT_DIR: root } })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(override.stderr).toContain(`PR_REVIEWER_AGENT_DIR is set: running kit source at ${root}`)
})
