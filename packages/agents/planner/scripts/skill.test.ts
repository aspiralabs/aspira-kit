import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-planner/scripts/planner.sh')
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(root, 'node_modules/amaro/dist/register-strip.mjs')
const eve = join(root, 'node_modules/eve/bin/eve.js')
const envArgs = (args: string[]) => args.filter((a) => a.startsWith('--env-file='))
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

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
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, PLANNER_AGENT_DIR: '', SPEC_TO_PLAN_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', TICKET_FOLDER: '', TICKET_INPUT: '' }
  /** The arguments of the last node call. */
  const captured = async (): Promise<string[]> => calls().then((all) => all.at(-1) ?? [])
  const calls = async (): Promise<string[][]> => (await readFile(capture, 'utf8')).split('---\n').filter((block) => block.trim() !== '').map((block) => block.split('\n').filter(Boolean))
  const reset = () => writeFile(capture, '')
  return { dir, env, captured, calls, reset }
}

it('routes the skill to the official CLI or Notion-loading eve entry point with literal paths', async () => {
  const { dir, env, calls, reset } = await stubs('planner-skill-')
  const repo = join(dir, 'repo with spaces')
  await mkdir(repo)
  await exec('git', ['init', repo])
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
  expect(direct.stdout).toContain('agent: @aspiralabs/planner@')
  expect(direct.stdout).toContain(`(package, ${root})`)
  expect(direct.stderr).toContain(`planner: running kit source at ${root}, not the installed @aspiralabs/planner`)
  const run = direct.stdout.match(/^run: (.+)$/m)![1]!
  // What status and wait report, and the export records: the agent package, version, where it ran from.
  expect(JSON.parse(await readFile(join(run, 'agent.json'), 'utf8'))).toEqual({ name: '@aspiralabs/planner', version: expect.stringMatching(/^\d+\.\d+\.\d+/), path: root, source: 'package', installed: false })
  const status = await exec('bash', [launcher, 'status', run], { cwd: repo, env })
  expect(status.stdout).toContain('agent: @aspiralabs/planner@')
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
  await exec('bash', [launcher, 'start', spec, '--no-ticket', '--repo', repo, '--output', custom, '--guidelines', guidelines], { cwd: dir, env })
  expect((await calls())[0]!.slice(-3)).toEqual([repo, guidelines, custom])
  await expect(exec('bash', [launcher, 'start', spec, '--no-ticket', '--rounds', '2'], { cwd: repo, env })).rejects.toThrow('unknown option')
})

it('steps --local through the agent package without launching the agent', async () => {
  const { dir, env, captured, reset } = await stubs('planner-skill-local-')
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'spec.reviewed'), { recursive: true })
  await exec('git', ['init', repo])
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
  const { dir, env, calls } = await stubs('planner-skill-ticket-')
  const repo = join(dir, 'repo')
  const folder = join(repo, '.work', 'nom-4-explore-pagination')
  await mkdir(join(folder, 'spec.reviewed'), { recursive: true })
  await exec('git', ['init', repo])
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
  expect(command(finish!)).toEqual(['--import', loader, '--experimental-strip-types', join(root, 'scripts/ticket.ts'), 'finish', '--repo', repo, '--folder', folder, '--failed', '--run-status', '{}', '--export', join(folder, 'plan.review')])
  // A refusal from the board step (exit 3) stops the launcher before anything is launched.
  await writeFile(join(dir, 'bin', 'node'), '#!/bin/bash\necho "planner: refused: NOM-4 is Grooming" >&2\nexit 3\n', { mode: 0o755 })
  await expect(exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: ticketEnv })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('refused') })
})

