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
const exec = promisify(execFile)
// What the launcher puts in front of every agent script: amaro as the type-stripping hook, then the env files that exist.
const loader = join(root, '../node_modules/amaro/dist/register-strip.mjs')
const eve = join(root, '../node_modules/eve/bin/eve.js')
const prefix = ['--import', loader, '--experimental-strip-types']
const command = (args: string[]) => args.filter((a) => !a.startsWith('--env-file='))

// The skill as the global harness installs it: a copy under <HOME>/.claude/skills with .kit-version at the
// package's version, a `kit` on PATH whose package-dir names this package, and the aspira.json that makes
// the sandbox a project (a launcher finds its project from the working directory).
async function installGlobal(dir: string, bin: string) {
  const home = join(dir, 'home')
  const skill = join(home, '.claude/skills/aspira-implementor')
  await cp(join(root, 'skill/aspira-implementor'), skill, { recursive: true })
  const { version } = JSON.parse(await readFile(join(dirname(root), 'package.json'), 'utf8')) as { version: string }
  await writeFile(join(skill, '.kit-version'), `${version}\n`)
  await writeFile(join(bin, 'kit'), `#!/bin/sh\n[ "$1" = package-dir ] && echo '${dirname(root)}'\nexit 0\n`, { mode: 0o755 })
  await writeFile(join(dir, 'aspira.json'), '{}')
  return { home, launcher: join(skill, 'scripts/implementor.sh') }
}

it('keeps the agent procedure eve loads, carrying every step of the contract', async () => {
  const procedure = await readFile(join(root, PROCEDURE), 'utf8')
  expect(procedure).toMatch(/^---\nname: aspira-implementor\ndescription: .+\n---\n/)
  for (const step of ['## 1. Resolve the input and gate it', '## 2. Load the standards', '## 3. Draft the plan', '## 4. Analyze the plan and decide how to parallelize', '## 5. Execute', '## 6. Final verification', '## 7. Progress log and report']) expect(procedure).toContain(step)
  for (const term of ['needs-author', 'incomplete', 'Agent Instructions', 'load-knowledge', 'trace/guidelines.md', 'WRITE SCOPE', 'Hot files', '--max-parallel', 'Spec: <path>', 'implementation.md', 'publish-branch', '**A plan**', '**A spec**', '**A ticket**', 'Ticket: <key>', '## Run to completion', 'Assumptions', 'A leading `@`']) expect(procedure).toContain(term)
})

