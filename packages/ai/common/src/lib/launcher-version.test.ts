// Every launcher is installed under <HOME>/.claude/skills/aspira-<name>/ and run with a temp HOME and a
// working directory inside a project (a folder holding aspira.json). It resolves the project from the
// working directory, runs only the global kit (`kit package-dir`, or the AGENT_DIR kit-development
// override), and checks its own `.kit-version` against that kit: a pin the kit's self-heal just rewrote
// stops the run with `skills were updated to <version>; run the command again` (T40), a pin that stays
// different blocks it and names `kit update`, never `kit init` (T41), and a project's own node_modules
// copy of @aspiralabs/ai is never run (T44). Expected strings are copied from the spec (F5, F11, F12, F20).
import { execFileSync, spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')

type Launcher = {
  /** The agent name: matches scripts/<name>.sh, the SKILL.md folder aspira-<name> and the folder <name> inside @aspiralabs/ai. */
  name: string
  /** The env var a launcher's resolve_agent reads for a kit-development override. */
  envVar: string
  /** The skill folder, relative to the repo root, that ships scripts/<name>.sh and SKILL.md. */
  skillDir: string
  /** The `local` subcommand's own arguments (every launcher's `local` ends in `scripts/local.ts`). */
  args: string[]
}

// The eight launchers kit installs (packages/kit/src/skills.ts AGENTS), each with its own `local`.
const LAUNCHERS: Launcher[] = [
  { name: 'groomer', envVar: 'GROOMER_AGENT_DIR', skillDir: 'packages/ai/groomer/skill/aspira-groomer', args: ['local', 'KIT-2'] },
  { name: 'spec-writer', envVar: 'SPEC_WRITER_AGENT_DIR', skillDir: 'packages/ai/spec-writer/skill/aspira-spec-writer', args: ['local', 'KIT-2'] },
  { name: 'planner', envVar: 'PLANNER_AGENT_DIR', skillDir: 'packages/ai/planner/skill/aspira-planner', args: ['local', 'KIT-2'] },
  { name: 'implementor', envVar: 'IMPLEMENTOR_AGENT_DIR', skillDir: 'packages/ai/implementor/skill/aspira-implementor', args: ['local', 'KIT-2'] },
  { name: 'code-analyzer', envVar: 'CODE_ANALYZER_AGENT_DIR', skillDir: 'packages/ai/code-analyzer/skill/aspira-code-analyzer', args: ['local', 'KIT-2'] },
  { name: 'pr-reviewer', envVar: 'PR_REVIEWER_AGENT_DIR', skillDir: 'packages/ai/pr-reviewer/skill/aspira-pr-reviewer', args: ['local', 'KIT-2'] },
  { name: 'build-feature', envVar: 'BUILD_FEATURE_AGENT_DIR', skillDir: 'packages/ai/build-feature/skill/aspira-build-feature', args: ['local', 'KIT-2'] },
  { name: 'visual-verify', envVar: 'VISUAL_VERIFY_AGENT_DIR', skillDir: 'packages/ai/visual-verify/skill/aspira-visual-verify', args: ['local', 'KIT-2'] },
]

const AI_VERSION = '0.8.0'
const SKILL_KIT_VERSION = '0.0.1'

// A stub `scripts/local.ts`: every launcher's `local` subcommand ends by `exec`-ing node on this
// file from inside the agent package directory. It never touches Notion or GitHub: it only records
// that it ran, so a test can tell a blocked run from one that reached the agent.
const STUB_LOCAL_TS = "require('node:fs').writeFileSync('ran.marker', JSON.stringify(process.argv.slice(2)))\n"

/** A stub @aspiralabs/ai package outside any node_modules, holding a stub <agent> folder whose local.ts records a run. */
async function makeAgentPackage(parent: string, launcher: Launcher, version = AI_VERSION): Promise<{ pkg: string; agentDir: string }> {
  const pkg = join(parent, 'aspira-ai')
  const agentDir = join(pkg, launcher.name)
  await mkdir(join(agentDir, 'scripts'), { recursive: true })
  await mkdir(join(agentDir, 'skill'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@aspiralabs/ai', version }, null, 2))
  await writeFile(join(agentDir, 'scripts', 'local.ts'), STUB_LOCAL_TS)
  return { pkg, agentDir }
}

type World = {
  root: string
  home: string
  project: string
  scriptPath: string
  /** The agent folder `kit package-dir` names. */
  agentDir: string
  path: string
  versionFile: string
}

/**
 * A temp HOME holding the launcher at <HOME>/.claude/skills/aspira-<name>/ with .kit-version at
 * `skillVersion`, a project (aspira.json, git repository) as the working directory, and a `kit` on PATH
 * whose `package-dir` prints a stub package at AI_VERSION. With `heal`, `kit package-dir` first rewrites
 * the skill's .kit-version to AI_VERSION, the way the kit's self-heal does. With `withKit` false there is
 * no kit on PATH at all.
 */
async function makeWorld(launcher: Launcher, options: { heal: boolean; withKit?: boolean; skillVersion?: string }): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'launcher-version-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
  await writeFile(join(project, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/d9e768e6e79643118781b4e393d4a4a6' }))

  const skillTarget = join(home, '.claude', 'skills', `aspira-${launcher.name}`)
  await cp(join(ROOT, launcher.skillDir), skillTarget, { recursive: true })
  const versionFile = join(skillTarget, '.kit-version')
  await writeFile(versionFile, `${options.skillVersion ?? SKILL_KIT_VERSION}\n`)
  const scriptPath = join(skillTarget, 'scripts', `${launcher.name}.sh`)
  await chmod(scriptPath, 0o755)

  const { pkg, agentDir } = await makeAgentPackage(join(root, 'global'), launcher)
  const bin = join(root, 'global', 'bin')
  await mkdir(bin, { recursive: true })
  let path = (process.env.PATH ?? '').split(':').filter((dir) => dir !== '' && !existsKit(dir)).join(':')
  if (options.withKit !== false) {
    const heal = options.heal ? `printf '%s\\n' '${AI_VERSION}' > '${versionFile}'\n` : ''
    await writeFile(join(bin, 'kit'), `#!/bin/sh\nif [ "$1" = package-dir ]; then\n${heal}echo '${pkg}'\nfi\n`)
    await chmod(join(bin, 'kit'), 0o755)
    path = `${bin}:${path}`
  }
  return { root, home, project, scriptPath, agentDir, path, versionFile }
}

function existsKit(dir: string): boolean {
  return spawnSync('test', ['-e', join(dir, 'kit')]).status === 0
}

function runLauncher(world: World, launcher: Launcher, extraEnv: Record<string, string> = {}, args: string[] = launcher.args, cwd = world.project): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: world.home, USERPROFILE: world.home, PATH: world.path, ...extraEnv }
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'AI_GATEWAY_API_KEY']) delete env[key]
  if (!(launcher.envVar in extraEnv)) delete env[launcher.envVar]
  const result = spawnSync('bash', [world.scriptPath, ...args], { cwd, env, encoding: 'utf8', timeout: 15_000 })
  return { stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status }
}

