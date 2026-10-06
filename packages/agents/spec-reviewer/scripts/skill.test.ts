import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-spec-reviewer/scripts/spec-reviewer.sh')
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(root, 'node_modules/amaro/dist/register-strip.mjs')
const eve = join(root, 'node_modules/eve/bin/eve.js')
const envArgs = (args: string[]) => args.filter((a) => a.startsWith('--env-file='))
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

// A node that records its arguments (one per line) instead of running, and a screen that runs the job in the foreground.
async function stubs(prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'node'), '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$CAPTURE"\necho "{}"\n', { mode: 0o755 })
  const capture = join(dir, 'arguments')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, SPEC_REVIEWER_AGENT_DIR: '', SPEC_REVIEW_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test' }
  const captured = async (): Promise<string[]> => (await readFile(capture, 'utf8')).split('\n').filter(Boolean)
  return { dir, env, captured }
}

it('routes the skill to the official CLI or Notion-loading eve entry point with literal paths', async () => {
  const { dir, env, captured } = await stubs('spec-review-skill-')
  const repo = join(dir, 'repo with spaces')
  await mkdir(repo)
  await exec('git', ['init', repo])
  const spec = join(repo, 'spec $literal.md')
  const guidelines = join(repo, 'required rules.md')
  await writeFile(spec, '# Test spec')
  await writeFile(guidelines, 'Test guidelines')
  await writeFile(join(repo, '.env.local'), 'AI_GATEWAY_API_KEY=from-project\n')
  const direct = await exec('bash', [launcher, 'start', spec, '--guidelines', guidelines], { cwd: repo, env })
  const args = await captured()
  expect(command(args)).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/review.ts'), spec, repo, guidelines, join(repo, 'spec.reviewed')])
  expect(envArgs(args)[0]).toBe(`--env-file=${join(repo, '.env.local')}`)
  expect(direct.stdout).toContain('agent: @aspiralabs/spec-reviewer@')
  expect(direct.stderr).toContain(`spec-reviewer: running kit source at ${root}, not the installed @aspiralabs/spec-reviewer`)
  const run = direct.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('agent: @aspiralabs/spec-reviewer@')
  expect(status.stdout).toContain('spec.reviewed/spec.reviewed.md')
  expect(status.stdout).toContain('spec.reviewed/run-analysis.md')
  await exec('bash', [launcher, 'start', spec], { cwd: repo, env })
  const viaEve = command(await captured())
  expect(viaEve.slice(0, 5)).toEqual(['--import', loader, '--experimental-strip-types', eve, 'invoke'])
  expect(viaEve[5]).toContain('load-knowledge')
  expect(viaEve[5]).toContain(spec)
  expect(viaEve[5]).toContain('review-spec once')
  await expect(exec('bash', [launcher, 'start', spec, '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('debate rounds were removed')
})

it('steps a --local review synchronously; the driver, not the launcher, decides whether the guidelines are there', async () => {
  const { dir, env, captured } = await stubs('spec-review-local-skill-')
  const repo = join(dir, 'repo with spaces')
  await mkdir(repo)
  await exec('git', ['init', repo])
  const spec = join(repo, 'spec.md')
  await writeFile(spec, '# Test spec')
  // No screen and no gateway key: a local step makes no model calls.
  const local = { ...env, AI_GATEWAY_API_KEY: '' }
  await exec('bash', [launcher, 'local', `@${spec}`], { cwd: repo, env: local })
  expect(command(await captured())).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), spec, repo, '--output', join(repo, 'spec.reviewed')])
  const snapshot = join(repo, 'required rules.md')
  await writeFile(snapshot, 'REV-001 Check the spec')
  await exec('bash', [launcher, 'local', spec, '--guidelines', snapshot, '--finish'], { cwd: repo, env: local })
  expect(command(await captured())).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), spec, repo, '--output', join(repo, 'spec.reviewed'), '--guidelines', snapshot, '--finish'])
})

