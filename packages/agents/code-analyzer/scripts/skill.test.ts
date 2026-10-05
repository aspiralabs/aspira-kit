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
  // A subdirectory is analyzed as itself, not widened to the git root.
  const sub = join(repo, 'packages/a')
  const local = await exec('bash', [launcher, 'start', 'packages/a/', '--max-rounds', '3'], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'analyze', sub, '--output', join(sub, '.static-analysis'), '--max-rounds', '3'])
  expect(local.stdout).toContain('mode: local')
  expect(local.stdout).toContain(`source: ${sub}\n`)
  const run = local.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain(`${join(sub, '.static-analysis')}/report.md`)
  await exec('bash', [launcher, 'start', repo], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'analyze', repo, '--output', join(repo, '.static-analysis')])
  // The guidelines go through on the default path too: a folder as --knowledge, a REQUIRED.md as --guidelines.
  await mkdir(join(dir, 'rules'))
  await writeFile(join(dir, 'rules', 'REQUIRED.md'), '# Agent Instructions\n')
  await exec('bash', [launcher, 'start', repo, '--knowledge', join(dir, 'rules')], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'analyze', repo, '--output', join(repo, '.static-analysis'), '--knowledge', join(dir, 'rules')])
  await exec('bash', [launcher, 'start', repo, '--guidelines', join(dir, 'rules', 'REQUIRED.md')], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'analyze', repo, '--output', join(repo, '.static-analysis'), '--guidelines', join(dir, 'rules', 'REQUIRED.md')])
  await expect(exec('bash', [launcher, 'start', repo, '--guidelines', join(dir, 'rules')], { cwd: repo, env })).rejects.toThrow('REQUIRED.md file')
  await expect(exec('bash', [launcher, 'start', repo, '--knowledge', join(dir, 'rules', 'REQUIRED.md')], { cwd: repo, env })).rejects.toThrow('is a folder')
  await exec('bash', [launcher, 'start', 'https://github.com/aspiralabs/kit', '--push', '--ref', 'main', '--knowledge', join(dir, 'rules')], { cwd: repo, env })
  const args = JSON.parse(await readFile(capture, 'utf8')) as string[]
  expect(args.slice(0, 5)).toEqual(['-C', root, 'exec', 'eve', 'invoke'])
  expect(args[5]).toContain('source exactly "https://github.com/aspiralabs/kit"')
  expect(args[5]).toContain(`outputDir "${join(dir, 'static-analysis/aspiralabs-kit')}"`)
  expect(args[5]).toContain('push: true')
  expect(args[5]).toContain('ref "main"')
  expect(args[5]).toContain(`knowledge "${join(dir, 'rules')}"`)
  await expect(exec('bash', [launcher, 'start', repo, '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
  await expect(exec('bash', [launcher, 'start', repo, '--push'], { cwd: repo, env })).rejects.toThrow('remote repositories only')
  await expect(exec('bash', [launcher, 'start', 'not a repo'], { cwd: repo, env })).rejects.toThrow('not a directory or a GitHub repository')
  await expect(exec('bash', [launcher, 'start', dir], { cwd: repo, env })).rejects.toThrow('not a git repository')
  await expect(exec('bash', [launcher, 'start', repo, '--local'], { cwd: repo, env })).rejects.toThrow('use the local command')
})

it('steps a --local run synchronously, with no screen, gateway key or detached run', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'static-analysis-skill-local-')))
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  await mkdir(join(repo, 'apps/web'), { recursive: true })
  await mkdir(bin)
  await exec('git', ['init', '-q', repo])
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\nconsole.log("{\\"pending\\": true}")\n', { mode: 0o755 })
  const capture = join(dir, 'arguments.json')
  // No screen on PATH and no gateway key: a local step needs neither.
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: '', TMPDIR: dir }
  const step = await exec('bash', [launcher, 'local', 'apps/web', '--local', '--knowledge', 'rules', '--max-rounds', '2', '--no-fix', '--fix-warnings', '--output', 'out', '--finish'], { cwd: repo, env })
  expect(step.stdout).toBe('{"pending": true}\n')
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'run', 'local', join(repo, 'apps/web'), '--knowledge', join(repo, 'rules'), '--max-rounds', '2', '--no-fix', '--fix-warnings', '--output', join(repo, 'out'), '--finish'])
  await exec('bash', [launcher, 'local', 'apps/web', '--guidelines', 'REQUIRED.md'], { cwd: repo, env })
  expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['-C', root, 'run', 'local', join(repo, 'apps/web'), '--guidelines', join(repo, 'REQUIRED.md')])
  await expect(exec('bash', [launcher, 'local', 'owner/name'], { cwd: repo, env })).rejects.toThrow('local path')
  await expect(exec('bash', [launcher, 'local', join(repo, 'apps/web'), '--push'], { cwd: repo, env })).rejects.toThrow('unknown option')
})
