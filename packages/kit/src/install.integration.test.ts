// The agents as a project gets them: every agent package is packed with `pnpm pack`, installed
// into a scratch project from those tarballs, `kit init` writes the skills, and the planner's
// launcher runs its --local driver from node_modules with no ASPIRA_KIT set. Needs pnpm and git;
// the agents' own dependencies are resolved online and their tarballs come from the pnpm store.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { doctor } from './doctor.js'
import { AGENTS, skillDir } from './skills.js'
import { initNext } from './stacks/next.js'

const kit = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(dirname(kit))
const PACKAGES = ['common', 'spec-reviewer', 'spec-writer', 'planner', 'implementor', 'code-analyzer', 'pr-reviewer', 'meta']
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let scratch: string
let app: string

beforeAll(() => {
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
  app = join(scratch, 'app')
  mkdirSync(join(app, 'app'), { recursive: true })
  writeFileSync(join(app, 'app', 'globals.css'), '@import "tailwindcss";\n')
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'scratch-app', private: true, type: 'module', devDependencies: { '@aspiralabs/agents': agentsTarball } }, null, 2)}\n`)
  // The meta-package's dependencies point at the tarballs, not a registry (pnpm 12 reads overrides from the workspace file),
  // and pnpm 12 wants every dependency with a build script approved; none is needed to run the agents.
  const builds = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8').replace(/^packages:[\s\S]*?\n\n/, '').replace(/patchedDependencies:[\s\S]*$/, '')
  writeFileSync(join(app, 'pnpm-workspace.yaml'), `${builds}\noverrides:\n${Object.entries(overrides).map(([name, spec]) => `  '${name}': '${spec}'\n`).join('')}`)
  run('pnpm', ['install', '--ignore-scripts', '--config.confirmModulesPurge=false'], app)
  run('git', ['init', '-q', app], scratch)
})

describe('an installed project', () => {
  it('has every agent under node_modules and kit init writes the six skills from them', async () => {
    expect(JSON.parse(readFileSync(join(app, 'node_modules', '@aspiralabs', 'agents', 'package.json'), 'utf8'))).toMatchObject({ name: '@aspiralabs/agents' })
    // kit init's install step adds the registry packages; here it is a no-op, the tarballs are already installed.
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\n[ "$1" = add ] && exit 0\nexec /usr/bin/env pnpm "$@"\n', { mode: 0o755 })
    const lines: string[] = []
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      await initNext({ projectRoot: app, dryRun: false, log: (line) => lines.push(line) })
    } finally {
      process.env.PATH = path
    }
    expect(lines.filter((l) => l.startsWith('write  .claude/skills/aspira-')).length).toBe(6)
    const version = (JSON.parse(readFileSync(join(repo, 'packages/agents/meta/package.json'), 'utf8')) as { version: string }).version
    for (const agent of AGENTS) {
      expect(existsSync(join(skillDir(app, agent), 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir(app, agent), 'scripts', `${agent}.sh`))).toBe(true)
      expect(readFileSync(join(skillDir(app, agent), '.kit-version'), 'utf8').trim()).toBe(version)
    }
    const report: string[] = []
    doctor(app, (line) => report.push(line))
    expect(report.filter((l) => l.startsWith('ok   .claude/skills/aspira-')).length).toBe(6)
    expect(report.some((l) => l.startsWith('@aspiralabs/agents') && l.includes(`installed ${version}`))).toBe(true)
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
    const env: NodeJS.ProcessEnv = { ...process.env, KNOWLEDGE_PAGE: 'https://app.notion.com/p/11111111111111111111111111111111' }
    for (const name of ['ASPIRA_KIT', 'PLANNER_AGENT_DIR', 'SPEC_TO_PLAN_AGENT_DIR']) delete env[name]
    const out = join(scratch, 'plan.review')
    // Without a snapshot, the first stage is knowledge: the pages the agent's configuration loads.
    const first = spawnSync('bash', [launcher, 'local', spec, '--output', out], { cwd: app, env, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    expect(first.stderr).not.toContain('kit source')
    const knowledge = JSON.parse(first.stdout) as { stage: string; agent: { name: string; path: string; installed: boolean }; instructions: string }
    expect(knowledge.stage).toBe('knowledge')
    expect(knowledge.agent).toMatchObject({ name: '@aspiralabs/planner', installed: true })
    expect(knowledge.agent.path).toContain(`${app}/node_modules/`)
    expect(knowledge.instructions).toContain('/node_modules/')
    // With a snapshot the knowledge is satisfied and the next stage is research: the whole runtime loaded from node_modules.
    const guidelines = join(scratch, 'REQUIRED.md')
    writeFileSync(guidelines, 'REV-001 Inspect source evidence\n')
    const second = spawnSync('bash', [launcher, 'local', spec, '--output', out, '--guidelines', guidelines], { cwd: app, env, encoding: 'utf8' })
    expect(second.status, second.stderr).toBe(0)
    const research = JSON.parse(second.stdout) as { stage: string; tasks: { prompt: string }[] }
    expect(research.stage).toBe('research')
    expect(readFileSync(research.tasks[0]!.prompt, 'utf8')).toContain('REV-001')
    // The launcher runs from the installed package, not a checkout, even with a stale ASPIRA_KIT exported.
    const stale = spawnSync('bash', [launcher, 'local', spec, '--output', out, '--guidelines', guidelines], { cwd: app, env: { ...env, ASPIRA_KIT: join(scratch, 'nowhere') }, encoding: 'utf8' })
    expect(stale.status, stale.stderr).toBe(0)
    expect(readdirSync(join(app, 'node_modules', '@aspiralabs'))).toContain('agents')
  })
})