it('resolves the agent in order: SPEC_REVIEWER_AGENT_DIR, the package installed under the project, then its own location; never $ASPIRA_KIT', async () => {
  const { dir, env, captured } = await stubs('spec-review-skill-resolve-')
  // A project with @aspiralabs/agents installed by pnpm: the agents sit beside the meta-package in the store.
  const app = join(dir, 'app')
  const store = join(app, 'node_modules/.pnpm/@aspiralabs+agents@9.9.9/node_modules')
  const installed = join(store, '@aspiralabs/spec-reviewer')
  for (const [name, path] of [['@aspiralabs/agents', join(store, '@aspiralabs/agents')], ['@aspiralabs/spec-reviewer', installed]] as const) {
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
  await writeFile(join(app, '.env.local'), 'KNOWLEDGE_PAGE=x\n')
  await exec('git', ['init', app])
  const spec = join(app, 'spec.md')
  await writeFile(spec, '# Spec')
  const copy = join(app, '.claude/skills/aspira-spec-reviewer/scripts/spec-reviewer.sh')
  await cp(launcher, copy)
  const fromApp = await exec('bash', [copy, 'local', spec], { cwd: app, env: { ...env, ASPIRA_KIT: join(dir, 'stale-kit') } })
  expect(command(await captured())).toEqual(['--import', join(store, 'amaro/dist/register-strip.mjs'), '--experimental-strip-types', join(installed, 'scripts/local.ts'), spec, app, '--output', join(app, 'spec.reviewed')])
  expect(envArgs(await captured())).toEqual([`--env-file=${join(app, '.env.local')}`])
  expect(fromApp.stderr).not.toContain('kit source')
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere)
  await exec('git', ['init', elsewhere])
  const own = await exec('bash', [launcher, 'local', spec, '--repo', elsewhere], { cwd: elsewhere, env })
  expect(command(await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(own.stderr).toContain(`spec-reviewer: running kit source at ${root}, not the installed @aspiralabs/spec-reviewer`)
  const override = await exec('bash', [copy, 'local', spec], { cwd: app, env: { ...env, SPEC_REVIEWER_AGENT_DIR: root } })
  expect(command(await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(override.stderr).toContain(`SPEC_REVIEWER_AGENT_DIR is set: running kit source at ${root}`)
})

it('prints the knowledge stage on the first real local call, before anything starts', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'spec-review-local-real-')))
  const repo = join(dir, 'repo')
  await mkdir(repo)
  await exec('git', ['init', repo])
  const spec = join(repo, 'spec.md')
  await writeFile(spec, '# Test spec')
  const output = join(dir, 'out')
  const env = { ...process.env, SPEC_REVIEWER_AGENT_DIR: '', SPEC_REVIEW_AGENT_DIR: '', ASPIRA_KIT: '', KNOWLEDGE_REQUIRED: 'Agent Instructions, Review Verification' }
  const { stdout } = await exec('bash', [launcher, 'local', spec, '--output', output], { cwd: repo, env })
  const stage = JSON.parse(stdout) as { stage: string; orchestrator: string; knowledge: { dir: string; required: string[] }; agent: { name: string; version: string; installed: boolean } }
  expect(stage.stage).toBe('knowledge')
  expect(stage.orchestrator).toBe(join(root, 'agent', 'instructions.md'))
  expect(stage.knowledge.dir).toBe(join(`${output}.local`, 'knowledge'))
  expect(stage.knowledge.required).toEqual(['Agent Instructions', 'Review Verification'])
  // Every step says which agent package ran.
  expect(stage.agent).toMatchObject({ name: '@aspiralabs/spec-reviewer', installed: false })
  expect(stage.agent.version).toMatch(/^\d+\.\d+\.\d+/)
  await expect(readFile(join(`${output}.local`, 'state.json'), 'utf8')).rejects.toThrow()
}, 30_000)
