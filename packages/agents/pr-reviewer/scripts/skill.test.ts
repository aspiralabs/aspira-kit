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
  // Every pnpm call is appended, one JSON line each: the estimate first, then the eve invoke.
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n")\nconsole.log("{}")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.jsonl')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, PR_REVIEWER_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: withScreen ? 'test' : '' }
  const calls = async (): Promise<string[][]> => {
    const lines = (await readFile(capture, 'utf8')).trim().split('\n')
    await writeFile(capture, '')
    return lines.map((line) => JSON.parse(line))
  }
  const captured = async (): Promise<string[]> => (await calls()).at(-1)!
  return { dir, repo, env, captured, calls }
}

it('starts the eve agent detached, with the PR, the caps, the budget and the comment choice in its prompt, after printing the estimate', async () => {
  const { dir, repo, env, captured, calls } = await stubs(true)
  const started = await exec('bash', [launcher, 'start', 'https://github.com/acme/app/pull/7', '--max-rounds', '2', '--max-cost', '2.5', '--no-comment'], { cwd: repo, env })
  const [estimate, args] = await calls()
  // The estimate runs first, from the same package, with the source and the cap; the invoke follows.
  expect(estimate).toEqual(['-C', root, '--silent', 'run', 'review:estimate', 'https://github.com/acme/app/pull/7', '--max-rounds', '2'])
  expect(args!.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(args![5]).toContain('Review https://github.com/acme/app/pull/7')
  expect(args![5]).toContain('cap it at 2 rounds')
  expect(args![5]).toContain('stop at $2.5')
  expect(args![5]).toContain('Do not comment on the PR')
  await expect(exec('bash', [launcher, 'start', '.', '--max-cost', '0'], { cwd: repo, env })).rejects.toThrow('--max-cost')

  // --yes skips the estimate; --since names the previous review in the prompt.
  const previous = join(dir, 'previous')
  await mkdir(previous)
  await writeFile(join(previous, 'findings.md'), '# Findings\n')
  await exec('bash', [launcher, 'start', 'acme/app#7', '--yes', '--since', previous], { cwd: repo, env })
  const [only] = await calls()
  expect(only!.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(only![5]).toContain(`Review acme/app#7 again, since the previous review in ${previous}`)
  await expect(exec('bash', [launcher, 'start', '.', '--since', join(dir, 'nowhere')], { cwd: repo, env })).rejects.toThrow('has no findings.md')
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('finished')
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
  expect(local[0]).toEqual(['-C', root, '--silent', 'run', 'review:local', repo, '--branch', 'feat/x', '--base', 'main', '--max-rounds', '3', '--max-cost', '4', '--since', join(repo, 'prev'), '--no-comment', '--output', join(repo, 'out'), '--knowledge', join(repo, 'rules')])
  await exec('bash', [launcher, 'local', 'acme/app#7', '--finish'], { cwd: dir, env })
  expect(await captured()).toEqual(['-C', root, '--silent', 'run', 'review:local', 'acme/app#7', '--finish'])
  await expect(exec('bash', [launcher, 'local'], { cwd: repo, env })).rejects.toThrow('usage')
  await expect(exec('bash', [launcher, 'local', '.', '--max-rounds', 'x'], { cwd: repo, env })).rejects.toThrow('--max-rounds')
})
