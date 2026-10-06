import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { INSTRUCTIONS, PINNED_RULES, PROCEDURE } from './pinned-rules.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skillDir = join(root, 'skill/aspira-implementor')
const launcher = join(skillDir, 'scripts/implementor.sh')
const exec = promisify(execFile)

it('keeps the agent procedure eve loads, carrying every step of the contract', async () => {
  const procedure = await readFile(join(root, PROCEDURE), 'utf8')
  expect(procedure).toMatch(/^---\nname: aspira-implementor\ndescription: .+\n---\n/)
  for (const step of ['## 1. Resolve the input and gate it', '## 2. Load the standards', '## 3. Draft the plan', '## 4. Analyze the plan and decide how to parallelize', '## 5. Execute', '## 6. Final verification', '## 7. Progress log and report']) expect(procedure).toContain(step)
  for (const term of ['needs-author', 'incomplete', 'Agent Instructions', 'load-knowledge', 'trace/guidelines.md', 'WRITE SCOPE', 'Hot files', '--max-parallel', 'Spec: <path>', 'implementation.md', 'publish-branch', '**A plan**', '**A spec**', '**A ticket**', 'Ticket: <key>', '## Run to completion', 'Assumptions', 'A leading `@`']) expect(procedure).toContain(term)
})

it('is a Claude Code skill that only launches the agent or steps --local, and names the agent files as the authority', async () => {
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^---\nname: aspira-implementor\ndescription: .+\nargument-hint: .+\n---\n/)
  expect(skill).toContain(PROCEDURE)
  expect(skill).toContain(INSTRUCTIONS)
  for (const term of ['scripts/implementor.sh start', 'scripts/implementor.sh local', '--local', '`knowledge`', '--guidelines', '--finish', 'general-purpose', 'in one message']) expect(skill).toContain(term)
})

it('restates none of the rules: every pinned rule sentence of the agent files is absent from the skill', async () => {
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  for (const { phrase } of PINNED_RULES) expect(skill).not.toContain(phrase)
  // Nor any long sentence of the procedure: the skill carries mechanics, not a copy.
  const procedure = await readFile(join(root, PROCEDURE), 'utf8')
  const sentences = procedure
    .split(/(?<=[.:])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && !s.startsWith('|') && !s.startsWith('```'))
  for (const sentence of sentences) expect(skill).not.toContain(sentence)
})

it('is what the Claude Code skill link resolves to, when installed', async () => {
  const target = await realpath(join(homedir(), '.claude/skills/aspira-implementor')).catch(() => null)
  // Not installed, or installed from another checkout of the kit (a worktree, the main clone): that checkout's test judges it.
  if (target === null || !target.startsWith(`${await realpath(root)}/`)) return
  expect(target).toBe(await realpath(skillDir))
})

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function stubs() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-skill-')))
  temps.push(dir)
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("stub run completed")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, IMPLEMENTOR_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test' }
  const captured = async (): Promise<string[]> => JSON.parse(await readFile(capture, 'utf8'))
  return { dir, env, captured }
}

const tail = 'Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any.'

it('launches the agent on a GitHub repository with the same prompt the remote launcher always sent', async () => {
  const { dir, env, captured } = await stubs()
  const started = await exec('bash', [launcher, 'start', 'docs/plans/my feature/plan.review', '--repo', 'aspiralabs/nomnomzz', '--ref', 'develop'], { cwd: dir, env })
  const args = await captured()
  expect(args.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  // Byte for byte what implement-remote.sh sent: the default path's prompt is unchanged.
  expect(args[5]).toBe(`Implement docs/plans/my feature/plan.review in the GitHub repository aspiralabs/nomnomzz, starting from branch develop. Follow the aspira-implementor skill. Push the branch; do not open a pull request. ${tail}`)
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  expect((await exec('bash', [launcher, 'wait', run, '--max', '5'], { env })).stdout).toContain('finished')
  await exec('bash', [launcher, 'start', 'specs/x.md', '--repo', 'https://github.com/aspiralabs/nomnomzz', '--pr'], { cwd: dir, env })
  expect((await captured()).at(-1)).toBe(`Implement specs/x.md in the GitHub repository https://github.com/aspiralabs/nomnomzz. Follow the aspira-implementor skill. Push the branch and open a draft pull request. ${tail}`)
  await expect(exec('bash', [launcher, 'start', '/abs/specs/x.md', '--repo', 'aspiralabs/nomnomzz'], { cwd: dir, env })).rejects.toThrow('path inside the repository')
})

it('derives the GitHub repository and branch from a local checkout, and refuses work the agent cannot see', async () => {
  const { dir, env, captured } = await stubs()
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '--bare', origin])
  await exec('git', ['init', '-q', '-b', 'feat/cart', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await mkdir(join(repo, 'specs'))
  await writeFile(join(repo, 'specs/cart.md'), '# Cart\n')
  await git('add', '.')
  await git('commit', '-qm', 'spec')
  await git('remote', 'add', 'origin', origin)
  await git('push', '-q', '-u', 'origin', 'feat/cart')
  // The agent clones from GitHub: owner/name come from the remote's fetch URL.
  await git('remote', 'set-url', 'origin', 'git@github.com:aspiralabs/cart-app.git')
  const expected = `Implement specs/cart.md in the GitHub repository aspiralabs/cart-app, starting from branch feat/cart. Follow the aspira-implementor skill. Push the branch; do not open a pull request. ${tail}`
  await exec('bash', [launcher, 'start', '@specs/cart.md'], { cwd: repo, env })
  expect((await captured()).at(-1)).toBe(expected)
  // From a subdirectory, the source is still made repository-relative.
  await exec('bash', [launcher, 'start', 'cart.md'], { cwd: join(repo, 'specs'), env })
  expect((await captured()).at(-1)).toBe(expected)
  await writeFile(join(repo, 'specs/cart.md'), '# Cart, edited\n')
  await expect(exec('bash', [launcher, 'start', 'specs/cart.md'], { cwd: repo, env })).rejects.toThrow('uncommitted')
  await git('commit', '-qam', 'edit')
  await expect(exec('bash', [launcher, 'start', 'specs/cart.md'], { cwd: repo, env })).rejects.toThrow('not pushed')
})

it('steps --local synchronously with absolute paths, without screen or a gateway key', async () => {
  const { dir, env, captured } = await stubs()
  const local = { ...env, AI_GATEWAY_API_KEY: '' }
  await mkdir(join(dir, 'specs'))
  await writeFile(join(dir, 'specs/x.md'), '# X\n')
  await exec('bash', [launcher, 'local', '@specs/x.md', '--guidelines', 'rules.md', '--max-parallel', '2', '--work', 'out', '--finish'], { cwd: dir, env: local })
  expect(await captured()).toEqual(['-C', root, '--silent', 'run', 'implement:local', join(dir, 'specs/x.md'), '--guidelines', join(dir, 'rules.md'), '--max-parallel', '2', '--work', join(dir, 'out'), '--finish'])
  await exec('bash', [launcher, 'start', 'specs/x.md', '--local', '--serial'], { cwd: dir, env: local })
  expect(await captured()).toEqual(['-C', root, '--silent', 'run', 'implement:local', join(dir, 'specs/x.md'), '--serial'])
  await expect(exec('bash', [launcher, 'local', 'specs/x.md', '--repo', 'aspiralabs/nomnomzz'], { cwd: dir, env: local })).rejects.toThrow('--local builds a local checkout')
  await expect(exec('bash', [launcher, 'local'], { cwd: dir, env: local })).rejects.toThrow('usage')
})
