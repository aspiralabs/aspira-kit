// The agents as a project gets them: every agent package is packed with `pnpm pack`, installed
// into a scratch project from those tarballs, `kit init` writes the skills, and the planner's
// launcher runs its --local driver from node_modules with no ASPIRA_KIT set. Needs pnpm and git;
// the agents' own dependencies are resolved online and their tarballs come from the pnpm store.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
const PACKAGES = ['common', 'spec-reviewer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'groomer', 'build-feature', 'visual-verify', 'meta']
const BOARD = 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6'
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let scratch: string
let app: string
/** What the one kit init in beforeAll logged. */
const initLines: string[] = []

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kit-install-')))
  const tarballs = join(scratch, 'tarballs')
  mkdirSync(tarballs)
  const overrides: Record<string, string> = {}
  let agentsTarball = ''
  for (const name of PACKAGES) {
    const dir = join(repo, 'packages', 'agents', name)
    const file = run('pnpm', ['pack', '--pack-destination', tarballs], dir).trim().split('\n').at(-1)!
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }
    const spec = `file:${join(tarballs, file.split('/').at(-1)!)}`
    if (manifest.name === '@aspiralabs/agents') agentsTarball = spec
    else overrides[manifest.name] = spec
  }
  // Pack the kit package itself (already built to dist), so the project installs @aspiralabs/kit
  // from a tarball too: the build-feature launcher resolves the Playbook through its own package
  // export, not a path into this checkout's packages/kit/src, and kit doctor checks the kit-owned
  // skills against the installed kit.
  const kitDir = join(repo, 'packages', 'kit')
  const kitFile = run('pnpm', ['pack', '--pack-destination', tarballs], kitDir).trim().split('\n').at(-1)!
  const kitTarball = `file:${join(tarballs, kitFile.split('/').at(-1)!)}`
  overrides['@aspiralabs/kit'] = kitTarball
  app = join(scratch, 'app')
  mkdirSync(join(app, 'app'), { recursive: true })
  writeFileSync(join(app, 'app', 'globals.css'), '@import "tailwindcss";\n')
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'scratch-app', private: true, type: 'module', devDependencies: { '@aspiralabs/agents': agentsTarball, '@aspiralabs/kit': kitTarball } }, null, 2)}\n`)
  // The meta-package's dependencies point at the tarballs, not a registry (pnpm 12 reads overrides from the workspace file),
  // and pnpm 12 wants every dependency with a build script approved; none is needed to run the agents.
  const builds = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8').replace(/^packages:[\s\S]*?\n\n/, '').replace(/patchedDependencies:[\s\S]*$/, '')
  writeFileSync(join(app, 'pnpm-workspace.yaml'), `${builds}\noverrides:\n${Object.entries(overrides).map(([name, spec]) => `  '${name}': '${spec}'\n`).join('')}`)
  run('pnpm', ['install', '--ignore-scripts', '--config.confirmModulesPurge=false'], app)
  run('git', ['init', '-q', app], scratch)
  writeAspira({ projectRoot: app, board: BOARD, dryRun: false, log: () => {} })
  // kit init's install step adds the registry packages; here it is a no-op, the tarballs are already installed.
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

describe('an installed project', () => {
  it('has every agent under node_modules and kit init writes the eight agent skills from them and the three kit-owned skills', () => {
    expect(JSON.parse(readFileSync(join(app, 'node_modules', '@aspiralabs', 'agents', 'package.json'), 'utf8'))).toMatchObject({ name: '@aspiralabs/agents' })
    const written = initLines.filter((l) => l.startsWith('write  .claude/skills/aspira-'))
    expect(written.filter((l) => AGENTS.some((agent) => l.startsWith(`write  .claude/skills/aspira-${agent} `))).length).toBe(8)
    expect(written.filter((l) => /^write {2}\.claude\/skills\/aspira-(cleanup|next|worktree) /.test(l)).length).toBe(3)
    expect(initLines.some((l) => l.startsWith('write  .claude/skills/aspira-groomer'))).toBe(true)
    const version = (JSON.parse(readFileSync(join(repo, 'packages/agents/meta/package.json'), 'utf8')) as { version: string }).version
    for (const agent of AGENTS) {
      expect(existsSync(join(skillDir(app, agent), 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir(app, agent), 'scripts', `${agent}.sh`))).toBe(true)
      expect(readFileSync(join(skillDir(app, agent), '.kit-version'), 'utf8').trim()).toBe(version)
    }
    const report: string[] = []
    doctor(app, (line) => report.push(line))
    const skillLines = report.filter((l) => l.startsWith('ok   .claude/skills/aspira-'))
    expect(skillLines.filter((l) => l.includes('matches @aspiralabs/agents')).length).toBe(8)
    expect(skillLines.filter((l) => l.includes('matches @aspiralabs/kit')).length).toBe(3)
    expect(report.some((l) => l.startsWith('@aspiralabs/agents') && l.includes(`installed ${version}`))).toBe(true)
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
    expect(blocked.agent).toMatchObject({ name: '@aspiralabs/planner', installed: true })
    expect(blocked.agent.path).toContain(`${app}/node_modules/`)
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
    expect(readdirSync(join(app, 'node_modules', '@aspiralabs'))).toContain('agents')
  })

  it('kit init installs the build-feature skill from node_modules, and its launcher resolves the next step through @aspiralabs/kit/playbook', async () => {
    const lines: string[] = []
    const path = process.env.PATH
    process.env.PATH = `${join(scratch, 'bin')}:${path}`
    try {
      await initNext({ projectRoot: app, dryRun: false, log: (line) => lines.push(line) })
    } finally {
      process.env.PATH = path
    }
    const skill = join(app, '.claude', 'skills', 'aspira-build-feature')
    expect(existsSync(join(skill, 'SKILL.md'))).toBe(true)
    const launcher = join(skill, 'scripts', 'build-feature.sh')
    expect(existsSync(launcher)).toBe(true)
    const version = (JSON.parse(readFileSync(join(repo, 'packages/agents/meta/package.json'), 'utf8')) as { version: string }).version
    expect(readFileSync(join(skill, VERSION_FILE), 'utf8').trim()).toBe(version)
    // pnpm does not hoist a transitive dependency: the package is installed under node_modules/.pnpm,
    // reached through @aspiralabs/agents, which is where kit init and the launcher find it.
    const installed = spawnSync('find', [join(app, 'node_modules'), '-path', '*/@aspiralabs/build-feature/package.json', '-not', '-path', '*/node_modules/*/node_modules/*/node_modules/*'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    expect(installed.length, 'the build-feature package is installed under node_modules').toBeGreaterThan(0)
    const packageDir = dirname(installed[0]!)

    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ['NOTION_TOKEN', 'NOTION_API_KEY']) delete env[name]
    // The installed launcher runs the installed driver: the invocation is the run-start approval (KIT-20), so its first stage is resolve.
    const first = spawnSync('bash', [launcher, 'local', 'DEMO-1', '--local'], { cwd: app, env, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    expect(first.stderr).not.toContain('running kit source')
    expect((JSON.parse(first.stdout.slice(first.stdout.indexOf('{'))) as { stage: string }).stage).toBe('resolve')
    // The step for a Status comes from the installed @aspiralabs/kit/playbook export the driver imports.
    const script = "const { nextStep, commandFor } = await import('@aspiralabs/kit/playbook'); process.stdout.write(commandFor(nextStep('Ready: Idea'), 'DEMO-1') ?? '')"
    const step = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDir, env, encoding: 'utf8' })
    expect(step.status, step.stderr).toBe(0)
    expect(step.stdout).toBe('/aspira-spec-writer DEMO-1')
  })
})
