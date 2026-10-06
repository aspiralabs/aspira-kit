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

// A node that records its arguments (one per line, one block per call), answers the ticket step with a
// fake working folder and prints what the test asks otherwise, and a screen that runs the job in the foreground.
async function stubs(name: string, output = '{}') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), name)))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      '{ printf \'%s\\n\' "$@"; echo ---; } >> "$CAPTURE"',
      'case " $* " in',
      '  *" start "*) printf \'folder=%s\\nid=NOM-4\\ntitle=Explore pagination\\nurl=https://www.notion.so/nom-4\\nbefore=In Progress: Implementation\\nstatus=In Progress: Implementation\\n\' "$TICKET_FOLDER" ;;',
      `  *) echo '${output}' ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const capture = join(dir, 'arguments')
  const calls = async (): Promise<string[][]> => (await readFile(capture, 'utf8')).split('---\n').filter((block) => block.trim() !== '').map((block) => command(block.split('\n').filter(Boolean)))
  /** The arguments of the last node call. */
  const captured = async (): Promise<string[]> => (await calls()).at(-1) ?? []
  const reset = () => writeFile(capture, '')
  return { dir, bin, capture, captured, calls, reset }
}

it('routes a local path to the CLI and a remote repository to the eve entry point', async () => {
  const { dir, bin, capture, captured, calls, reset } = await stubs('static-analysis-skill-')
  const repo = join(dir, 'repo with spaces')
  await mkdir(join(repo, 'packages/a'), { recursive: true })
  await exec('git', ['init', '-q', repo])
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', TMPDIR: dir, TICKET_FOLDER: '' }
  // A subdirectory is analyzed as itself, not widened to the git root.
  const sub = join(repo, 'packages/a')
  const local = await exec('bash', [launcher, 'start', 'packages/a/', '--no-ticket', '--max-rounds', '3'], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), sub, '--output', join(sub, '.static-analysis'), '--max-rounds', '3'])
  expect(local.stdout).toContain('mode: local')
  expect(local.stdout).toContain(`source: ${sub}\n`)
  expect(local.stdout).toContain('agent: @aspiralabs/code-analyzer@')
  expect(local.stderr).toContain(`code-analyzer: running kit source at ${root}, not the installed @aspiralabs/code-analyzer`)
  const run = local.stdout.match(/^run: (.+)$/m)![1]!
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain(`${join(sub, '.static-analysis')}/report.md`)
  expect(status.stdout).toContain('agent: @aspiralabs/code-analyzer@')
  await exec('bash', [launcher, 'start', repo, '--no-ticket'], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis')])
  // A path without --no-ticket is refused, naming the flag.
  await expect(exec('bash', [launcher, 'start', 'packages/a'], { cwd: repo, env })).rejects.toThrow('is a file path, not a ticket; pass --no-ticket')
  // The guidelines go through on the default path too: a folder as --knowledge, a REQUIRED.md as --guidelines.
  await mkdir(join(dir, 'rules'))
  await writeFile(join(dir, 'rules', 'REQUIRED.md'), '# Agent Instructions\n')
  await exec('bash', [launcher, 'start', repo, '--no-ticket', '--knowledge', join(dir, 'rules')], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis'), '--knowledge', join(dir, 'rules')])
  await exec('bash', [launcher, 'start', repo, '--no-ticket', '--guidelines', join(dir, 'rules', 'REQUIRED.md')], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis'), '--guidelines', join(dir, 'rules', 'REQUIRED.md')])
  await expect(exec('bash', [launcher, 'start', repo, '--no-ticket', '--guidelines', join(dir, 'rules')], { cwd: repo, env })).rejects.toThrow('REQUIRED.md file')
  await expect(exec('bash', [launcher, 'start', repo, '--no-ticket', '--knowledge', join(dir, 'rules', 'REQUIRED.md')], { cwd: repo, env })).rejects.toThrow('is a folder')
  await exec('bash', [launcher, 'start', 'https://github.com/aspiralabs/kit', '--no-ticket', '--push', '--ref', 'main', '--knowledge', join(dir, 'rules')], { cwd: repo, env })
  const args = await captured()
  expect(args.slice(0, 5)).toEqual([...prefix, eve, 'invoke'])
  expect(args[5]).toContain('source exactly "https://github.com/aspiralabs/kit"')
  expect(args[5]).toContain(`outputDir "${join(dir, 'static-analysis/aspiralabs-kit')}"`)
  expect(args[5]).toContain('push: true')
  expect(args[5]).toContain('ref "main"')
  expect(args[5]).toContain(`knowledge "${join(dir, 'rules')}"`)
  await expect(exec('bash', [launcher, 'start', repo, '--no-ticket', '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
  await expect(exec('bash', [launcher, 'start', repo, '--no-ticket', '--push'], { cwd: repo, env })).rejects.toThrow('remote repositories only')
  await expect(exec('bash', [launcher, 'start', 'not a repo', '--no-ticket'], { cwd: repo, env })).rejects.toThrow('not a directory or a GitHub repository')
  await expect(exec('bash', [launcher, 'start', dir, '--no-ticket'], { cwd: repo, env })).rejects.toThrow('not a git repository')
  await expect(exec('bash', [launcher, 'start', repo, '--no-ticket', '--local'], { cwd: repo, env })).rejects.toThrow('use the local command')
  // The ticket form: the board step first (resolve, gate, pull), the app directory from --app, the trace after the run.
  const folder = join(repo, '.work/nom-4-explore-pagination')
  await mkdir(folder, { recursive: true })
  await reset()
  const ticket = await exec('bash', [launcher, 'start', 'NOM-4', '--app', 'packages/a', '--force-pull'], { cwd: repo, env: { ...env, TICKET_FOLDER: folder } })
  const [board, analysis, finish] = await calls()
  expect(board).toEqual([...prefix, join(root, 'scripts/ticket.ts'), 'start', 'NOM-4', '--repo', repo, '--force-pull'])
  expect(ticket.stdout).toContain('ticket: NOM-4 Explore pagination (https://www.notion.so/nom-4)')
  expect(ticket.stdout).toContain(`folder: ${folder}`)
  expect(ticket.stdout).toContain(`source: ${sub}\n`)
  expect(analysis).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), sub, '--output', join(sub, '.static-analysis')])
  expect(finish).toEqual([...prefix, join(root, 'scripts/ticket.ts'), 'finish', '--repo', repo, '--folder', folder, '--ok', '--run-status', 'clean', '--export', join(sub, '.static-analysis')])
  // Without --app the repository root is analyzed; --app does not go with --no-ticket.
  await reset()
  await exec('bash', [launcher, 'start', 'NOM-4'], { cwd: sub, env: { ...env, TICKET_FOLDER: folder } })
  expect((await calls())[1]).toEqual([...prefix, join(root, 'scripts/static-analysis.ts'), repo, '--output', join(repo, '.static-analysis')])
  await expect(exec('bash', [launcher, 'start', repo, '--no-ticket', '--app', 'packages/a'], { cwd: repo, env })).rejects.toThrow('--app goes with a ticket')
  // A refusal from the board step (exit 3) stops the launcher before anything is launched.
  await writeFile(join(bin, 'node'), '#!/bin/bash\necho "code-analyzer: refused: NOM-4 is Grooming" >&2\nexit 3\n', { mode: 0o755 })
  await expect(exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: { ...env, TICKET_FOLDER: folder } })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('refused') })
})

it('steps a --local run synchronously, with no screen, gateway key or detached run', async () => {
  const { dir, bin, capture, captured } = await stubs('static-analysis-skill-local-', '{"pending": true}')
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'apps/web'), { recursive: true })
  await exec('git', ['init', '-q', repo])
  // No screen on PATH and no gateway key: a local step needs neither.
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CAPTURE: capture, CODE_ANALYZER_AGENT_DIR: '', STATIC_ANALYSIS_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: '', TMPDIR: dir }
  const step = await exec('bash', [launcher, 'local', 'apps/web', '--no-ticket', '--local', '--knowledge', 'rules', '--max-rounds', '2', '--no-fix', '--fix-warnings', '--output', 'out', '--finish'], { cwd: repo, env })
  expect(step.stdout).toBe('{"pending": true}\n')
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), '--repo', repo, '--knowledge', join(repo, 'rules'), '--max-rounds', '2', '--no-fix', '--fix-warnings', '--output', join(repo, 'out'), '--finish', '--no-ticket', join(repo, 'apps/web')])
  await exec('bash', [launcher, 'local', 'apps/web', '--no-ticket', '--guidelines', 'REQUIRED.md'], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), '--repo', repo, '--guidelines', join(repo, 'REQUIRED.md'), '--no-ticket', join(repo, 'apps/web')])
  await expect(exec('bash', [launcher, 'local', 'owner/name', '--no-ticket'], { cwd: repo, env })).rejects.toThrow('local path')
  await expect(exec('bash', [launcher, 'local', join(repo, 'apps/web'), '--no-ticket', '--push'], { cwd: repo, env })).rejects.toThrow('unknown option')
  // The ticket form: the ID, a URL or nothing as --ticket, the app directory from --app (default the repository root).
  await exec('bash', [launcher, 'local', 'NOM-4', '--app', 'apps/web'], { cwd: repo, env })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), '--repo', repo, '--ticket', 'NOM-4', join(repo, 'apps/web')])
  await exec('bash', [launcher, 'local', 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', '--force-pull'], { cwd: join(repo, 'apps/web'), env })
  expect((await captured()).slice(4)).toEqual(['--repo', repo, '--force-pull', '--ticket', 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', repo])
  await exec('bash', [launcher, 'local'], { cwd: repo, env })
  expect((await captured()).slice(4)).toEqual(['--repo', repo, repo])
  await exec('bash', [launcher, 'local', 'NOM-4', '--app', 'apps/web', '--verify'], { cwd: repo, env })
  expect((await captured()).slice(4)).toEqual(['--repo', repo, '--verify', '--ticket', 'NOM-4', join(repo, 'apps/web')])
  await expect(exec('bash', [launcher, 'local', 'apps/web'], { cwd: repo, env })).rejects.toThrow('is a file path, not a ticket; pass --no-ticket')
  await expect(exec('bash', [launcher, 'local', 'apps/web', '--no-ticket', '--app', 'apps/web'], { cwd: repo, env })).rejects.toThrow('--app goes with a ticket')
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
  const fromApp = await exec('bash', [copy, 'local', '.', '--no-ticket'], { cwd: app, env: { ...env, ASPIRA_KIT: join(dir, 'stale-kit') } })
  expect(await captured()).toEqual(['--import', join(store, 'amaro/dist/register-strip.mjs'), '--experimental-strip-types', join(installed, 'scripts/local.ts'), '--repo', app, '--no-ticket', app])
  expect(fromApp.stderr).not.toContain('kit source')
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere)
  await exec('git', ['init', '-q', elsewhere])
  const own = await exec('bash', [launcher, 'local', '.', '--no-ticket'], { cwd: elsewhere, env })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(own.stderr).toContain(`code-analyzer: running kit source at ${root}, not the installed @aspiralabs/code-analyzer`)
  const override = await exec('bash', [copy, 'local', '.', '--no-ticket'], { cwd: app, env: { ...env, CODE_ANALYZER_AGENT_DIR: root } })
  expect((await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(override.stderr).toContain(`CODE_ANALYZER_AGENT_DIR is set: running kit source at ${root}`)
})