it('is a Claude Code skill that only launches the agent or steps --local, and names the agent files as the authority', async () => {
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
  // User-invoked only (F44): the model never starts it on its own initiative.
  expect(skill).toMatch(/^---\nname: aspira-implementor\ndescription: .+\nargument-hint: .+\ndisable-model-invocation: true\n---\n/)
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
  // A node that records its arguments (one per line, one block per call) instead of running, answers the
  // ticket step with a fake working folder, and prints the agent's report lines for an invoke. The run
  // record is real: export-record.ts and the launcher's `node -p` read of its status run on the real
  // node, so finish gets the status the agent reported, mapped as the record maps it.
  await writeFile(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      '{ printf \'%s\\n\' "$@"; echo ---; } >> "$CAPTURE"',
      'case " $* " in',
      '  *"/scripts/export-record.ts "*|*" -p "*) exec "$REAL_NODE" "$@" ;;',
      '  *" start "*) printf \'folder=%s\\nid=NOM-4\\ntitle=Explore pagination\\nurl=https://www.notion.so/nom-4\\nbefore=Ready: Plan\\nstatus=In Progress: Implementation\\ninput=%s\\n\' "$TICKET_FOLDER" "$TICKET_INPUT" ;;',
      '  *" invoke "*) echo "stub run completed"; echo "status: ${INVOKE_STATUS:-incomplete}"; [ -z "${INVOKE_PR:-}" ] || echo "Pull request: $INVOKE_PR" ;;',
      '  *) echo "stub run completed" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const { home, launcher } = await installGlobal(dir, bin)
  const capture = join(dir, 'arguments')
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, REAL_NODE: process.execPath, CAPTURE: capture, IMPLEMENTOR_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', TICKET_FOLDER: '', TICKET_INPUT: '', INVOKE_STATUS: '', INVOKE_PR: '' }
  const calls = async (): Promise<string[][]> => (await readFile(capture, 'utf8')).split('---\n').filter((block) => block.trim() !== '').map((block) => command(block.split('\n').filter(Boolean)))
  /** The arguments of the last node call. */
  const captured = async (): Promise<string[]> => (await calls()).at(-1) ?? []
  const reset = () => writeFile(capture, '')
  return { dir, env, captured, calls, reset, launcher }
}

const tail = 'Report status, branch, commits, the feature table, deviations, blockers and the pull request link if any.'

it('launches the agent on a GitHub repository with the same prompt the remote launcher always sent', async () => {
  const { dir, env, captured, launcher } = await stubs()
  const started = await exec('bash', [launcher, 'start', 'docs/plans/my feature/plan.review', '--no-ticket', '--repo', 'aspiralabs/nomnomzz', '--ref', 'develop'], { cwd: dir, env })
  const args = await captured()
  expect(args.slice(0, 5)).toEqual([...prefix, eve, 'invoke'])
  expect(started.stdout).toContain('agent: implementor@')
  // Byte for byte what implement-remote.sh sent: the default path's prompt is unchanged.
  expect(args[5]).toBe(`Implement docs/plans/my feature/plan.review in the GitHub repository aspiralabs/nomnomzz, starting from branch develop. Follow the aspira-implementor skill. Push the branch; do not open a pull request. ${tail}`)
  const run = started.stdout.match(/^run: (.+)$/m)![1]!
  // What status and wait report, and the export records: the agent package, version, where it ran from.
  expect(JSON.parse(await readFile(join(run, 'agent.json'), 'utf8'))).toEqual({ name: 'implementor', version: expect.stringMatching(/^\d+\.\d+\.\d+/), path: root, source: 'global', installed: false })
  const waited = (await exec('bash', [launcher, 'wait', run, '--max', '5'], { env })).stdout
  expect(waited).toContain('finished')
  expect(waited).toContain('agent: implementor@')
  await exec('bash', [launcher, 'start', 'specs/x.md', '--no-ticket', '--repo', 'https://github.com/aspiralabs/nomnomzz', '--pr'], { cwd: dir, env })
  expect((await captured()).at(-1)).toBe(`Implement specs/x.md in the GitHub repository https://github.com/aspiralabs/nomnomzz. Follow the aspira-implementor skill. Push the branch and open a draft pull request. ${tail}`)
  await expect(exec('bash', [launcher, 'start', '/abs/specs/x.md', '--no-ticket', '--repo', 'aspiralabs/nomnomzz'], { cwd: dir, env })).rejects.toThrow('path inside the repository')
  // Without --no-ticket the positional is a ticket, and a GitHub --repo needs the path form.
  await expect(exec('bash', [launcher, 'start', 'specs/x.md', '--repo', 'aspiralabs/nomnomzz'], { cwd: dir, env })).rejects.toThrow('pass --repo owner/name with --no-ticket')
})

it('derives the GitHub repository and branch from a local checkout, and refuses work the agent cannot see', async () => {
  const { dir, env, captured, launcher } = await stubs()
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
  await exec('bash', [launcher, 'start', '@specs/cart.md', '--no-ticket'], { cwd: repo, env })
  expect((await captured()).at(-1)).toBe(expected)
  // From a subdirectory, the source is still made repository-relative.
  await exec('bash', [launcher, 'start', 'cart.md', '--no-ticket'], { cwd: join(repo, 'specs'), env })
  expect((await captured()).at(-1)).toBe(expected)
  // A path without --no-ticket is refused, naming the flag.
  await expect(exec('bash', [launcher, 'start', 'specs/cart.md'], { cwd: repo, env })).rejects.toThrow('is a file path, not a ticket; pass --no-ticket')
  await writeFile(join(repo, 'specs/cart.md'), '# Cart, edited\n')
  await expect(exec('bash', [launcher, 'start', 'specs/cart.md', '--no-ticket'], { cwd: repo, env })).rejects.toThrow('uncommitted')
  await git('commit', '-qam', 'edit')
  await expect(exec('bash', [launcher, 'start', 'specs/cart.md', '--no-ticket'], { cwd: repo, env })).rejects.toThrow('not pushed')
})

it('steps --local synchronously with absolute paths, without screen or a gateway key', async () => {
  const { dir, env, captured, launcher } = await stubs()
  const local = { ...env, AI_GATEWAY_API_KEY: '' }
  await mkdir(join(dir, 'specs'))
  await writeFile(join(dir, 'specs/x.md'), '# X\n')
  await exec('bash', [launcher, 'local', '@specs/x.md', '--no-ticket', '--guidelines', 'rules.md', '--max-parallel', '2', '--work', 'out', '--finish'], { cwd: dir, env: local })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), '--repo', dir, '--no-ticket', join(dir, 'specs/x.md'), '--guidelines', join(dir, 'rules.md'), '--max-parallel', '2', '--work', join(dir, 'out'), '--finish'])
  await exec('bash', [launcher, 'start', 'specs/x.md', '--no-ticket', '--local', '--serial'], { cwd: dir, env: local })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), '--repo', dir, '--no-ticket', join(dir, 'specs/x.md'), '--serial'])
  // KIT-51: --cloud on the local command is the opposite mode; refused, never silently run in the session.
  await expect(exec('bash', [launcher, 'local', 'specs/x.md', '--no-ticket', '--cloud'], { cwd: dir, env: local })).rejects.toThrow('--cloud runs the separate agent')
  await expect(exec('bash', [launcher, 'local', 'specs/x.md', '--no-ticket', '--repo', 'aspiralabs/nomnomzz'], { cwd: dir, env: local })).rejects.toThrow('the default mode builds a local checkout')
  // The ticket form: the ID or a URL as --ticket, nothing for the one working folder, --force-pull and --verify with it.
  await exec('bash', [launcher, 'local', 'NOM-4'], { cwd: dir, env: local })
  expect(await captured()).toEqual([...prefix, join(root, 'scripts/local.ts'), '--repo', dir, '--ticket', 'NOM-4'])
  await exec('bash', [launcher, 'local', 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', '--force-pull', '--serial'], { cwd: dir, env: local })
  expect((await captured()).slice(4)).toEqual(['--repo', dir, '--ticket', 'https://app.notion.com/p/3ec3e59b22588102becfce78d66142e1', '--serial', '--force-pull'])
  await exec('bash', [launcher, 'local'], { cwd: dir, env: local })
  expect((await captured()).slice(4)).toEqual(['--repo', dir])
  await exec('bash', [launcher, 'local', 'NOM-4', '--verify'], { cwd: dir, env: local })
  expect((await captured()).slice(4)).toEqual(['--repo', dir, '--ticket', 'NOM-4', '--verify'])
  await expect(exec('bash', [launcher, 'local', 'specs/x.md'], { cwd: dir, env: local })).rejects.toThrow('is a file path, not a ticket; pass --no-ticket')
  await expect(exec('bash', [launcher, 'local', '--no-ticket'], { cwd: dir, env: local })).rejects.toThrow('--no-ticket runs the implementor on a source path')
})

