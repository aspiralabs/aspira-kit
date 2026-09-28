import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skillDir = join(root, 'agent/skills/aspira-implement')
const exec = promisify(execFile)

it('is one skill file for Claude Code and eve, carrying every step of the contract', async () => {
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^---\nname: aspira-implement\ndescription: .+\n---\n/)
  for (const step of ['## 1. Resolve the input and gate it', '## 2. Load the standards', '## 3. Draft the plan', '## 4. Analyze the plan and decide how to parallelize', '## 5. Execute', '## 6. Final verification', '## 7. Progress log and report', '### Remote repositories']) expect(skill).toContain(step)
  for (const term of ['needs-author', 'incomplete', 'Agent Instructions', 'load-knowledge', 'trace/guidelines.md', 'WRITE SCOPE', 'Hot files', '--max-parallel', 'Spec: <path>', 'implementation.md', 'publish-branch', '**A plan**', '**A spec**', '**A ticket**', 'Ticket: <key or URL>', 'scripts/implement-remote.sh', '## Run to completion', 'Assumptions', 'A leading `@`']) expect(skill).toContain(term)
})

it('is what the Claude Code skill link resolves to, when installed', async () => {
  const link = join(homedir(), '.claude/skills/aspira-implement')
  const target = await realpath(link).catch(() => null)
  if (target === null) return
  expect(target).toBe(await realpath(skillDir))
})

it('launches the cloud agent for remote repositories with a repo-relative source', async () => {
  const launcher = join(skillDir, 'scripts/implement-remote.sh')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-skill-')))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("stub run completed")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, IMPLEMENTOR_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test' }
  const started = await exec('bash', [launcher, 'start', 'aspiralabs/nomnomzz', 'docs/plans/my feature/plan.review', '--ref', 'develop'], { cwd: dir, env })
  const args = JSON.parse(await readFile(capture, 'utf8')) as string[]
  expect(args.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(args[5]).toContain('Implement docs/plans/my feature/plan.review in the GitHub repository aspiralabs/nomnomzz, starting from branch develop.')
  expect(args[5]).toContain('do not open a pull request')
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  expect((await exec('bash', [launcher, 'wait', run, '--max', '5'], { env })).stdout).toContain('finished')
  await exec('bash', [launcher, 'start', 'https://github.com/aspiralabs/nomnomzz', 'specs/x.md', '--pr'], { cwd: dir, env })
  expect(JSON.parse(await readFile(capture, 'utf8')).at(-1)).toContain('open a draft pull request')
  await expect(exec('bash', [launcher, 'start', '/Users/me/repo', 'specs/x.md'], { cwd: dir, env })).rejects.toThrow('not a GitHub repository')
  await expect(exec('bash', [launcher, 'start', 'aspiralabs/nomnomzz', '/abs/specs/x.md'], { cwd: dir, env })).rejects.toThrow('path inside the repository')
})
