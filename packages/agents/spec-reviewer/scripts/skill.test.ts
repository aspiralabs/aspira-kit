import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-spec-reviewer/scripts/spec-reviewer.sh')

it('routes the skill to the official CLI or Notion-loading eve entry point with literal paths', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'spec-review-skill-')))
  const repo = join(dir, 'repo with spaces')
  const bin = join(dir, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', repo])
  const spec = join(repo, 'spec $literal.md')
  const guidelines = join(repo, 'required rules.md')
  await writeFile(spec, '# Test spec')
  await writeFile(guidelines, 'Test guidelines')
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("stub review completed")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, SPEC_REVIEWER_AGENT_DIR: '', SPEC_REVIEW_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test' }
  const direct = await exec('bash', [launcher, 'start', spec, '--guidelines', guidelines], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'run', 'review', spec, repo, guidelines, join(repo, 'spec.reviewed')])
  const run = direct.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('spec.reviewed/spec.reviewed.md')
  expect(status.stdout).toContain('spec.reviewed/run-analysis.md')
  await exec('bash', [launcher, 'start', spec], { cwd: repo, env })
  const args = JSON.parse(await readFile(capture, 'utf8')) as string[]
  expect(args.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(args[5]).toContain('load-knowledge')
  expect(args[5]).toContain(spec)
  expect(args[5]).toContain('review-spec once')
  await expect(exec('bash', [launcher, 'start', spec, '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('debate rounds were removed')
})

it('steps a --local review synchronously; the driver, not the launcher, decides whether the guidelines are there', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'spec-review-local-skill-')))
  const repo = join(dir, 'repo with spaces')
  const bin = join(dir, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', repo])
  const spec = join(repo, 'spec.md')
  await writeFile(spec, '# Test spec')
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("{}")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  // No screen and no gateway key: a local step makes no model calls.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, SPEC_REVIEWER_AGENT_DIR: '', SPEC_REVIEW_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: '' }
  await exec('bash', [launcher, 'local', `@${spec}`], { cwd: repo, env })
  // `run` is explicit: pnpm 12 does not resolve a bare script name after --silent.
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, '--silent', 'run', 'review:local', spec, repo, '--output', join(repo, 'spec.reviewed')])
  const snapshot = join(repo, 'required rules.md')
  await writeFile(snapshot, 'REV-001 Check the spec')
  await exec('bash', [launcher, 'local', spec, '--guidelines', snapshot, '--finish'], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, '--silent', 'run', 'review:local', spec, repo, '--output', join(repo, 'spec.reviewed'), '--guidelines', snapshot, '--finish'])
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
  const stage = JSON.parse(stdout) as { stage: string; orchestrator: string; knowledge: { dir: string; required: string[] } }
  expect(stage.stage).toBe('knowledge')
  expect(stage.orchestrator).toBe(join(root, 'agent', 'instructions.md'))
  expect(stage.knowledge.dir).toBe(join(`${output}.local`, 'knowledge'))
  expect(stage.knowledge.required).toEqual(['Agent Instructions', 'Review Verification'])
  await expect(readFile(join(`${output}.local`, 'state.json'), 'utf8')).rejects.toThrow()
}, 30_000)