it('start with a ticket runs the board step first, builds the pulled plan, and finishes on the board after the run', async () => {
  const { dir, env, calls, reset, launcher } = await stubs()
  const mirror = join(dir, 'mirror.git')
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '--bare', mirror])
  await exec('git', ['init', '-q', '-b', 'feat/nom-4-explore-pagination', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  const folder = join(repo, '.work/nom-4-explore-pagination')
  const plan = join(folder, 'plan.review/plan.reviewed.md')
  await mkdir(dirname(plan), { recursive: true })
  await writeFile(plan, '# Plan\n')
  await git('add', '.')
  await git('commit', '-qm', 'plan')
  // The upstream is a local bare repository; the origin's URL is what names the GitHub repository.
  await git('remote', 'add', 'mirror', mirror)
  await git('push', '-q', '-u', 'mirror', 'feat/nom-4-explore-pagination')
  await git('remote', 'add', 'origin', 'https://github.com/aspiralabs/nomnomzz.git')
  const ticketEnv = { ...env, TICKET_FOLDER: folder, TICKET_INPUT: plan, INVOKE_STATUS: 'complete', INVOKE_PR: 'https://github.com/aspiralabs/nomnomzz/pull/7' }
  const out = await exec('bash', [launcher, 'start', 'NOM-4', '--pr', '--force-pull'], { cwd: repo, env: ticketEnv })
  const first = await calls()
  const [board, run] = first
  const finish = first.find((call) => call.includes('finish'))
  expect(board).toEqual([...prefix, join(root, 'scripts/ticket.ts'), 'start', 'NOM-4', '--repo', repo, '--force-pull'])
  expect(out.stdout).toContain('ticket: NOM-4 Explore pagination (https://www.notion.so/nom-4)')
  expect(out.stdout).toContain('status: Ready: Plan -> In Progress: Implementation')
  expect(out.stdout).toContain('source: .work/nom-4-explore-pagination/plan.review/plan.reviewed.md')
  expect(run!.slice(0, 5)).toEqual([...prefix, eve, 'invoke'])
  expect(run![5]).toBe(`Implement .work/nom-4-explore-pagination/plan.review/plan.reviewed.md in the GitHub repository aspiralabs/nomnomzz, starting from branch feat/nom-4-explore-pagination. Follow the aspira-implementor skill. Push the branch and open a draft pull request. The ticket's board moves and pushes are made by the launcher around this run; do not call board yourself. ${tail}`)
  // finish takes only the run status from the record (an older agent's "complete" reads as ready):
  // no --ok/--failed, the status alone decides the pushes and moves (F7, F53).
  expect(finish).toEqual([...prefix, join(root, 'scripts/ticket.ts'), 'finish', '--repo', repo, '--folder', folder, '--run-status', 'ready', '--pr-url', 'https://github.com/aspiralabs/nomnomzz/pull/7', '--export', join(folder, 'plan.review')])
  // Without --pr no PR is set, and a run that did not finish carries its own status to finish.
  await reset()
  await exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: { ...ticketEnv, INVOKE_STATUS: 'blocked' } })
  expect((await calls()).find((call) => call.includes('finish'))).toEqual([...prefix, join(root, 'scripts/ticket.ts'), 'finish', '--repo', repo, '--folder', folder, '--run-status', 'blocked', '--export', join(folder, 'plan.review')])
  // A ticket with no Plan page yet stops before the agent.
  await expect(exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: { ...ticketEnv, TICKET_INPUT: '' } })).rejects.toThrow('has no Plan page yet')
  // A refusal from the board step (exit 3) stops the launcher before anything is launched.
  await writeFile(join(dir, 'bin', 'node'), '#!/bin/bash\necho "implementor: refused: NOM-4 is Grooming" >&2\nexit 3\n', { mode: 0o755 })
  await expect(exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: ticketEnv })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('refused') })
  // With .work/ gitignored (kit init's default) the cloud agent cannot read the pulled plan: refused before any board action.
  await writeFile(join(repo, '.gitignore'), '.work/\n')
  await expect(exec('bash', [launcher, 'start', 'NOM-4'], { cwd: repo, env: ticketEnv })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('cannot read .work/ (gitignored)') })
})

