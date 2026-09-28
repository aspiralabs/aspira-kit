import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-spec-review/scripts/spec-review.sh')

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
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, SPEC_REVIEW_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test' }
  const direct = await exec('bash', [launcher, 'start', spec, '--guidelines', guidelines], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'review', spec, repo, guidelines, join(repo, 'spec.reviewed')])
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
