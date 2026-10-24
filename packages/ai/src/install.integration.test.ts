// The kit as a project gets it: packages/ai is packed with `pnpm pack` into one tarball, installed
// into a scratch project as its only @aspiralabs devDependency, `kit init` writes the skills, and
// the launchers run from node_modules with no ASPIRA_KIT set. Needs pnpm and git; the package's own
// dependencies are resolved online and their tarballs come from the pnpm store.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { writeAspira } from './aspira.js'
import { doctor } from './doctor.js'
import { AGENTS, skillDir, VERSION_FILE } from './skills.js'
import { initNext } from './stacks/next.js'

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(dirname(kit))
const AI = join(repo, 'packages', 'ai')
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const aiVersion = () => (JSON.parse(readFileSync(join(AI, 'package.json'), 'utf8')) as { version: string }).version

let scratch: string
let app: string
let tarball: string
/** What the one kit init in beforeAll logged. */
const initLines: string[] = []

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kit-install-')))
  const tarballs = join(scratch, 'tarballs')
  mkdirSync(tarballs)
  const file = run('pnpm', ['pack', '--pack-destination', tarballs], AI).trim().split('\n').at(-1)!
  tarball = join(tarballs, file.split('/').at(-1)!)
  app = join(scratch, 'app')
  mkdirSync(join(app, 'app'), { recursive: true })
  writeFileSync(join(app, 'app', 'globals.css'), '@import "tailwindcss";\n')
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'scratch-app', private: true, type: 'module', devDependencies: { '@aspiralabs/ai': `file:${tarball}` } }, null, 2)}\n`)
  // pnpm 12 wants every dependency with a build script approved; none is needed to run the agents.
  const builds = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8').replace(/^packages:[\s\S]*?\n\n/, '').replace(/patchedDependencies:[\s\S]*$/, '')
  writeFileSync(join(app, 'pnpm-workspace.yaml'), builds)
  run('pnpm', ['install', '--ignore-scripts', '--config.confirmModulesPurge=false'], app)
  run('git', ['init', '-q', app], scratch)
  writeAspira({ projectRoot: app, board: BOARD, dryRun: false, log: () => {} })
  // kit init's install step adds the registry package; here it is a no-op, the tarball is already installed.
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\n[ "$1" = add ] && exit 0\nexec /usr/bin/env pnpm "$@"\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    await initNext({ projectRoot: app, dryRun: false, log: (line) => initLines.push(line) })
  } finally {
    process.env.PATH = path
  }
})

const kitBin = () => join(app, 'node_modules', '.bin', 'kit')

describe('an installed project', () => {
  it('installs one package, and kit init writes the eleven skills from it; doctor, kit playbook and the hooks use it', () => {
    expect(JSON.parse(readFileSync(join(app, 'node_modules', '@aspiralabs', 'ai', 'package.json'), 'utf8'))).toMatchObject({ name: '@aspiralabs/ai' })
    expect(readdirSync(join(app, 'node_modules', '@aspiralabs'))).toEqual(['ai'])
    const written = initLines.filter((l) => l.startsWith('write  .claude/skills/aspira-'))
    expect(written.filter((l) => AGENTS.some((agent) => l.startsWith(`write  .claude/skills/aspira-${agent} `))).length).toBe(8)
    expect(written.filter((l) => /^write {2}\.claude\/skills\/aspira-(cleanup|next|worktree) /.test(l)).length).toBe(3)
    const version = aiVersion()
    for (const agent of AGENTS) {
      expect(existsSync(join(skillDir(app, agent), 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir(app, agent), 'scripts', `${agent}.sh`))).toBe(true)
      expect(readFileSync(join(skillDir(app, agent), '.kit-version'), 'utf8').trim()).toBe(version)
    }
    const report: string[] = []
    doctor(app, (line) => report.push(line))
    const skillLines = report.filter((l) => l.startsWith('ok   .claude/skills/aspira-'))
    expect(skillLines.length).toBe(11)
    expect(skillLines.every((l) => l.includes('matches @aspiralabs/ai'))).toBe(true)
    expect(report.some((l) => l.startsWith('@aspiralabs/ai') && l.includes(`installed ${version}`))).toBe(true)
    expect(report.some((l) => l.includes('@aspiralabs/kit') || l.includes('@aspiralabs/agents'))).toBe(false)
    const playbook = spawnSync(kitBin(), ['playbook'], { cwd: app, encoding: 'utf8' })
    expect(playbook.status, playbook.stderr).toBe(0)
    expect(playbook.stdout.length).toBeGreaterThan(0)
    const usage = spawnSync(kitBin(), [], { cwd: app, encoding: 'utf8' })
    const text = `${usage.stdout}${usage.stderr}`
    for (const word of ['init', 'add auth', 'doctor', 'next', 'cleanup', 'worktree', 'playbook']) expect(text).toContain(word)
    for (const hook of ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh']) expect(existsSync(join(app, 'node_modules', '@aspiralabs', 'ai', 'hooks', hook))).toBe(true)
  })

  it('kit init --board writes aspira.json, and kit doctor fails without it', () => {
    // A project of its own: the shared app already has its aspira.json from beforeAll.
    const project = mkdtempSync(join(scratch, 'board-'))
    writeFileSync(join(project, 'package.json'), '{ "name": "board-app", "private": true }\n')
    const before: string[] = []
    doctor(project, (line) => before.push(line))
    expect(before).toContain('FAIL aspira.json is missing; run kit init --board <Feature Board URL>')
    const lines: string[] = []
    writeAspira({ projectRoot: project, board: BOARD, dryRun: false, log: (line) => lines.push(line) })
    expect(lines[0]).toContain('write  ')
    expect(JSON.parse(readFileSync(join(project, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD })
    const after: string[] = []
    doctor(project, (line) => after.push(line))
    expect(after).toContain('ok   aspira.json names the Feature Board')
  })

  it('runs planner.sh local from node_modules through its knowledge stage with no ASPIRA_KIT set', () => {
    const launcher = join(skillDir(app, 'planner'), 'scripts', 'planner.sh')
    expect(existsSync(launcher)).toBe(true)
    mkdirSync(join(app, 'docs', 'feature'), { recursive: true })
    const spec = join(app, 'docs', 'feature', 'spec.md')
    writeFileSync(spec, '# Feature\n## Intent\nPersist a named item.\n## Acceptance criteria\n### Features\n- [ ] F1: An authorized user can save an item once.\n')
    writeFileSync(join(app, 'src.ts'), 'export const save = () => {}\n')
    run('git', ['add', '.'], app)
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], app)
    const ROOT = 'https://app.notion.com/p/11111111111111111111111111111111'
    const env: NodeJS.ProcessEnv = { ...process.env, KNOWLEDGE_PAGE: ROOT }
    for (const name of ['ASPIRA_KIT', 'PLANNER_AGENT_DIR', 'SPEC_TO_PLAN_AGENT_DIR', 'NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    const out = join(scratch, 'plan.review')
    // Without a snapshot or a NOTION_TOKEN the knowledge stage cannot load the guidelines itself:
    // the run ends blocked naming the token (F52), and the installed package is the one that ran.
    const first = spawnSync('bash', [launcher, 'local', spec, '--no-ticket', '--output', out], { cwd: app, env, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(1)
    expect(first.stderr).not.toContain('kit source')
    const blocked = JSON.parse(first.stdout) as { pending: boolean; status: string; reason: string; agent: { name: string; path: string; installed: boolean } }
    expect(blocked).toMatchObject({ pending: false, status: 'blocked' })
    expect(blocked.reason).toContain('NOTION_TOKEN')
    expect(blocked.agent).toMatchObject({ name: 'planner', installed: true })
    expect(blocked.agent.path).toContain(`${app}/node_modules/`)
    expect(blocked.agent.path.endsWith('/@aspiralabs/ai/planner')).toBe(true)
    // With a load-knowledge snapshot (F50) the knowledge is satisfied and the next stage is research: the whole runtime loaded from node_modules.
    const guidelines = join(scratch, 'REQUIRED.md')
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const ID = '11111111-1111-1111-1111-111111111111'
    const section = `# Agent Instructions\n\n<!-- ${ROOT} -->\n\nREV-001 Inspect source evidence\n`
    const header = { fetchedAt: '2026-10-15T00:00:00.000Z', rootUrl: ROOT, rootId: ID, path: guidelines, bodyHash: sha(section), pages: [{ id: ID, url: ROOT, title: 'Agent Instructions', file: 'INDEX.md', markdownHash: sha('REV-001 Inspect source evidence'), sectionHash: sha(section) }] }
    writeFileSync(guidelines, `<!-- knowledge-snapshot\n${JSON.stringify(header, null, 2)}\n-->\n\nEvery agent reads this file in full before its first finding.\n\n---\n\n${section}`)
    const second = spawnSync('bash', [launcher, 'local', spec, '--no-ticket', '--output', out, '--guidelines', guidelines], { cwd: app, env, encoding: 'utf8' })
    expect(second.status, second.stderr).toBe(0)
    const research = JSON.parse(second.stdout) as { stage: string; tasks: { prompt: string }[]; instructions: string }
    expect(research.stage).toBe('research')
    expect(research.instructions).toContain('/node_modules/')
    expect(readFileSync(research.tasks[0]!.prompt, 'utf8')).toContain('REV-001')
    // The launcher runs from the installed package, not a checkout, even with a stale ASPIRA_KIT exported.
    const stale = spawnSync('bash', [launcher, 'local', spec, '--no-ticket', '--output', out, '--guidelines', guidelines], { cwd: app, env: { ...env, ASPIRA_KIT: join(scratch, 'nowhere') }, encoding: 'utf8' })
    expect(stale.status, stale.stderr).toBe(0)
  })

  it('the build-feature launcher runs the installed driver, and the Playbook resolves through @aspiralabs/ai/playbook', async () => {
    const skill = join(app, '.claude', 'skills', 'aspira-build-feature')
    const launcher = join(skill, 'scripts', 'build-feature.sh')
    expect(existsSync(launcher)).toBe(true)
    expect(readFileSync(join(skill, VERSION_FILE), 'utf8').trim()).toBe(aiVersion())
    const packageDir = join(app, 'node_modules', '@aspiralabs', 'ai', 'build-feature')
    expect(existsSync(join(packageDir))).toBe(true)

    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ['NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    // The invocation is the run-start approval (KIT-20), so its first stage is resolve.
    const first = spawnSync('bash', [launcher, 'local', 'DEMO-1', '--local'], { cwd: app, env, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    expect(first.stderr).not.toContain('running kit source')
    expect((JSON.parse(first.stdout.slice(first.stdout.indexOf('{'))) as { stage: string }).stage).toBe('resolve')
    const script = "const { nextStep, commandFor } = await import('@aspiralabs/ai/playbook'); process.stdout.write(commandFor(nextStep('Ready: Idea'), 'DEMO-1') ?? '')"
    const step = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDir, env, encoding: 'utf8' })
    expect(step.status, step.stderr).toBe(0)
    expect(step.stdout).toBe('/aspira-spec-writer DEMO-1')
  })

  it('kit-skill launchers run the project kit, and without an install each says to install @aspiralabs/ai and run kit init', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ['ASPIRA_KIT', 'NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    const next = spawnSync('bash', [join(app, '.claude', 'skills', 'aspira-next', 'scripts', 'next.sh')], { cwd: app, env, encoding: 'utf8' })
    expect(`${next.stdout}${next.stderr}`).not.toContain('install @aspiralabs/ai')
    const bare = join(scratch, 'no-install')
    mkdirSync(bare)
    run('git', ['init', '-q', bare], scratch)
    writeAspira({ projectRoot: bare, board: BOARD, dryRun: false, log: () => {} })
    cpSync(join(app, '.claude'), join(bare, '.claude'), { recursive: true })
    for (const name of ['next', 'cleanup', 'worktree']) {
      const out = spawnSync('bash', [join(bare, '.claude', 'skills', `aspira-${name}`, 'scripts', `${name}.sh`)], { cwd: bare, env, encoding: 'utf8' })
      const text = `${out.stdout}${out.stderr}`
      expect(out.status, text).toBe(1)
      expect(text).toContain('install @aspiralabs/ai')
      expect(text).toContain('kit init')
      expect(text).not.toMatch(/@aspiralabs\/(agents|kit)/)
    }
    const planner = spawnSync('bash', [join(bare, '.claude', 'skills', 'aspira-planner', 'scripts', 'planner.sh'), 'local'], { cwd: bare, env, encoding: 'utf8' })
    const text = `${planner.stdout}${planner.stderr}`
    expect(planner.status).not.toBe(0)
    expect(text).toContain('@aspiralabs/ai')
    expect(text).toContain('kit init')
    expect(text).not.toMatch(/@aspiralabs\/(agents|kit)/)
  })

  it('pr-reviewer.sh start builds a copy of the agent under .work/.agents that resolves @aspiralabs/ai', () => {
    const bin = join(scratch, 'screen-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'screen'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_GATEWAY_API_KEY: 'dummy' }
    for (const name of ['NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    const launcher = join(skillDir(app, 'pr-reviewer'), 'scripts', 'pr-reviewer.sh')
    const out = spawnSync('bash', [launcher, 'start', app, '--no-ticket', '--yes'], { cwd: app, env, encoding: 'utf8', timeout: 540_000 })
    expect(out.status, `${out.stdout}${out.stderr}`).toBe(0)
    expect(out.stdout).toContain('started')
    const copy = join(app, '.work', '.agents', `pr-reviewer@${aiVersion()}`)
    expect(existsSync(join(copy, '.output'))).toBe(true)
    expect(readFileSync(join(copy, '.built-from'), 'utf8')).toContain('/@aspiralabs/ai/pr-reviewer')
    const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> }
    expect(manifest.dependencies.eve).toBeTruthy()
    expect(manifest.name).not.toBe('@aspiralabs/ai')
    expect(existsSync(join(copy, 'node_modules', '@aspiralabs', 'ai', 'package.json'))).toBe(true)
  }, 600_000)
})

describe('a global install and the bootstrap', () => {
  it('a global kit runs anywhere, and in a project prints what the project copy prints', () => {
    const home = join(scratch, 'global')
    const env: NodeJS.ProcessEnv = { ...process.env, PNPM_HOME: join(home, 'pnpm'), XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state') }
    mkdirSync(env.PNPM_HOME!, { recursive: true })
    env.PATH = `${env.PNPM_HOME}:${process.env.PATH}`
    run('pnpm', ['add', '-g', `file:${tarball}`], scratch, env)
    const empty = mkdtempSync(join(scratch, 'empty-'))
    const playbook = spawnSync('kit', ['playbook'], { cwd: empty, env, encoding: 'utf8' })
    expect(playbook.status, playbook.stderr).toBe(0)
    expect(playbook.stdout.length).toBeGreaterThan(0)
    const global = spawnSync('kit', ['doctor'], { cwd: app, env, encoding: 'utf8' })
    const local = spawnSync(kitBin(), ['doctor'], { cwd: app, encoding: 'utf8' })
    expect(global.stdout).toBe(local.stdout)
    expect(global.status).toBe(local.status)
  }, 300_000)

  it('pnpm dlx kit resolves the kit bin from @aspiralabs/ai and prints the usage', () => {
    const empty = mkdtempSync(join(scratch, 'dlx-'))
    const out = spawnSync('pnpm', [`--package=file:${tarball}`, 'dlx', 'kit'], { cwd: empty, encoding: 'utf8' })
    expect(`${out.stdout}${out.stderr}`).toContain('kit init --stack next')
  }, 300_000)
})
