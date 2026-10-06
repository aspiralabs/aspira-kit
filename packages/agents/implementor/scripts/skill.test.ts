import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { INSTRUCTIONS, PINNED_RULES, PROCEDURE } from './pinned-rules.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const skillDir = join(root, 'skill/aspira-implementor')
const launcher = join(skillDir, 'scripts/implementor.sh')
const exec = promisify(execFile)
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(root, 'node_modules/amaro/dist/register-strip.mjs')
const eve = join(root, 'node_modules/eve/bin/eve.js')
const prefix = ['--import', loader, '--experimental-strip-types']
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

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
  // A node that records its arguments (one per line) instead of running.
  await writeFile(join(bin, 'node'), '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$CAPTURE"\necho "stub run completed"\n', { mode: 0o755 })
  const capture = join(dir, 'arguments')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, IMPLEMENTOR_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test' }
  const captured = async (): Promise<string[]> => command((await readFile(capture, 'utf8')).split('\n').filter(Boolean))
  return { dir, env, captured }
}

const tail = 'Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any.'

it('launches the agent on a GitHub repository with the same prompt the remote launcher always sent', async () => {
  const { dir, env, captured } = await stubs()
  const started = await exec('bash', [launcher, 'start', 'docs/plans/my feature/plan.review', '--repo', 'aspiralabs/nomnomzz', '--ref', 'develop'], { cwd: dir, env })
  const args = await captured()
  expect(args.slice(0, 5)).toEqual([...prefix, eve, 'invoke'])
  expect(started.stdout).toContain('agent: @aspiralabs/implementor@')
  expect(started.stderr).toContain(`implementor: running kit source at ${root}, not the installed @aspiralabs/implementor`)
  // Byte for byte what implement-remote.sh sent: the default path's prompt is unchanged.
  expect(args[5]).toBe(`Implement docs/plans/my feature/plan.review in the GitHub repository aspiralabs/nomnomzz, starting from branch develop. Follow the aspira-implementor skill. Push the branch; do not open a pull request. ${tail}`)
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  const waited = (await exec('bash', [launcher, 'wait', run, '--max', '5'], { env })).stdout
  expect(waited).toContain('finished')
  expect(waited).toContain('agent: @aspiralabs/implementor@')
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
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), join(dir, 'specs/x.md'), '--guidelines', join(dir, 'rules.md'), '--max-parallel', '2', '--work', join(dir, 'out'), '--finish'])
  await exec('bash', [launcher, 'start', 'specs/x.md', '--local', '--serial'], { cwd: dir, env: local })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), join(dir, 'specs/x.md'), '--serial'])
  await expect(exec('bash', [launcher, 'local', 'specs/x.md', '--repo', 'aspiralabs/nomnomzz'], { cwd: dir, env: local })).rejects.toThrow('--local builds a local checkout')
  await expect(exec('bash', [launcher, 'local'], { cwd: dir, env: local })).rejects.toThrow('usage')
})

it('resolves the agent in order: IMPLEMENTOR_AGENT_DIR, the package installed under the project, then its own location; never $ASPIRA_KIT', async () => {
  const { dir, env, captured } = await stubs()
  const local = { ...env, AI_GATEWAY_API_KEY: '' }
  // A project with @aspiralabs/agents installed by pnpm: the agents sit beside the meta-package in the store.
  const app = join(dir, 'app')
  const store = join(app, 'node_modules/.pnpm/@aspiralabs+agents@9.9.9/node_modules')
  const installed = join(store, '@aspiralabs/implementor')
  for (const [name, path] of [['@aspiralabs/agents', join(store, '@aspiralabs/agents')], ['@aspiralabs/implementor', installed]] as const) {
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
  await mkdir(join(app, 'specs'))
  await writeFile(join(app, 'specs/x.md'), '# X\n')
  const copy = join(app, '.claude/skills/aspira-implementor/scripts/implementor.sh')
  await cp(launcher, copy)
  const fromApp = await exec('bash', [copy, 'local', 'specs/x.md'], { cwd: app, env: { ...local, ASPIRA_KIT: join(dir, 'stale-kit') } })
  expect(await captured()).toEqual(['--import', join(store, 'amaro/dist/register-strip.mjs'), '--experimental-strip-types', join(installed, 'scripts/local.ts'), join(app, 'specs/x.md')])
  expect(fromApp.stderr).not.toContain('kit source')
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(join(elsewhere, 'specs'), { recursive: true })
  await writeFile(join(elsewhere, 'specs/x.md'), '# X\n')
  const own = await exec('bash', [launcher, 'local', 'specs/x.md'], { cwd: elsewhere, env: local })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(own.stderr).toContain(`implementor: running kit source at ${root}, not the installed @aspiralabs/implementor`)
  const override = await exec('bash', [copy, 'local', 'specs/x.md'], { cwd: app, env: { ...local, IMPLEMENTOR_AGENT_DIR: root } })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(override.stderr).toContain(`IMPLEMENTOR_AGENT_DIR is set: running kit source at ${root}`)
})
