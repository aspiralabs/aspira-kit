import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, realpath, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(dirname(root), 'node_modules/amaro/dist/register-strip.mjs')
const eve = join(dirname(root), 'node_modules/eve/bin/eve.js')
const envArgs = (args: string[]) => args.filter((a) => a.startsWith('--env-file='))
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

// The skill as the global harness installs it: a copy under <HOME>/.claude/skills with .kit-version at the
// package's version, and a `kit` on PATH whose package-dir names this package (the only agent a launcher runs).
async function installGlobal(dir: string, bin: string) {
  const home = join(dir, 'home')
  const skill = join(home, '.claude/skills/aspira-planner')
  await cp(join(root, 'skill/aspira-planner'), skill, { recursive: true })
  const { version } = JSON.parse(await readFile(join(dirname(root), 'package.json'), 'utf8')) as { version: string }
  await writeFile(join(skill, '.kit-version'), `${version}\n`)
  await writeFile(join(bin, 'kit'), `#!/bin/sh\n[ "$1" = package-dir ] && echo '${dirname(root)}'\nexit 0\n`, { mode: 0o755 })
  return { home, launcher: join(skill, 'scripts/planner.sh') }
}

// A node that records its arguments (one per line, one block per call) instead of running, answers the
// ticket step with a fake working folder, and a screen that runs the job in the foreground.
async function stubs(prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'screen'), '#!/bin/bash\nexec "$3"\n', { mode: 0o755 })
  await writeFile(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      '{ printf \'%s\\n\' "$@"; echo ---; } >> "$CAPTURE"',
      'case " $* " in',
      '  *" start "*) printf \'folder=%s\\nid=NOM-4\\ntitle=Explore pagination\\nurl=https://www.notion.so/nom-4\\nbefore=Ready: Spec\\nstatus=In Progress: Plan\\ninput=%s\\n\' "$TICKET_FOLDER" "$TICKET_INPUT" ;;',
      '  *) echo "{}" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const capture = join(dir, 'arguments')
  const { home, launcher } = await installGlobal(dir, bin)
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, PLANNER_AGENT_DIR: '', SPEC_TO_PLAN_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', TICKET_FOLDER: '', TICKET_INPUT: '' }
  /** The arguments of the last node call. */
  const captured = async (): Promise<string[]> => calls().then((all) => all.at(-1) ?? [])
  const calls = async (): Promise<string[][]> => (await readFile(capture, 'utf8')).split('---\n').filter((block) => block.trim() !== '').map((block) => block.split('\n').filter(Boolean))
  const reset = () => writeFile(capture, '')
  return { dir, env, captured, calls, reset, launcher }
}