async function ran(agentDir: string): Promise<boolean> {
  try {
    await access(join(agentDir, 'ran.marker'))
    return true
  } catch {
    return false
  }
}

describe.each(LAUNCHERS)('$name .kit-version vs. the global kit (T40, T41, F5, F20)', (launcher) => {
  let root: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('T40 stops after a self-heal rewrote the skill pin: skills were updated, run the command again, and the agent never runs', async () => {
    const world = await makeWorld(launcher, { heal: true })
    root = world.root
    const result = runLauncher(world, launcher)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`skills were updated to ${AI_VERSION}; run the command again`)
    expect(await ran(world.agentDir)).toBe(false)
  })

  it('T41 a pin that stays different blocks the run and names kit update, never kit init', async () => {
    const world = await makeWorld(launcher, { heal: false })
    root = world.root
    const result = runLauncher(world, launcher)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`pinned to @aspiralabs/ai ${SKILL_KIT_VERSION}`)
    expect(result.stdout).toContain(AI_VERSION)
    expect(result.stdout).toContain('kit update')
    expect(result.stdout).not.toContain('kit init')
    expect(await ran(world.agentDir)).toBe(false)
  })

  it('T41 with no kit on PATH the cannot-find message names kit update, never kit init', async () => {
    const world = await makeWorld(launcher, { heal: false, withKit: false })
    root = world.root
    const result = runLauncher(world, launcher)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain(`cannot find ${launcher.name}`)
    expect(result.stdout).toContain('kit update')
    expect(result.stdout).not.toContain('kit init')
  })

  it('a pin equal to the global kit version runs the global agent', async () => {
    const world = await makeWorld(launcher, { heal: false, skillVersion: AI_VERSION })
    root = world.root
    runLauncher(world, launcher)
    expect(await ran(world.agentDir)).toBe(true)
  })
})

describe.each(LAUNCHERS)('$name runs the global kit only (T44, F12)', (launcher) => {
  let root: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('T44 starts the global agent, not the project node_modules one, and the AGENT_DIR override wins over both', async () => {
    const world = await makeWorld(launcher, { heal: false, skillVersion: AI_VERSION })
    root = world.root
    // The project's own copy: node_modules/@aspiralabs/ai/<agent> is a symlink to a stub outside node_modules, so a launcher that took it would run it.
    const projectPackage = await makeAgentPackage(join(world.root, 'project-copy'), launcher)
    const installed = join(world.project, 'node_modules', '@aspiralabs')
    await mkdir(installed, { recursive: true })
    await symlink(projectPackage.pkg, join(installed, 'ai'))
    const override = await makeAgentPackage(join(world.root, 'override'), launcher)

    runLauncher(world, launcher)
    expect(await ran(world.agentDir)).toBe(true)
    expect(await ran(projectPackage.agentDir)).toBe(false)

    runLauncher(world, launcher, { [launcher.envVar]: override.agentDir })
    expect(await ran(override.agentDir)).toBe(true)
    expect(await ran(projectPackage.agentDir)).toBe(false)
  })
})

describe.each(LAUNCHERS)('$name stops looking for the project (REBA1.1)', (launcher) => {
  let root: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a relative --repo outside any project fails instead of walking up forever', async () => {
    root = await mkdtemp(join(tmpdir(), 'launcher-walk-'))
    const bare = join(root, 'bare')
    execFileSync('git', ['init', '-q', bare])
    const script = join(ROOT, launcher.skillDir, 'scripts', `${launcher.name}.sh`)
    for (const sub of ['local', 'start']) {
      const result = spawnSync('bash', [script, sub, 'KIT-2', '--repo', 'some/relative/dir'], { cwd: bare, env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 10_000 })
      expect(result.error, `${launcher.name} ${sub} hung`).toBeUndefined()
      expect(result.status, `${launcher.name} ${sub}`).not.toBe(0)
    }
  }, 30_000)
})