it('resolves the agent in order: PLANNER_AGENT_DIR, the package installed under the project, then its own location; never $ASPIRA_KIT', async () => {
  const { dir, env, captured } = await stubs('planner-skill-resolve-')
  // A project with @aspiralabs/agents installed by pnpm: the agents sit beside the meta-package in the store, not in the project's node_modules.
  const app = join(dir, 'app')
  const store = join(app, 'node_modules/.pnpm/@aspiralabs+agents@9.9.9/node_modules')
  const installed = join(store, '@aspiralabs/planner')
  for (const [name, path] of [['@aspiralabs/agents', join(store, '@aspiralabs/agents')], ['@aspiralabs/planner', installed]] as const) {
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
  await mkdir(join(app, 'docs/feature'), { recursive: true })
  await exec('git', ['init', app])
  const spec = join(app, 'docs/feature/spec.md')
  await writeFile(spec, '# Spec')
  // The skill as kit init installs it: a copy under the project's .claude/skills/.
  const copy = join(app, '.claude/skills/aspira-planner/scripts/planner.sh')
  await cp(launcher, copy)
  const stale = join(dir, 'stale-kit/packages/agents/planner')

  // Installed: found walking up from the working directory, even a subdirectory; the project's env file goes with it.
  const fromApp = await exec('bash', [copy, 'local', spec, '--no-ticket'], { cwd: join(app, 'docs'), env: { ...env, ASPIRA_KIT: stale } })
  expect(command(await captured())).toEqual(['--import', join(store, 'amaro/dist/register-strip.mjs'), '--experimental-strip-types', join(installed, 'scripts/local.ts'), '--repo', app, '--no-ticket', spec, '--output', join(app, 'docs/feature/plan.review')])
  expect(envArgs(await captured())).toEqual([`--env-file=${join(app, '.env.local')}`])
  expect(fromApp.stderr).not.toContain('kit source')
  // The installed package also beats the kit launcher's own location when the kit's launcher runs inside the project.
  await exec('bash', [launcher, 'local', spec, '--no-ticket'], { cwd: app, env })
  expect(command(await captured())[3]).toBe(join(installed, 'scripts/local.ts'))
  // The kit launcher outside any project: its own package, and it says so.
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere)
  await exec('git', ['init', elsewhere])
  const own = await exec('bash', [launcher, 'local', spec, '--no-ticket', '--repo', elsewhere], { cwd: elsewhere, env })
  expect(command(await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(own.stderr).toContain(`planner: running kit source at ${root}, not the installed @aspiralabs/planner`)
  // PLANNER_AGENT_DIR wins over the installed package, and the report says it is set.
  const override = await exec('bash', [copy, 'local', spec, '--no-ticket'], { cwd: app, env: { ...env, PLANNER_AGENT_DIR: root } })
  expect(command(await captured())[3]).toBe(join(root, 'scripts/local.ts'))
  expect(override.stderr).toContain(`planner: PLANNER_AGENT_DIR is set: running kit source at ${root}, not the installed @aspiralabs/planner`)
  await expect(exec('bash', [copy, 'local', spec, '--no-ticket'], { cwd: app, env: { ...env, PLANNER_AGENT_DIR: dir } })).rejects.toThrow('PLANNER_AGENT_DIR is not the @aspiralabs/planner package')
  // Nothing installed, and the copied launcher is not inside a package: a clear error, with no $ASPIRA_KIT fallback.
  const bare = join(dir, 'bare')
  await mkdir(join(bare, '.claude/skills/aspira-planner/scripts'), { recursive: true })
  await cp(launcher, join(bare, '.claude/skills/aspira-planner/scripts/planner.sh'))
  await exec('git', ['init', bare])
  await writeFile(join(bare, 'spec.md'), '# Spec')
  await expect(exec('bash', [join(bare, '.claude/skills/aspira-planner/scripts/planner.sh'), 'local', 'spec.md', '--no-ticket'], { cwd: bare, env: { ...env, ASPIRA_KIT: dirname(dirname(dirname(root))) } })).rejects.toThrow('cannot find @aspiralabs/planner: install @aspiralabs/agents')
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
