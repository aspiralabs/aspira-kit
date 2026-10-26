// The kit as an engineer gets it: packages/ai is packed with `pnpm pack` into one tarball and installed
// globally (`pnpm add -g`, under a scratch PNPM_HOME), the global `kit init` wires a scratch project that
// has no @aspiralabs/ai of its own, and the launchers run the global install with no ASPIRA_KIT set.
// The engineer's machine is a scratch HOME (with the XDG folders and no system git config), so the global
// harness the kit writes lands under it: ~/.claude/skills, ~/.claude/hooks and the global git ignore.
// Needs pnpm and git; the package's own dependencies are resolved online and their tarballs come from the pnpm store.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { writeAspira } from './aspira.js'
import { doctor } from './doctor.js'
import { AGENTS, KIT_SKILLS, VERSION_FILE } from './skills.js'

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(dirname(kit))
const AI = join(repo, 'packages', 'ai')
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const aiVersion = () => (JSON.parse(readFileSync(join(AI, 'package.json'), 'utf8')) as { version: string }).version

let scratch: string
/** The scratch HOME of the packed-install environment: the global harness is written under it. */
let home: string
/** A global skill folder: ~/.claude/skills/aspira-<name> under the scratch HOME. */
const globalSkill = (name: string) => join(home, '.claude', 'skills', `aspira-${name}`)
let app: string
let tarball: string
/** The global install's package directory, as `kit package-dir` prints it. */
let globalDir: string
/** What the one kit init in beforeAll logged. */
const initLines: string[] = []

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kit-install-')))
  const tarballs = join(scratch, 'tarballs')
  mkdirSync(tarballs)
  const file = run('pnpm', ['pack', '--pack-destination', tarballs], AI).trim().split('\n').at(-1)!
  tarball = join(tarballs, file.split('/').at(-1)!)
  app = join(scratch, 'app')
  mkdirSync(join(app, 'app'), { recursive: true })
  writeFileSync(join(app, 'app', 'globals.css'), '@import "tailwindcss";\n')
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'scratch-app', private: true, type: 'module' }, null, 2)}\n`)
  run('git', ['init', '-q', app], scratch)
  writeAspira({ projectRoot: app, board: BOARD, dryRun: false, log: () => {} })
  // The global install, in a PNPM_HOME of its own; every later spawn in this file finds its kit on PATH.
  const globalRoot = join(scratch, 'global')
  home = join(scratch, 'home')
  mkdirSync(home)
  Object.assign(process.env, { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', PNPM_HOME: join(globalRoot, 'pnpm'), XDG_DATA_HOME: join(globalRoot, 'data'), XDG_CONFIG_HOME: join(globalRoot, 'config'), XDG_CACHE_HOME: join(globalRoot, 'cache'), XDG_STATE_HOME: join(globalRoot, 'state') })
  mkdirSync(join(process.env.PNPM_HOME!, 'bin'), { recursive: true })
  process.env.PATH = `${join(process.env.PNPM_HOME!, 'bin')}:${process.env.PNPM_HOME}:${process.env.PATH}`
  run('pnpm', ['add', '-g', `file:${tarball}`], scratch)
  globalDir = run('kit', ['package-dir'], scratch).trim()
  // kit init's install step adds ui and config from the registry; here it is a no-op.
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\n[ "$1" = add ] && exit 0\nexec /usr/bin/env pnpm "$@"\n', { mode: 0o755 })
  initLines.push(...run('kit', ['init', '--stack', 'next'], app, { ...process.env, PATH: `${bin}:${process.env.PATH}` }).split('\n'))
}, 300_000)

describe('a project on the global install', () => {
  it('T25: kit init installs no @aspiralabs/ai and writes no skills or hooks into the project; the scratch HOME has them from the global install, and doctor and kit playbook use it', () => {
    expect(JSON.parse(readFileSync(join(globalDir, 'package.json'), 'utf8'))).toMatchObject({ name: '@aspiralabs/ai' })
    expect(globalDir).toContain(`${scratch}/global/`)
    expect(existsSync(join(app, 'node_modules', '@aspiralabs', 'ai'))).toBe(false)
    expect(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))).not.toHaveProperty('devDependencies.@aspiralabs/ai')
    expect(existsSync(join(app, '.claude', 'skills'))).toBe(false)
    expect(existsSync(join(app, '.claude', 'hooks'))).toBe(false)
    expect(initLines.some((l) => l.includes('.claude/skills/aspira-') || l.includes('.claude/hooks/aspira'))).toBe(false)
    const version = aiVersion()
    for (const name of [...AGENTS, ...KIT_SKILLS]) {
      expect(existsSync(join(globalSkill(name), 'SKILL.md')), name).toBe(true)
      expect(existsSync(join(globalSkill(name), 'scripts', `${name}.sh`)), name).toBe(true)
      expect(readFileSync(join(globalSkill(name), VERSION_FILE), 'utf8').trim(), name).toBe(version)
    }
    for (const hook of ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh']) expect(readFileSync(join(home, '.claude', 'hooks', 'aspira', hook), 'utf8')).toBe(readFileSync(join(globalDir, 'hooks', hook), 'utf8'))
    const report = spawnSync('kit', ['doctor'], { cwd: app, encoding: 'utf8' }).stdout.split('\n')
    const skillLines = report.filter((l) => l.startsWith('ok') && l.includes('~/.claude/skills/aspira-'))
    expect(skillLines.length).toBe(11)
    expect(report.filter((l) => l.startsWith('ok') && ['session-start.sh', 'deny-tier3.sh', 'audit-log.sh'].some((hook) => l.includes(hook))).length).toBeGreaterThanOrEqual(3)
    expect(report.some((l) => l.startsWith('FAIL'))).toBe(false)
    expect(report.some((l) => l.startsWith('@aspiralabs/ai') && l.includes(`global ${version}`))).toBe(true)
    expect(report.some((l) => l.includes('@aspiralabs/kit') || l.includes('@aspiralabs/agents'))).toBe(false)
    const playbook = spawnSync('kit', ['playbook'], { cwd: app, encoding: 'utf8' })
    expect(playbook.status, playbook.stderr).toBe(0)
    expect(playbook.stdout.length).toBeGreaterThan(0)
    const usage = spawnSync('kit', [], { cwd: app, encoding: 'utf8' })
    const text = `${usage.stdout}${usage.stderr}`
    for (const word of ['init', 'add auth', 'doctor', 'next', 'cleanup', 'worktree', 'playbook']) expect(text).toContain(word)
  })

  it('kit init --board writes aspira.json, and kit doctor fails without it', () => {
    // A project of its own: the shared app already has its aspira.json from beforeAll.
    const project = mkdtempSync(join(scratch, 'board-'))
    writeFileSync(join(project, 'package.json'), '{ "name": "board-app", "private": true }\n')
    const before: string[] = []
    doctor(project, (line) => before.push(line), undefined, { home })
    expect(before).toContain('FAIL aspira.json is missing; run kit init --board <Feature Board URL>')
    const lines: string[] = []
    writeAspira({ projectRoot: project, board: BOARD, dryRun: false, log: (line) => lines.push(line) })
    expect(lines[0]).toContain('write  ')
    expect(JSON.parse(readFileSync(join(project, 'aspira.json'), 'utf8'))).toEqual({ board: BOARD })
    const after: string[] = []
    doctor(project, (line) => after.push(line), undefined, { home })
    expect(after).toContain('ok   aspira.json names the Feature Board')
  })

  it('runs planner.sh local from the global install through its knowledge stage with no ASPIRA_KIT set', () => {
    const launcher = join(globalSkill('planner'), 'scripts', 'planner.sh')
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
    expect(blocked.agent.path).toBe(realpathSync(join(globalDir, 'planner')))
    expect(blocked.agent.path.endsWith('/@aspiralabs/ai/planner')).toBe(true)
    // With a load-knowledge snapshot (F50) the knowledge is satisfied and the next stage is research: the whole runtime loaded from the global install.
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
    // The launcher runs from the global install, not a checkout, even with a stale ASPIRA_KIT exported.
    const stale = spawnSync('bash', [launcher, 'local', spec, '--no-ticket', '--output', out, '--guidelines', guidelines], { cwd: app, env: { ...env, ASPIRA_KIT: join(scratch, 'nowhere') }, encoding: 'utf8' })
    expect(stale.status, stale.stderr).toBe(0)
  })

  it('the build-feature launcher runs the global driver, and the Playbook resolves through @aspiralabs/ai/playbook', async () => {
    const skill = globalSkill('build-feature')
    const launcher = join(skill, 'scripts', 'build-feature.sh')
    expect(existsSync(launcher)).toBe(true)
    expect(readFileSync(join(skill, VERSION_FILE), 'utf8').trim()).toBe(aiVersion())
    const packageDir = join(globalDir, 'build-feature')
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

  it('kit-skill launchers run the global kit, and without a global kit on PATH each says to install @aspiralabs/ai and run kit update', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ['ASPIRA_KIT', 'NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    const next = spawnSync('bash', [join(globalSkill('next'), 'scripts', 'next.sh')], { cwd: app, env, encoding: 'utf8' })
    expect(`${next.stdout}${next.stderr}`).not.toContain('install @aspiralabs/ai')
    const bare = join(scratch, 'no-install')
    mkdirSync(bare)
    run('git', ['init', '-q', bare], scratch)
    writeAspira({ projectRoot: bare, board: BOARD, dryRun: false, log: () => {} })
    // No kit on PATH: a machine with one installed would otherwise find it.
    const noKit = { ...env, PATH: (process.env.PATH ?? '').split(':').filter((dir) => !existsSync(join(dir, 'kit'))).join(':') }
    for (const name of ['next', 'cleanup', 'worktree']) {
      const out = spawnSync('bash', [join(globalSkill(name), 'scripts', `${name}.sh`)], { cwd: bare, env: noKit, encoding: 'utf8' })
      const text = `${out.stdout}${out.stderr}`
      expect(out.status, text).toBe(1)
      expect(text).toContain('install @aspiralabs/ai')
      expect(text).toContain('kit update')
      expect(text).not.toContain('kit init')
      expect(text).not.toMatch(/@aspiralabs\/(agents|kit)/)
    }
    const planner = spawnSync('bash', [join(globalSkill('planner'), 'scripts', 'planner.sh'), 'local'], { cwd: bare, env: noKit, encoding: 'utf8' })
    const text = `${planner.stdout}${planner.stderr}`
    expect(planner.status).not.toBe(0)
    expect(text).toContain('@aspiralabs/ai')
    expect(text).toContain('kit update')
    expect(text).not.toContain('kit init')
    expect(text).not.toMatch(/@aspiralabs\/(agents|kit)/)
  })

  it('pr-reviewer.sh start builds a copy of the global agent under .work/.agents that resolves @aspiralabs/ai', () => {
    const bin = join(scratch, 'screen-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'screen'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_GATEWAY_API_KEY: 'dummy' }
    for (const name of ['NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    const launcher = join(globalSkill('pr-reviewer'), 'scripts', 'pr-reviewer.sh')
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
  it('the global kit runs anywhere, and its doctor names the global version and the global settings.json hooks', () => {
    const empty = mkdtempSync(join(scratch, 'empty-'))
    const playbook = spawnSync('kit', ['playbook'], { cwd: empty, encoding: 'utf8' })
    expect(playbook.status, playbook.stderr).toBe(0)
    expect(playbook.stdout.length).toBeGreaterThan(0)
    const report = spawnSync('kit', ['doctor'], { cwd: app, encoding: 'utf8' }).stdout
    expect(report).toContain(`@aspiralabs/ai       global ${aiVersion()}`)
    expect(report.split('\n').some((l) => l.startsWith('ok') && l.includes('~/.claude/settings.json'))).toBe(true)
  })

  it('pnpm dlx kit resolves the kit bin from @aspiralabs/ai and prints the usage', () => {
    const empty = mkdtempSync(join(scratch, 'dlx-'))
    const out = spawnSync('pnpm', [`--package=file:${tarball}`, 'dlx', 'kit'], { cwd: empty, encoding: 'utf8' })
    expect(`${out.stdout}${out.stderr}`).toContain('kit init --stack next')
  }, 300_000)
})
