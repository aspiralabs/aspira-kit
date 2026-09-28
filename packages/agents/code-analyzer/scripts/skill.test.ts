import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-code-analyzer/scripts/code-analyzer.sh')

it('routes a local path to the CLI and a remote repository to the eve entry point', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'static-analysis-skill-')))
  const repo = join(dir, 'repo with spaces')
  const bin = join(dir, 'bin')
  await mkdir(join(repo, 'packages/a'), { recursive: true })
  await mkdir(bin)
  await exec('git', ['init', '-q', repo])
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("stub run completed")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', TMPDIR: dir }
  const local = await exec('bash', [launcher, 'start', join(repo, 'packages/a'), '--max-rounds', '3'], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'analyze', repo, '--output', join(repo, '.static-analysis'), '--max-rounds', '3'])
  expect(local.stdout).toContain('mode: local')
  const run = local.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain(`${join(repo, '.static-analysis')}/report.md`)
  await exec('bash', [launcher, 'start', 'https://github.com/aspiralabs/kit', '--push', '--ref', 'main'], { cwd: repo, env })
  const args = JSON.parse(await readFile(capture, 'utf8')) as string[]
  expect(args.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(args[5]).toContain('source exactly "https://github.com/aspiralabs/kit"')
  expect(args[5]).toContain(`outputDir "${join(dir, 'static-analysis/aspiralabs-kit')}"`)
  expect(args[5]).toContain('push: true')
  expect(args[5]).toContain('ref "main"')
  await expect(exec('bash', [launcher, 'start', repo, '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
  await expect(exec('bash', [launcher, 'start', repo, '--push'], { cwd: repo, env })).rejects.toThrow('remote repositories only')
  await expect(exec('bash', [launcher, 'start', 'not a repo'], { cwd: repo, env })).rejects.toThrow('not a directory or a GitHub repository')
})