it('routes the skill to the official CLI or Notion-loading eve entry point with literal paths', async () => {
  const { dir, env, calls, reset, launcher } = await stubs('planner-skill-')
  const repo = join(dir, 'repo with spaces')
  await mkdir(repo)
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'aspira.json'), '{}')
  const spec = join(repo, 'spec $literal.md')
  const guidelines = join(repo, 'required rules.md')
  await writeFile(spec, '# Test spec')
  await writeFile(guidelines, 'Test guidelines')
  await writeFile(join(repo, '.env.local'), 'AI_GATEWAY_API_KEY=from-project\n')
  const direct = await exec('bash', [launcher, 'start', spec, '--no-ticket', '--guidelines', guidelines], { cwd: repo, env })
  const args = (await calls())[0]!
  expect(command(args)).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/plan.ts'), spec, repo, guidelines, join(repo, 'plan.review')])
  // A path without --no-ticket is refused, naming the flag.
  await expect(exec('bash', [launcher, 'start', spec, '--guidelines', guidelines], { cwd: repo, env })).rejects.toThrow('is a file path, not a ticket; pass --no-ticket')
  // The project's .env.local is read first; the agent's own env files only when they exist (kit development).
  expect(envArgs(args)[0]).toBe(`--env-file=${join(repo, '.env.local')}`)
  expect(direct.stdout).toContain('agent: planner@')
  expect(direct.stdout).toContain(`(global, ${root})`)
  const run = direct.stdout.match(/^run: (.+)$/m)![1]!
  // What status and wait report, and the export records: the agent package, version, where it ran from.
  expect(JSON.parse(await readFile(join(run, 'agent.json'), 'utf8'))).toEqual({ name: 'planner', version: expect.stringMatching(/^\d+\.\d+\.\d+/), path: root, source: 'global', installed: false })
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('agent: planner@')
  expect(status.stdout).toContain('plan.review/plan.reviewed.md')
  expect(status.stdout).toContain('plan.review/run-analysis.md')
  await reset()
  await exec('bash', [launcher, 'start', spec, '--no-ticket'], { cwd: repo, env })
  const viaEve = command((await calls())[0]!)
  expect(viaEve.slice(0, 5)).toEqual(['--import', loader, '--experimental-strip-types', eve, 'invoke'])
  expect(viaEve[5]).toContain('load-knowledge')
  expect(viaEve[5]).toContain(spec)
  expect(viaEve[5]).toContain('create-plan once')
  const reviewed = join(repo, 'spec.reviewed')
  await mkdir(reviewed)
  const reviewedSpec = join(reviewed, 'spec.reviewed.md')
  await writeFile(reviewedSpec, '# Reviewed spec')
  await reset()
  await exec('bash', [launcher, 'start', reviewedSpec, '--no-ticket', '--guidelines', guidelines], { cwd: repo, env })
  expect((await calls())[0]!.at(-1)).toBe(join(repo, 'plan.review'))
  const custom = join(dir, 'custom output')
  await reset()
  await writeFile(join(dir, 'aspira.json'), '{}')
  await exec('bash', [launcher, 'start', spec, '--no-ticket', '--repo', repo, '--output', custom, '--guidelines', guidelines], { cwd: dir, env })
  expect((await calls())[0]!.slice(-3)).toEqual([repo, guidelines, custom])
  await expect(exec('bash', [launcher, 'start', spec, '--no-ticket', '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
})

it('steps --local through the agent package without launching the agent', async () => {
  const { dir, env, captured, reset, launcher } = await stubs('planner-skill-local-')
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'spec.reviewed'), { recursive: true })
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'aspira.json'), '{}')
  const spec = join(repo, 'spec.reviewed', 'spec.reviewed.md')
  const guidelines = join(repo, 'REQUIRED.md')
  await writeFile(spec, '# Reviewed spec')
  await writeFile(guidelines, 'Rules')
  // No screen and no gateway key: a local step makes no model calls.
  const local = { ...env, AI_GATEWAY_API_KEY: '' }
  await exec('bash', [launcher, 'local', spec, '--no-ticket'], { cwd: repo, env: local })
  expect(command(await captured())).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), '--repo', repo, '--no-ticket', spec, '--output', join(repo, 'plan.review')])
  const custom = join(dir, 'out')
  await exec('bash', [launcher, 'local', spec, '--no-ticket', '--repo', repo, '--output', custom, '--guidelines', guidelines, '--finish'], { cwd: dir, env: local })
  expect(command(await captured())).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), '--repo', repo, '--no-ticket', spec, '--output', custom, '--guidelines', guidelines, '--finish'])
  await expect(exec('bash', [launcher, 'local', spec, '--no-ticket', '--rounds', '2'], { cwd: repo, env: local })).rejects.toThrow('unknown option')
  // The ticket form: the ID, a URL, or nothing, handed to the driver as --ticket; --force-pull and --verify go with it.
  await reset()
  await exec('bash', [launcher, 'local', 'NOM-4'], { cwd: repo, env: local })
  expect(command(await captured())).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), '--repo', repo, '--ticket', 'NOM-4'])
  await exec('bash', [launcher, 'local', 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', '--force-pull'], { cwd: repo, env: local })
  expect(command(await captured()).slice(-3)).toEqual(['--ticket', 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', '--force-pull'])
  await exec('bash', [launcher, 'local'], { cwd: repo, env: local })
  expect(command(await captured()).slice(-2)).toEqual(['--repo', repo])
  await exec('bash', [launcher, 'local', 'NOM-4', '--verify'], { cwd: repo, env: local })
  expect(command(await captured()).slice(-3)).toEqual(['--ticket', 'NOM-4', '--verify'])
  await expect(exec('bash', [launcher, 'local', spec], { cwd: repo, env: local })).rejects.toThrow('is a file path, not a ticket; pass --no-ticket')
})

it('start with a ticket runs the board step first, plans the pulled spec, and finishes on the board after the run', async () => {
  const { dir, env, calls, launcher } = await stubs('planner-skill-ticket-')
  const repo = join(dir, 'repo')
  const folder = join(repo, '.work', 'nom-4-explore-pagination')
  await mkdir(join(folder, 'spec.reviewed'), { recursive: true })
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'aspira.json'), '{}')
  const spec = join(folder, 'spec.reviewed', 'spec.reviewed.md')
  await writeFile(spec, '# Reviewed spec')
  await writeFile(join(repo, '.env.local'), 'AI_GATEWAY_API_KEY=from-project\n')
  const ticketEnv = { ...env, TICKET_FOLDER: folder, TICKET_INPUT: spec }
  const out = await exec('bash', [launcher, 'start', 'NOM-4', '--force-pull'], { cwd: repo, env: ticketEnv })
  const [board, run, status, finish] = await calls()
  expect(command(board!)).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/ticket.ts'), 'start', 'NOM-4', '--repo', repo, '--force-pull'])
  expect(out.stdout).toContain('ticket: NOM-4 Explore pagination (https://www.notion.so/nom-4)')
  expect(out.stdout).toContain('status: Ready: Spec -> In Progress: Plan')
  expect(out.stdout).toContain(`output: ${join(folder, 'plan.review')}`)
  expect(command(run!).slice(3, 5)).toEqual([eve, 'invoke'])
  expect(command(run!)[5]).toContain(spec)
  expect(command(run!)[5]).toContain('do not call board yourself')
  expect(status![0]).toBe('-p')
  // finish takes only the run status read from the trace: no --ok/--failed, the status alone decides the pushes and moves (F7, F53).
  expect(command(finish!)).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/ticket.ts'), 'finish', '--repo', repo, '--folder', folder, '--run-status', '{}', '--export', join(folder, 'plan.review')])
  // A refusal from the board step (exit 3) stops the launcher before anything is launched.
  await writeFile(join(dir, 'bin', 'node'), '#!/bin/bash\necho "planner: refused: NOM-4 is Grooming" >&2\nexit 3\n', { mode: 0o755 })
  await expect(exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: ticketEnv })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('refused') })
})

