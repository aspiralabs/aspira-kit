import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-code-analyzer/scripts/code-analyzer.sh')
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(root, 'node_modules/amaro/dist/register-strip.mjs')
const eve = join(root, 'node_modules/eve/bin/eve.js')
const prefix = ['--import', loader, '--experimental-strip-types']
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

// A node that records its arguments (one per line) and prints what the test asks, and a screen that runs the job in the foreground.
async function stubs(name: string, output = '{}') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), name)))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(join(bin, 'node'), `#!/bin/bash\nprintf '%s\\n' "$@" > "$CAPTURE"\necho '${output}'\n`, { mode: 0o755 })
  const capture = join(dir, 'arguments')
  const captured = async (): Promise<string[]> => command((await readFile(capture, 'utf8')).split('\n').filter(Boolean))
  return { dir, bin, capture, captured }
}

it('routes a local path to the CLI and a remote repository to the eve entry point', async () => {
  const { dir, bin, capture, captured } = await stubs('static-analysis-skill-')
  const repo = join(dir, 'repo with spaces')
  await mkdir(join(repo, 'packages/a'), { recursive: true })
  await exec('git', ['init', '-q', repo])
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', TMPDIR: dir }
  // A subdirectory is analyzed as itself, not widened to the git root.
  const sub = join(repo, 'packages/a')
  const local = await exec('bash', [launcher, 'start', 'packages/a/', '--max-rounds', '3'], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), sub, '--output', join(sub, '.static-analysis'), '--max-rounds', '3'])
  expect(local.stdout).toContain('mode: local')
  expect(local.stdout).toContain(`source: ${sub}\n`)
  expect(local.stdout).toContain('agent: @aspiralabs/code-analyzer@')
  expect(local.stderr).toContain(`code-analyzer: running kit source at ${root}, not the installed @aspiralabs/code-analyzer`)
  const run = local.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain(`${join(sub, '.static-analysis')}/report.md`)
  expect(status.stdout).toContain('agent: @aspiralabs/code-analyzer@')
  await exec('bash', [launcher, 'start', repo], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis')])
  // The guidelines go through on the default path too: a folder as --knowledge, a REQUIRED.md as --guidelines.
  await mkdir(join(dir, 'rules'))
  await writeFile(join(dir, 'rules', 'REQUIRED.md'), '# Agent Instructions\n')
  await exec('bash', [launcher, 'start', repo, '--knowledge', join(dir, 'rules')], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis'), '--knowledge', join(dir, 'rules')])
  await exec('bash', [launcher, 'start', repo, '--guidelines', join(dir, 'rules', 'REQUIRED.md')], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis'), '--guidelines', join(dir, 'rules', 'REQUIRED.md')])
  await expect(exec('bash', [launcher, 'start', repo, '--guidelines', join(dir, 'rules')], { cwd: repo, env })).rejects.toThrow('REQUIRED.md file')
  await expect(exec('bash', [launcher, 'start', repo, '--knowledge', join(dir, 'rules', 'REQUIRED.md')], { cwd: repo, env })).rejects.toThrow('is a folder')
  await exec('bash', [launcher, 'start', 'https://github.com/aspiralabs/kit', '--push', '--ref', 'main', '--knowledge', join(dir, 'rules')], { cwd: repo, env })
  const args = await captured()
  expect(args.slice(0, 5)).toEqual([...prefix, eve, 'invoke'])
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
  const { dir, bin, capture, captured } = await stubs('static-analysis-skill-local-', '{"pending": true}')
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'apps/web'), { recursive: true })
  await exec('git', ['init', '-q', repo])
  // No screen on PATH and no gateway key: a local step needs neither.
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: '', TMPDIR: dir }
  const step = await exec('bash', [launcher, 'local', 'apps/web', '--local', '--knowledge', 'rules', '--max-rounds', '2', '--no-fix', '--fix-warnings', '--output', 'out', '--finish'], { cwd: repo, env })
  expect(step.stdout).toBe('{"pending": true}\n')
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), join(repo, 'apps/web'), '--knowledge', join(repo, 'rules'), '--max-rounds', '2', '--no-fix', '--fix-warnings', '--output', join(repo, 'out'), '--finish'])
  await exec('bash', [launcher, 'local', 'apps/web', '--guidelines', 'REQUIRED.md'], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), join(repo, 'apps/web'), '--guidelines', join(repo, 'REQUIRED.md')])
  await expect(exec('bash', [launcher, 'local', 'owner/name'], { cwd: repo, env })).rejects.toThrow('local path')
  await expect(exec('bash', [launcher, 'local', join(repo, 'apps/web'), '--push'], { cwd: repo, env })).rejects.toThrow('unknown option')
})

it('resolves the agent in order: CODE_ANALYZER_AGENT_DIR, the package installed under the project, then its own location; never $ASPIRA_KIT', async () => {
  const { dir, bin, capture, captured } = await stubs('static-analysis-skill-resolve-')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: '', TMPDIR: dir }
  const app = join(dir, 'app')
  const store = join(app, 'node_modules/.pnpm/@aspiralabs+agents@9.9.9/node_modules')
  const installed = join(store, '@aspiralabs/code-analyzer')
  for (const [name, path] of [['@aspiralabs/agents', join(store, '@aspiralabs/agents')], ['@aspiralabs/code-analyzer', installed]] as const) {
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
  await exec('git', ['init', '-q', app])
  const copy = join(app, '.claude/skills/aspira-code-analyzer/scripts/code-analyzer.sh')
  await cp(launcher, copy)
  const fromApp = await exec('bash', [copy, 'local', '.'], { cwd: app, env: { ...env, ASPIRA_KIT: join(dir, 'stale-kit') } })
  expect(await captured()).toEqual(['--import', join(store, 'amaro/dist/register-strip.mjs'), '--experimental-strip-types', join(installed, 'scripts/local.ts'), app])
  expect(fromApp.stderr).not.toContain('kit source')
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere)
  await exec('git', ['init', '-q', elsewhere])
  const own = await exec('bash', [launcher, 'local', '.'], { cwd: elsewhere, env })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(own.stderr).toContain(`code-analyzer: running kit source at ${root}, not the installed @aspiralabs/code-analyzer`)
  const override = await exec('bash', [copy, 'local', '.'], { cwd: app, env: { ...env, CODE_ANALYZER_AGENT_DIR: root } })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(override.stderr).toContain(`CODE_ANALYZER_AGENT_DIR is set: running kit source at ${root}`)
})
