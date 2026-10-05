import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-pr-reviewer/scripts/pr-reviewer.sh')

// A pnpm that records its arguments, and a screen that runs the job in the foreground.
async function stubs(withScreen: boolean) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pr-review-skill-')))
  const repo = join(dir, 'repo with spaces')
  const bin = join(dir, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', '-q', repo])
  if (withScreen) await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("{}")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, PR_REVIEWER_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: withScreen ? 'test' : '' }
  const captured = async (): Promise<string[]> => JSON.parse(await readFile(capture, 'utf8'))
  return { dir, repo, env, captured }
}

it('starts the eve agent detached, with the PR, the caps and the comment choice in its prompt', async () => {
  const { repo, env, captured } = await stubs(true)
  const started = await exec('bash', [launcher, 'start', 'https://github.com/acme/app/pull/7', '--max-rounds', '2', '--no-comment'], { cwd: repo, env })
  const args = await captured()
  expect(args.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(args[5]).toContain('Review https://github.com/acme/app/pull/7')
  expect(args[5]).toContain('cap it at 2 rounds')
  expect(args[5]).toContain('Do not comment on the PR')
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('finished')
  expect((await exec('bash', [launcher, 'wait', run, '--max', '1'], { cwd: repo, env })).stdout).toContain('finished')

  await exec('bash', [launcher, 'start', '.', '--branch', 'feat/x', '--base', 'develop'], { cwd: repo, env })
  const local = await captured()
  expect(local[5]).toContain(`Review the branch feat/x in ${repo} against develop`)
  await expect(exec('bash', [launcher, 'start', '.', '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
})

it('steps a --local review synchronously, with no screen and no gateway key, passing absolute paths', async () => {
  const { dir, repo, env, captured } = await stubs(false)
  await exec('bash', [launcher, 'local', '.', '--branch', 'feat/x', '--base', 'main', '--max-rounds', '3', '--no-comment', '--output', 'out'], { cwd: repo, env })
  expect(await captured()).toEqual(['-C', root, '--silent', 'run', 'review:local', repo, '--branch', 'feat/x', '--base', 'main', '--max-rounds', '3', '--no-comment', '--output', join(repo, 'out')])
  await exec('bash', [launcher, 'local', 'acme/app#7', '--finish'], { cwd: dir, env })
  expect(await captured()).toEqual(['-C', root, '--silent', 'run', 'review:local', 'acme/app#7', '--finish'])
  await expect(exec('bash', [launcher, 'local'], { cwd: repo, env })).rejects.toThrow('usage')
  await expect(exec('bash', [launcher, 'local', '.', '--max-rounds', 'x'], { cwd: repo, env })).rejects.toThrow('--max-rounds')
})