it('T42 finds the project from the working directory: no aspira.json up to HOME is refused, an app named in the root aspira.json is the project', async () => {
  const { dir, env, captured, launcher } = await stubs('planner-skill-project-')
  // (a) A folder with no aspira.json at or above it.
  const bare = await realpath(await mkdtemp(join(tmpdir(), 'planner-skill-bare-')))
  await exec('git', ['init', bare])
  await writeFile(join(bare, 'spec.md'), '# Spec')
  await expect(exec('bash', [launcher, 'local', 'spec.md', '--no-ticket'], { cwd: bare, env })).rejects.toThrow(`no Aspira project here (no aspira.json at or above ${bare})`)
  // (b) Claude Code runs in the app folder of a repository whose root aspira.json names it: that folder is the project directory.
  const repo = join(dir, 'repo')
  const app = join(repo, 'apps/web')
  await mkdir(app, { recursive: true })
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ app: 'apps/web' }))
  await writeFile(join(app, '.env.local'), 'KNOWLEDGE_PAGE=x\n')
  await writeFile(join(app, 'spec.md'), '# Spec')
  await exec('bash', [launcher, 'local', 'spec.md', '--no-ticket'], { cwd: app, env })
  expect(envArgs(await captured())).toEqual([`--env-file=${join(app, '.env.local')}`])
})