it('T55 runs the agent `kit package-dir` names, never the project node_modules one, and refuses a working directory with no aspira.json', async () => {
  const { dir, env, captured, launcher } = await stubs()
  const local = { ...env, AI_GATEWAY_API_KEY: '' }
  // An app whose node_modules/@aspiralabs/ai is a symlink to a package (the pnpm layout): the launcher must not take it.
  const { version } = JSON.parse(await readFile(join(dirname(root), 'package.json'), 'utf8')) as { version: string }
  const app = join(dir, 'app')
  const projectPackage = join(dir, 'project-copy/aspira-ai')
  const projectAgent = join(projectPackage, 'implementor')
  await mkdir(join(projectAgent, 'scripts'), { recursive: true })
  await mkdir(join(projectAgent, 'skill'))
  await writeFile(join(projectPackage, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version }, null, 2))
  await writeFile(join(projectAgent, 'scripts/local.ts'), '')
  await mkdir(join(app, 'node_modules/@aspiralabs'), { recursive: true })
  await symlink(projectPackage, join(app, 'node_modules/@aspiralabs/ai'))
  await writeFile(join(app, 'package.json'), '{"name":"app"}')
  await mkdir(join(app, 'specs'), { recursive: true })
  await writeFile(join(app, 'specs/x.md'), '# X\n')
  await exec('git', ['init', '-q', app])
  // The global kit names another package: that agent runs.
  const globalPackage = join(dir, 'global-ai/aspira-ai')
  const globalAgent = join(globalPackage, 'implementor')
  await mkdir(join(globalAgent, 'scripts'), { recursive: true })
  await mkdir(join(globalAgent, 'skill'))
  await writeFile(join(globalPackage, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version }, null, 2))
  await writeFile(join(globalAgent, 'scripts/local.ts'), '')
  await writeFile(join(dir, 'bin', 'kit'), `#!/bin/sh\n[ "$1" = package-dir ] && echo '${globalPackage}'\nexit 0\n`, { mode: 0o755 })
  await exec('bash', [launcher, 'local', 'specs/x.md', '--no-ticket'], { cwd: app, env: local })
  const args = await captured()
  expect(args).toContain(join(globalAgent, 'scripts/local.ts'))
  expect(args).not.toContain(join(projectAgent, 'scripts/local.ts'))
  // A working directory with no aspira.json at or above it is not a project.
  const bare = await realpath(await mkdtemp(join(tmpdir(), 'implementor-skill-bare-')))
  await exec('git', ['init', '-q', bare])
  await writeFile(join(bare, 'idea.md'), 'Let people save items.')
  await expect(exec('bash', [launcher, 'local', 'specs/x.md', '--no-ticket'], { cwd: bare, env: local })).rejects.toThrow('no Aspira project here')
})