it('T43 runs only the global kit: the package installed under the project is never taken, and PLANNER_AGENT_DIR is the one override', async () => {
  const { dir, env, captured, launcher } = await stubs('planner-skill-resolve-')
  // A project with @aspiralabs/ai installed by pnpm: the package sits in the store, symlinked into the project's node_modules, with amaro beside it.
  const app = join(dir, 'app')
  const store = join(app, 'node_modules/.pnpm/@aspiralabs+ai@9.9.9/node_modules')
  const pkg = join(store, '@aspiralabs/ai')
  const installed = join(pkg, 'planner')
  await mkdir(join(installed, 'scripts'), { recursive: true })
  await mkdir(join(installed, 'skill'))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: '9.9.9' }, null, 2))
  await writeFile(join(installed, 'scripts/local.ts'), '')
  await mkdir(join(store, 'amaro/dist'), { recursive: true })
  await writeFile(join(store, 'amaro/dist/register-strip.mjs'), '')
  await mkdir(join(app, 'node_modules/@aspiralabs'), { recursive: true })
  await symlink(pkg, join(app, 'node_modules/@aspiralabs/ai'))
  await writeFile(join(app, 'package.json'), '{"name":"app"}')
  await writeFile(join(app, 'aspira.json'), '{}')
  await mkdir(join(app, 'docs/feature'), { recursive: true })
  await exec('git', ['init', app])
  const spec = join(app, 'docs/feature/spec.md')
  await writeFile(spec, '# Spec')

  // The global kit's agent runs, from a subdirectory too; the project's installed copy does not.
  const fromApp = await exec('bash', [launcher, 'local', spec, '--no-ticket'], { cwd: join(app, 'docs'), env })
  expect(command(await captured())).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/local.ts'), '--repo', app, '--no-ticket', spec, '--output', join(app, 'docs/feature/plan.review')])
  expect(fromApp.stdout + fromApp.stderr).not.toContain(installed)
  // PLANNER_AGENT_DIR wins over the global kit, and the report says it is set.
  const overridePkg = join(dir, 'override/aspira-ai')
  const override = join(overridePkg, 'planner')
  await mkdir(join(override, 'scripts'), { recursive: true })
  await mkdir(join(override, 'skill'))
  await writeFile(join(overridePkg, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version: '9.9.9' }, null, 2))
  await writeFile(join(override, 'scripts/local.ts'), '')
  const forced = await exec('bash', [launcher, 'local', spec, '--no-ticket'], { cwd: app, env: { ...env, PLANNER_AGENT_DIR: override } })
  expect(command(await captured())).toContain(join(override, 'scripts/local.ts'))
  expect(forced.stderr).toContain(`planner: PLANNER_AGENT_DIR is set: running kit source at ${override}, not the installed @aspiralabs/ai`)
  await expect(exec('bash', [launcher, 'local', spec, '--no-ticket'], { cwd: app, env: { ...env, PLANNER_AGENT_DIR: dir } })).rejects.toThrow('PLANNER_AGENT_DIR is not the planner folder of @aspiralabs/ai')
  // No kit on PATH or in pnpm's global bin (KIT-76): a clear error naming kit update, and no $ASPIRA_KIT fallback.
  const noKit = (process.env.PATH ?? '').split(':').filter((entry) => !existsSync(join(entry, 'kit'))).join(':')
  await expect(exec('bash', [launcher, 'local', spec, '--no-ticket'], { cwd: app, env: { ...env, ASPIRA_KIT: dirname(dirname(dirname(root))), PATH: noKit, PNPM_HOME: join(dir, 'no-pnpm') } })).rejects.toThrow(/cannot find planner[^\n]*kit update/)
})

it('keeps SKILL.md to mechanics: it names agent/instructions.md and copies none of its rules', async () => {
  const skill = await readFile(join(root, 'skill/aspira-planner/SKILL.md'), 'utf8')
  const normal = (text: string) => text.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ')
  expect(skill).toContain('agent/instructions.md')
  const instructions = await readFile(join(root, 'agent/instructions.md'), 'utf8')
  const { system, researchInstructions, planningInstructions } = await import('../agent/lib/prompts.ts')
  const sentences = [instructions, system, researchInstructions, planningInstructions].flatMap((text) => text.split(/(?<=[.;])\s+/)).map((sentence) => normal(sentence).replace(/[.;]$/, '').trim()).filter((sentence) => sentence.length >= 25)
  expect(sentences.length).toBeGreaterThan(20)
  for (const sentence of sentences) expect(normal(skill), sentence).not.toContain(sentence)
  // The router's key rules, as fragments a paraphrase would keep.
  for (const fragment of ['competing plan', 'retries incur', 'automatically retry', 'block planning', 'not ready for implementation', 'cloned by the caller', 'have been executed']) expect(normal(skill), fragment).not.toContain(fragment)
})
